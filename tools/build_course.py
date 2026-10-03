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
card = cfg.get('card_lengths')
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
    cand.append(dict(hi=hi, tees=tee_pts, path=line, length=length, par3=par3, synthetic=hi in synthetic))

n = len(cand)
print('candidates', [(c['hi'], 'p3' if c['par3'] else '', round(c['length']), 'S' if c['synthetic'] else '') for c in cand])
want = len(pars)
start_xy = [np.array(c['tees'][0].coords[0]) for c in cand]
end_xy = [np.array(c['path'].coords[-1]) for c in cand]
walk = np.array([[np.linalg.norm(end_xy[i] - start_xy[j]) for j in range(n)] for i in range(n)])
# DP over (visited set, last hole). Disagreeing with the card's par 3s costs as much as a long walk; so does a
# length far from the card's (stand-in tees can still move back, so they are only charged for being too long).
MISMATCH = cfg.get('par_mismatch_cost', 600)
def fit_cost(c, k):
    cost = 0.0 if c['par3'] == (pars[k] == 3) else MISMATCH
    if card:
        diff = c['length'] - card[k]
        if c['synthetic']: cost += 2 * max(0, diff - 40)
        else: cost += 2 * max(0, abs(diff) - 40)
    return cost
layer = {}
for i, c in enumerate(cand):
    layer[(1 << i, i)] = (fit_cost(c, 0), None)
layers = [layer]
for k in range(1, want):
    nxt = {}
    for (mask, last), (cost, _) in layers[-1].items():
        for j, c in enumerate(cand):
            if mask >> j & 1: continue
            key = (mask | 1 << j, j)
            v = cost + walk[last, j] + fit_cost(c, k)
            if key not in nxt or v < nxt[key][0]: nxt[key] = (v, (mask, last))
    # Keep the search small: the cheapest partial routes.
    layers.append(dict(sorted(nxt.items(), key=lambda kv: kv[1][0])[:30000]))
if not layers[-1]: sys.exit('no routing found')
key = min(layers[-1], key=lambda k: layers[-1][k][0])
cost = layers[-1][key][0]
order = []
for k in range(want - 1, -1, -1):
    order.append(key[1])
    key = layers[k][key][1]
order.reverse()
print('route cost', round(cost), 'order', order)

# Stand-in tees move back along the line of the hole until the hole plays its card length, staying on the course.
if card:
    for k, ci in enumerate(order):
        c = cand[ci]
        if not c['synthetic'] or c['length'] >= card[k] - 5: continue
        coords = list(c['path'].coords)
        a, b = np.array(coords[0]), np.array(coords[1])
        u = (a - b) / (np.linalg.norm(a - b) or 1)
        need = card[k] - c['length']
        step = 0
        while step < need and course_poly.buffer(-8).contains(Point(*(a + u * (step + 5)))): step += 5
        new = a + u * step
        c['tees'] = [Point(*new)] + c['tees']
        c['path'] = LineString([tuple(new)] + coords[1:])
        c['length'] = c['path'].length

# ---------------------------------------------------------------- Rasters
x0, y0, x1, y1 = course_poly.buffer(cfg.get('margin', 60)).bounds
x0, y0 = max(0, int(x0)), max(0, int(y0)); x1, y1 = min(W, int(x1)), min(H, int(y1))
w, h = x1 - x0, y1 - y0
# World coordinates: x east from the west edge, z south from the north edge, metres. Height cell (row r, col i)
# covers x in [i, i+1) and z in [r, r+1).
def wx(x): return x - x0
def wz(y): return y1 - y

SURF = {'out': 0, 'thick': 1, 'rough': 2, 'fairway': 3, 'fringe': 4, 'green': 5, 'tee': 6, 'sand': 7, 'water': 8}
SCALE = cfg.get('surface_scale', 2)  # pixels per metre in the physics raster
rough_area = unary_union([*fairways, *greens, *[t for g in tee_groups for t in g]]).buffer(cfg.get('rough_width', 22)).intersection(course_poly.buffer(10))
all_tees = [t for g in tee_groups for t in g]
layers_out = [
    ('thick', [course_poly]), ('rough', [rough_area]), ('fairway', fairways), ('tee', all_tees),
    ('fringe', [g.buffer(1.5) for g in greens]), ('green', greens), ('sand', bunkers), ('water', water),
]
def raster(scale):
    img = Image.new('L', (w * scale, h * scale), SURF['out'])
    draw = ImageDraw.Draw(img)
    for name, geoms in layers_out:
        for geom in geoms:
            for poly in getattr(geom, 'geoms', [geom]):
                if poly.geom_type != 'Polygon' or poly.is_empty: continue
                draw.polygon([(wx(x) * scale, wz(y) * scale) for x, y in poly.exterior.coords], fill=SURF[name])
                for ring in poly.interiors:
                    draw.polygon([(wx(x) * scale, wz(y) * scale) for x, y in ring.coords], fill=SURF['rough'] if name == 'fairway' else SURF['thick'])
    return img
raster(SCALE).save(cfg['out'] + '/surfaces.png', optimize=True)
green_mask = np.asarray(raster(1)) >= SURF['fringe']
green_mask &= np.isin(np.asarray(raster(1)), [SURF['fringe'], SURF['green']])

heights = grid[y0:y1, x0:x1][::-1]  # north-up rows
counts = dem['count'][y0:y1, x0:x1][::-1] if 'count' in dem.files else np.isfinite(heights).astype(float)
mask = np.isfinite(heights)
idx = ndimage.distance_transform_edt(~mask, return_distances=False, return_indices=True)
filled = heights[tuple(idx)]
filled = np.where(mask, filled, ndimage.gaussian_filter(filled, 3))
base = ndimage.gaussian_filter(filled, cfg['smooth']) if cfg.get('smooth') else filled

