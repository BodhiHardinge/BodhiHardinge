"""Mosaic Terrarium tiles over a lon/lat box and resample to the same 1 m grid format as ept.py."""
import sys, math, io, requests, numpy as np
from PIL import Image
from scipy import ndimage
lon0, lat0, lon1, lat1, z, out = *map(float, sys.argv[1:5]), int(sys.argv[5]), sys.argv[6]
z = int(z)
def tile(lon, lat):
    n = 2 ** z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
tx0, ty1 = tile(lon0, lat0); tx1, ty0 = tile(lon1, lat1)
xs = range(int(tx0), int(tx1) + 1); ys = range(int(ty0), int(ty1) + 1)
mosaic = np.zeros((len(ys) * 256, len(xs) * 256))
for j, y in enumerate(ys):
    for i, x in enumerate(xs):
        a = np.asarray(Image.open(io.BytesIO(requests.get(f'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png', timeout=30).content)).convert('RGB')).astype(float)
        mosaic[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
R = 6378137.0
latc = (lat0 + lat1) / 2; K = math.cos(math.radians(latc))
def merc_y(lat): return math.log(math.tan((90 + lat) * math.pi / 360)) * R
W = int((lon1 - lon0) * math.pi / 180 * R * K); H = int((merc_y(lat1) - merc_y(lat0)) * K)
X = np.arange(W) + 0.5; Y = np.arange(H) + 0.5
lon = lon0 + X / (math.pi / 180 * R * K)
lat = np.degrees(2 * np.arctan(np.exp((merc_y(lat0) + Y / K) / R)) - math.pi / 2)
px = (np.array([tile(l, latc)[0] for l in lon]) - xs[0]) * 256 - 0.5
py = (np.array([tile(lon0, l)[1] for l in lat]) - ys[0]) * 256 - 0.5
PX, PY = np.meshgrid(px, py)
grid = ndimage.map_coordinates(mosaic, [PY, PX], order=3)
np.savez_compressed(out, grid=grid, count=np.ones_like(grid), lon0=lon0, lat0=lat0, lon1=lon1, lat1=lat1)
print('grid', W, H, grid.min(), grid.max())
