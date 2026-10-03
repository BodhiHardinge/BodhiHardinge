"""
Builds a playable course file from open data.

Inputs: Overture Maps golf polygons (from OpenStreetMap) and a 1 m ground height grid (USGS lidar, or a coarser
DEM where no lidar is open). Output: course.json (holes, tees, pins, paths) plus heights.png (Terrarium encoded,
1 px = 1 m) and surfaces.png (one palette index per square metre), all north-up.

Usage: python tools/build_course.py config.json
"""
import json, math, sys
import numpy as np
import networkx as nx
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely import wkt
from shapely.geometry import LineString, MultiPoint, Point, Polygon
from shapely.ops import unary_union, voronoi_diagram

cfg = json.load(open(sys.argv[1]))
features = json.load(open(cfg['features']))
dem = np.load(cfg['dem'])
grid = dem['grid']
lon0, lat0 = float(dem['lon0']), float(dem['lat0'])
H, W = grid.shape
latc = (lat0 + float(dem['lat1'])) / 2
K = math.cos(math.radians(latc))
R = 6378137.0

def merc_y(lat): return math.log(math.tan((90 + lat) * math.pi / 360)) * R

def to_grid(lon, lat):
    """Lon/lat to grid metres: X east from the west edge, Y north from the south edge."""
    return (lon - lon0) * math.pi / 180 * R * K, (merc_y(lat) - merc_y(lat0)) * K

def project(geom):
    from shapely.ops import transform
    return transform(lambda x, y, z=None: tuple(zip(*[to_grid(a, b) for a, b in zip(np.atleast_1d(x), np.atleast_1d(y))])), geom)

course_poly = project([wkt.loads(f['wkt']) for f in features if f['name'] == cfg['course_name']][0])
inside = course_poly.buffer(25)

def polys(cls):
    out = []
    for f in features:
        if f['cls'] != cls: continue
        g = project(wkt.loads(f['wkt']))
        for p in getattr(g, 'geoms', [g]):
            if p.geom_type == 'Polygon' and p.centroid.within(inside): out.append(p.buffer(0))
    return out

greens, tees, fairways, bunkers = polys('green'), polys('tee'), polys('fairway'), polys('bunker')
water = polys('water_hazard')
print(f"greens {len(greens)} tees {len(tees)} fairways {len(fairways)} bunkers {len(bunkers)} water {len(water)}")

# ---------------------------------------------------------------- Tee complexes
tee_groups = []
for t in tees:
    for grp in tee_groups:
        if any(t.distance(o) < cfg.get('tee_join', 35) for o in grp):
            grp.append(t); break
    else:
        tee_groups.append([t])
# Merge groups that ended up touching.
merged = True
while merged:
    merged = False
    for i in range(len(tee_groups)):
        for j in range(i + 1, len(tee_groups)):
            if any(a.distance(b) < cfg.get('tee_join', 35) for a in tee_groups[i] for b in tee_groups[j]):
                tee_groups[i] += tee_groups.pop(j); merged = True; break
        if merged: break
print('tee complexes', len(tee_groups))

# ---------------------------------------------------------------- Fairway centrelines (medial axis)
def centreline(poly):
    boundary = poly.exterior
    n = max(40, int(boundary.length / 4))
    pts = MultiPoint([boundary.interpolate(i / n, normalized=True) for i in range(n)])
    shrunk = poly.buffer(-0.5)
    G = nx.Graph()
    for cell in voronoi_diagram(pts, edges=True).geoms:
        for seg in getattr(cell, 'geoms', [cell]):
            cs = list(seg.coords)
            for a, b in zip(cs, cs[1:]):
                if shrunk.contains(Point(a)) and shrunk.contains(Point(b)):
                    G.add_edge(a, b, weight=math.dist(a, b))
    if G.number_of_nodes() < 2:
        r = poly.minimum_rotated_rectangle.exterior.coords
        return LineString([r[0], r[2]])
    comp = G.subgraph(max(nx.connected_components(G), key=len))
    a = next(iter(comp.nodes))
    far = nx.single_source_dijkstra_path_length(comp, a)
    b = max(far, key=far.get)
    far = nx.single_source_dijkstra_path_length(comp, b)
    c = max(far, key=far.get)
    return LineString(nx.dijkstra_path(comp, b, c)).simplify(6)