sys.path.insert(0, __import__('os').path.dirname(__file__))
from terrain_fit import local_quadratic, blend, planar_greens
labels, count_labels = ndimage.label(ndimage.binary_dilation(green_mask, iterations=4))
fitted = base.copy()
if cfg.get('green_fit') == 'quadratic':
    sigma = cfg.get('green_sigma', 1.8)
    r = int(np.ceil(3 * sigma)) + 2
    for k, sl in enumerate(ndimage.find_objects(labels), start=1):
        rs = slice(max(0, sl[0].start - r), min(h, sl[0].stop + r))
        cs = slice(max(0, sl[1].start - r), min(w, sl[1].stop + r))
        local = local_quadratic(filled[rs, cs], np.where(mask[rs, cs], counts[rs, cs], 0.05), sigma)
        m = labels[rs, cs] == k
        fitted[rs, cs][m] = local[m]
    final = blend(base, fitted, labels > 0, 3)
elif cfg.get('green_fit') == 'planar':
    flat = planar_greens(base, ndimage.label(green_mask)[0], cfg.get('green_max_slope', 0.02))
    final = blend(base, flat, green_mask, cfg.get('green_blend', 8))
else:
    final = base
gy_, gx_ = np.gradient(final)
sl = np.hypot(gx_, gy_)[green_mask & (np.asarray(raster(1)) == SURF['green'])] * 100
print('green slopes: median %.1f%%, p90 %.1f%%, p99 %.1f%%, over 7%%: %.1f%% of green' % (np.median(sl), np.percentile(sl, 90), np.percentile(sl, 99), (sl > 7).mean() * 100))
v = final + 32768
rr = np.floor(v / 256); gch = np.floor(v - rr * 256); bb = np.round((v - rr * 256 - gch) * 256)
gch = gch + (bb >= 256); bb = np.where(bb >= 256, 0, bb)
Image.fromarray(np.dstack([rr, gch, bb]).astype(np.uint8), 'RGB').save(cfg['out'] + '/heights.png', optimize=True)

# ---------------------------------------------------------------- Course file (world: x east, z south, metres)
def world(p): return [round(wx(p[0]), 2), round(wz(p[1]), 2)]
def rings(geom, tol=0.15):
    out = []
    for poly in getattr(geom, 'geoms', [geom]):
        if poly.geom_type != 'Polygon' or poly.is_empty: continue
        poly = poly.simplify(tol)
        out.append([[[round(wx(x), 2), round(wz(y), 2)] for x, y in ring.coords] for ring in [poly.exterior, *poly.interiors]])
    return out
def pin_for(g, k):
    """A cup position on the green: kept 4 m from the edge, on ground no steeper than 2.5% (as greenkeepers do)."""
    inner = g.buffer(-4)
    if inner.is_empty: inner = g.buffer(-1.5)
    c = inner.centroid
    bx0, by0, bx1, by1 = inner.bounds
    best, best_slope = c, 1e9
    rng = np.random.default_rng(k)
    for _ in range(300):
        p = Point(rng.uniform(bx0, bx1), rng.uniform(by0, by1))
        if not inner.contains(p): continue
        col, row = int(wx(p.x)), int(wz(p.y))
        if not (1 <= row < h - 1 and 1 <= col < w - 1): continue
        sx = (final[row, col + 1] - final[row, col - 1]) / 2
        sy = (final[row + 1, col] - final[row - 1, col]) / 2
        slope = math.hypot(sx, sy)
        # Prefer gentle ground, then variety: a different part of the green on each hole.
        score = max(0, slope - 0.025) * 1000 + (0 if slope <= 0.025 else 1) + rng.uniform(0, 0.5)
        if score < best_slope: best, best_slope = p, score
    return best
out_holes = []
for num, ci in enumerate(order, start=1):
    c = cand[ci]
    g = holes[c['hi']]['green']
    # Where the map's hole plainly disagrees with the card (a 140 m "par 4"), trust the map and say so.
    par = pars[num - 1]
    par_from_map = False
    if c['length'] < cfg.get('par3_max', 230) and par != 3: par, par_from_map = 3, True
    out_holes.append(dict(
        number=num, par=par, parFromMap=par_from_map, length=round(c['length'], 1),
        tees=[world(t.coords[0]) for t in c['tees']],
        path=[world(p) for p in c['path'].coords],
        pin=world(pin_for(g, num).coords[0]),
        green=[world(p) for p in g.simplify(0.15).exterior.coords],
        standInTee=bool(c['synthetic']),
    ))
feature_out = {
    'boundary': rings(course_poly, 0.5),
    'rough': rings(rough_area, 0.5),
    'fairway': [r for f in fairways for r in rings(f)],
    'tee': [r for t in all_tees for r in rings(t)],
    'green': [r for g in greens for r in rings(g)],
    'sand': [r for b in bunkers for r in rings(b)],
    'water': [r for wt in water for r in rings(wt)],
}
course = dict(
    name=cfg['display_name'], location=cfg['location'], note=cfg['note'],
    size=[w, h], surfaceScale=SCALE,
    heightSource=cfg['height_source'], shapeSource='OpenStreetMap contributors via Overture Maps (ODbL)',
    surfaces=list(SURF.keys()), holes=out_holes, features=feature_out,
)
json.dump(course, open(cfg['out'] + '/course.json', 'w'), separators=(',', ':'))
for hl in out_holes: print(hl['number'], hl['par'], round(hl['length']), 'm', '(stand-in tee)' if hl['standInTee'] else '')
print('total', round(sum(hl['length'] for hl in out_holes)), 'm; raster', w, 'x', h)
