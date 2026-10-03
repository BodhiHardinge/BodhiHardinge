"""Fetch ground points from a USGS EPT lidar dataset inside a lon/lat box and grid them at 1 m."""
import sys, math, json, io, requests, numpy as np, laspy
from concurrent.futures import ThreadPoolExecutor
name, lon0, lat0, lon1, lat1, maxdepth, out = sys.argv[1], *map(float, sys.argv[2:6]), int(sys.argv[6]), sys.argv[7]
base = f'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{name}'
meta = requests.get(f'{base}/ept.json', timeout=30).json()
def merc(lon, lat): return lon * 20037508.342789244 / 180, math.log(math.tan((90 + lat) * math.pi / 360)) * 6378137
X0, Y0 = merc(lon0, lat0); X1, Y1 = merc(lon1, lat1)
b = meta['bounds']
def node_bounds(d, x, y, z):
    s = (b[3] - b[0]) / 2 ** d
    return b[0] + x * s, b[1] + y * s, b[0] + (x + 1) * s, b[1] + (y + 1) * s
hier = {}
def hits(k):
    d, x, y, z = map(int, k.split('-'))
    nx0, ny0, nx1, ny1 = node_bounds(d, x, y, z)
    return not (nx1 < X0 or nx0 > X1 or ny1 < Y0 or ny0 > Y1)
def get_json(url):
    for attempt in range(6):
        try: return requests.get(url, timeout=60).json()
        except Exception as e: err = e
    raise err
def load_hier(key):
    h = get_json(f'{base}/ept-hierarchy/{key}.json')
    for k, v in h.items():
        if not hits(k): continue
        if v == -1: load_hier(k)
        else: hier[k] = v
load_hier('0-0-0-0')
print('hierarchy nodes in box', len(hier), flush=True)
keys = []
for k, v in hier.items():
    d, x, y, z = map(int, k.split('-'))
    if d > maxdepth or v == 0: continue
    nx0, ny0, nx1, ny1 = node_bounds(d, x, y, z)
    if nx1 < X0 or nx0 > X1 or ny1 < Y0 or ny0 > Y1: continue
    keys.append(k)
print('nodes', len(keys), 'points', sum(hier[k] for k in keys))
def fetch(k):
    for attempt in range(4):
        try:
            r = requests.get(f'{base}/ept-data/{k}.laz', timeout=120); r.raise_for_status()
            las = laspy.read(io.BytesIO(r.content))
            m = (las.classification == 2) & (las.x >= X0) & (las.x <= X1) & (las.y >= Y0) & (las.y <= Y1)
            return np.column_stack([las.x[m], las.y[m], las.z[m]])
        except Exception as e:
            err = e
    print('failed', k, err); return np.zeros((0, 3))
with ThreadPoolExecutor(16) as ex: parts = list(ex.map(fetch, keys))
pts = np.concatenate(parts)
print('ground points', len(pts))
# Local metres: mercator scale factor at the box centre.
latc = (lat0 + lat1) / 2; k = math.cos(math.radians(latc))
ex_ = (pts[:, 0] - X0) * k; ny_ = (pts[:, 1] - Y0) * k
W = int(math.ceil((X1 - X0) * k)); H = int(math.ceil((Y1 - Y0) * k))
ix = np.clip(ex_.astype(int), 0, W - 1); iy = np.clip(ny_.astype(int), 0, H - 1)
s = np.zeros((H, W)); c = np.zeros((H, W))
np.add.at(s, (iy, ix), pts[:, 2]); np.add.at(c, (iy, ix), 1)
grid = np.where(c > 0, s / np.maximum(c, 1), np.nan)
print('grid', W, H, 'filled', np.isfinite(grid).mean())
np.savez_compressed(out, grid=grid, count=c, lon0=lon0, lat0=lat0, lon1=lon1, lat1=lat1)
