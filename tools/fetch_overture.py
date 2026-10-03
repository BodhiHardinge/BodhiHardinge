import s3fs, pyarrow.dataset as ds, pyarrow.compute as pc, json, sys, time
from shapely import wkb
from collections import Counter
fs = s3fs.S3FileSystem(anon=True, client_kwargs={'region_name':'us-west-2'})
theme, typ = sys.argv[1], sys.argv[2]
xmin,ymin,xmax,ymax = map(float, sys.argv[3:7])
out = sys.argv[7]
path = f'overturemaps-us-west-2/release/2026-09-23.0/theme={theme}/type={typ}/'
d = ds.dataset(path, filesystem=fs, format='parquet')
f = (pc.field('bbox','xmin') > xmin) & (pc.field('bbox','xmax') < xmax) & (pc.field('bbox','ymin') > ymin) & (pc.field('bbox','ymax') < ymax)
t0=time.time()
cols = [c for c in ['id','subtype','class','names','geometry','height','elevation'] if c in d.schema.names]
tab = d.to_table(filter=f, columns=cols)
print('rows', tab.num_rows, 'secs', round(time.time()-t0))
rows = tab.to_pylist()
print(Counter((r.get('subtype'), r.get('class')) for r in rows).most_common(40))
res=[]
for r in rows:
    g = wkb.loads(r['geometry'])
    res.append(dict(subtype=r.get('subtype'), cls=r.get('class'), name=(r.get('names') or {}).get('primary'), wkt=g.wkt))
json.dump(res, open(out,'w'))