# ---------------------------------------------------------------- Holes: green + tee complex (+ fairways)
def tee_point(grp): return unary_union(grp).centroid
holes = []
used_tees = set()
fair_lines = [(f, centreline(f)) for f in fairways]
for g in greens: holes.append(dict(green=g, fairways=[]))
# Each fairway belongs to the green nearest one of its ends, oriented tee -> green.
for f, line in fair_lines:
    ends = [Point(line.coords[0]), Point(line.coords[-1])]
    best = min(((e.distance(h['green']), hi, k) for hi, h in enumerate(holes) for k, e in enumerate(ends)))
    gap, hi, k = best
    if gap > cfg.get('fairway_green_gap', 70): continue
    if k == 0: line = LineString(list(line.coords)[::-1])
    holes[hi]['fairways'].append((f, line))

def hole_score(h, grp):
    """How well a tee complex fits a green. Lower is better; None means it cannot be this hole's tee."""
    tp = tee_point(grp)
    g = h['green'].centroid
    d = tp.distance(g)
    if h['par3']:
        return abs(d - 160) / 4 if 80 < d < 250 else None
    # Fairway holes: the tee sits behind the far end of the fairway, roughly in line with it.
    line = max((l for _, l in h['fairways']), key=lambda l: Point(l.coords[0]).distance(h['green']))
    a, b = np.array(line.coords[0]), np.array(line.coords[min(2, len(line.coords) - 1)])
    start = Point(a)
    gap = tp.distance(start)
    direction = (b - a) / (np.linalg.norm(b - a) or 1)
    to_start = (a - np.array(tp.coords[0])) / (gap or 1)
    if gap > cfg.get('tee_fairway_gap', 260) or d < 180 or tp.distance(g) < start.distance(g): return None
    if gap > 40 and float(direction @ to_start) < 0.75: return None
    return gap

for h in holes:
    fair_len = sum(l.length for _, l in h['fairways'])
    h['par3'] = fair_len < cfg.get('apron_length', 90)
    if h['par3']: h['fairways'] = []

# Greedy global matching: best (score) pairs first, each tee complex and green used once.
pairs = []
for hi, h in enumerate(holes):
    for ti, grp in enumerate(tee_groups):
        s = hole_score(h, grp)
        if s is not None: pairs.append((s, hi, ti))
pairs.sort()
hole_tee, tee_used = {}, set()
for s, hi, ti in pairs:
    if hi in hole_tee or ti in tee_used: continue
    hole_tee[hi] = ti; tee_used.add(ti)

# Where the map has a fairway but no tee for it, put a stand-in tee just behind the fairway's far end.
synthetic = {}
if cfg.get('synthesize_tees'):
    for hi, h in enumerate(holes):
        if hi in hole_tee or h['par3'] or not h['fairways']: continue
        line = max((l for _, l in h['fairways']), key=lambda l: Point(l.coords[0]).distance(h['green']))
        a, b = np.array(line.coords[0]), np.array(line.coords[min(1, len(line.coords) - 1)])
        u = (b - a) / (np.linalg.norm(b - a) or 1)
        t = Point(*(a - u * 30)).buffer(4)
        tee_groups.append([t]); hole_tee[hi] = len(tee_groups) - 1; tee_used.add(hole_tee[hi]); synthetic[hi] = True
    print('stand-in tees', len(synthetic))
matched = [hi for hi in range(len(holes)) if hi in hole_tee]
# Leftover tee complexes are usually a hole's back or forward tees, set apart from its main tee.
extra = {hi: [] for hi in hole_tee}
for ti, grp in enumerate(tee_groups):
    if ti in tee_used: continue
    tp = tee_point(grp)
    best = None
    for hi, mt in hole_tee.items():
        main = tee_point(tee_groups[mt]); g = holes[hi]['green'].centroid
        u = np.array(g.coords[0]) - np.array(main.coords[0]); u /= np.linalg.norm(u)
        v = np.array(tp.coords[0]) - np.array(main.coords[0])
        along, across = float(v @ u), abs(float(v[0] * u[1] - v[1] * u[0]))
        if across < 30 and -150 < along < 120 and (best is None or abs(along) < best[0]): best = (abs(along), hi)
    if best: extra[best[1]].append(ti)

print('greens matched to tees', len(matched), 'of', len(holes))

if cfg.get('debug'):
    dimg = Image.new('RGB', (W, H), (40, 40, 40)); dd = ImageDraw.Draw(dimg)
    fl = lambda p: [(x, H - 1 - y) for x, y in p]
    for f in fairways: dd.polygon(fl(f.exterior.coords), outline=(90, 200, 90))
    for g in greens: dd.polygon(fl(g.exterior.coords), fill=(0, 160, 0))
    for i, grp in enumerate(tee_groups):
        for t in grp: dd.polygon(fl(t.exterior.coords), fill=(80, 80, 255))
        c = tee_point(grp); dd.text((c.x + 6, H - 1 - c.y), str(i), fill=(255, 255, 255))
    for _, line in fair_lines: dd.line(fl(line.coords), fill=(255, 255, 0), width=2)
    for hi, ti in hole_tee.items():
        a = tee_point(tee_groups[ti]); b = holes[hi]['green'].centroid
        dd.line(fl([(a.x, a.y), (b.x, b.y)]), fill=(255, 80, 80), width=1)
    for hi, h in enumerate(holes):
        c = h['green'].centroid; dd.text((c.x + 8, H - 1 - c.y), f'G{hi}', fill=(255, 220, 120))
    dimg.save(cfg['debug'])

# ---------------------------------------------------------------- Routing order with the scorecard's par 3s
pars = cfg['pars']
cand = []
for hi in matched:
    h = holes[hi]
    grp = tee_groups[hole_tee[hi]] + [t for ti in extra[hi] for t in tee_groups[ti]]
    g = h['green']
    # Back tee: the tee polygon farthest from the green.
    tee_pts = sorted((t.centroid for t in grp), key=lambda p: -p.distance(g.centroid))
    path = [tee_pts[0]]
    for _, line in sorted(h['fairways'], key=lambda fl: -Point(fl[1].coords[-1]).distance(g)):
        for c in line.coords:
            p = Point(c)
            if p.distance(g.centroid) < path[-1].distance(g.centroid) - 15: path.append(p)
    path.append(g.centroid)
    line = LineString(path).simplify(8)
    length = line.length
    par3 = h['par3'] or length < cfg.get('par3_max', 230)
    cand.append(dict(hi=hi, tees=tee_pts, path=line, length=length, par3=par3))

n = len(cand)
print('candidates', [(c['hi'], 'p3' if c['par3'] else '', round(c['length'])) for c in cand])
want = len(pars)
start_xy = [np.array(c['tees'][0].coords[0]) for c in cand]
end_xy = [np.array(c['path'].coords[-1]) for c in cand]
walk = np.array([[np.linalg.norm(end_xy[i] - start_xy[j]) for j in range(n)] for i in range(n)])
# DP over (visited set, last hole); position k must match the scorecard's par-3-ness.
# A hole whose shape disagrees with the card's par 3s costs as much as a long walk, so the card wins when it can.
MISMATCH = cfg.get('par_mismatch_cost', 600)
layer = {}
for i, c in enumerate(cand):
    layer[(1 << i, i)] = (0.0 if c['par3'] == (pars[0] == 3) else MISMATCH, None)
layers = [layer]
for k in range(1, want):
    nxt = {}
    for (mask, last), (cost, _) in layers[-1].items():
        for j, c in enumerate(cand):
            if mask >> j & 1: continue
            key = (mask | 1 << j, j)
            v = cost + walk[last, j] + (0 if c['par3'] == (pars[k] == 3) else MISMATCH)
            if key not in nxt or v < nxt[key][0]: nxt[key] = (v, (mask, last))
    # Keep the search small: the cheapest partial routes.
    layers.append(dict(sorted(nxt.items(), key=lambda kv: kv[1][0])[:30000]))
if not layers[-1]: sys.exit('no routing matches the scorecard par 3s')
key = min(layers[-1], key=lambda k: layers[-1][k][0])
cost = layers[-1][key][0]
order = []
for k in range(want - 1, -1, -1):
    order.append(key[1])
    key = layers[k][key][1]
order.reverse()
print('route walking total m', round(cost), 'order', order)

# ---------------------------------------------------------------- Rasters
x0, y0, x1, y1 = course_poly.buffer(cfg.get('margin', 60)).bounds
x0, y0 = max(0, int(x0)), max(0, int(y0)); x1, y1 = min(W, int(x1)), min(H, int(y1))
w, h = x1 - x0, y1 - y0

SURF = {'out': 0, 'thick': 1, 'rough': 2, 'fairway': 3, 'fringe': 4, 'green': 5, 'tee': 6, 'sand': 7, 'water': 8}
img = Image.new('L', (w, h), SURF['out'])
draw = ImageDraw.Draw(img)
def paint(geom, code):
    for p in getattr(geom, 'geoms', [geom]):
        if p.geom_type != 'Polygon' or p.is_empty: continue
        # Image rows run north to south.
        draw.polygon([(x - x0, (y1 - 1) - y) for x, y in p.exterior.coords], fill=code)
        for hole in p.interiors:
            draw.polygon([(x - x0, (y1 - 1) - y) for x, y in hole.coords], fill=SURF['rough'])
paint(course_poly, SURF['thick'])
paint(unary_union([*fairways, *greens, *[t for g in tee_groups for t in g]]).buffer(cfg.get('rough_width', 22)).intersection(course_poly.buffer(10)), SURF['rough'])
for f in fairways: paint(f, SURF['fairway'])
for g in tee_groups:
    for t in g: paint(t, SURF['tee'])
for g in greens: paint(g.buffer(1.5), SURF['fringe'])
for g in greens: paint(g, SURF['green'])
for b in bunkers: paint(b, SURF['sand'])
for wtr in water: paint(wtr, SURF['water'])
img.save(cfg['out'] + '/surfaces.png', optimize=True)

heights = grid[y0:y1, x0:x1][::-1]  # north-up rows
mask = np.isfinite(heights)
idx = ndimage.distance_transform_edt(~mask, return_distances=False, return_indices=True)
filled = heights[tuple(idx)]
filled = np.where(mask, filled, ndimage.gaussian_filter(filled, 3))
if cfg.get('smooth'): filled = ndimage.gaussian_filter(filled, cfg['smooth'])
v = filled + 32768
r = np.floor(v / 256); gch = np.floor(v - r * 256); b = np.round((v - r * 256 - gch) * 256)
gch = gch + (b >= 256); b = np.where(b >= 256, 0, b)
Image.fromarray(np.dstack([r, gch, b]).astype(np.uint8), 'RGB').save(cfg['out'] + '/heights.png', optimize=True)

# ---------------------------------------------------------------- Course file (world: x east, z south, metres)
def world(p): return [round(p[0] - x0, 2), round((y1 - 1) - p[1], 2)]
def pin_for(g, k):
    inner = g.buffer(-4)
    if inner.is_empty: inner = g.buffer(-1.5)
    c = inner.centroid
    bx0, by0, bx1, by1 = inner.bounds
    ang = k * 2.39996
    for scale in (0.35, 0.2, 0.0):
        p = Point(c.x + math.cos(ang) * (bx1 - bx0) * scale, c.y + math.sin(ang) * (by1 - by0) * scale)
        if inner.contains(p): return p
    return c
out_holes = []
for num, ci in enumerate(order, start=1):
    c = cand[ci]
    g = holes[c['hi']]['green']
    out_holes.append(dict(
        number=num, par=pars[num - 1], length=round(c['length'], 1),
        tees=[world(t.coords[0]) for t in c['tees']],
        path=[world(p) for p in c['path'].coords],
        pin=world(pin_for(g, num).coords[0]),
        green=[world(p) for p in g.exterior.coords],
    ))
course = dict(
    name=cfg['display_name'], location=cfg['location'], note=cfg['note'],
    size=[w, h], origin=dict(lon=lon0 + x0 / (math.pi / 180 * R * K), lat=None),
    heightSource=cfg['height_source'], shapeSource='OpenStreetMap contributors via Overture Maps (ODbL)',
    surfaces=list(SURF.keys()), holes=out_holes,
)
json.dump(course, open(cfg['out'] + '/course.json', 'w'), indent=1)
for hl in out_holes: print(hl['number'], hl['par'], round(hl['length']), 'm')
print('total', round(sum(hl['length'] for hl in out_holes)), 'm; raster', w, 'x', h)
