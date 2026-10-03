import numpy as np, re
SCALE = 0.056444  # cgspeed CMU conversion: metres per unit
def rot(axis, deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    if axis == 'X': return np.array([[1,0,0],[0,c,-s],[0,s,c]])
    if axis == 'Y': return np.array([[c,0,s],[0,1,0],[-s,0,c]])
    return np.array([[c,-s,0],[s,c,0],[0,0,1]])
def parse(path):
    text = open(path).read()
    head, motion = text.split('MOTION')
    tokens = head.split()
    joints = []; stack = []; i = 0; name = None
    while i < len(tokens):
        t = tokens[i]
        if t in ('ROOT', 'JOINT'):
            name = tokens[i+1]; joints.append(dict(name=name, parent=stack[-1] if stack else None, offset=None, channels=[])); i += 2
        elif t == 'End':
            joints.append(dict(name=joints[-1]['name'] + '_end', parent=stack[-1], offset=None, channels=[], end=True)); i += 2
        elif t == '{': stack.append(len(joints) - 1); i += 1
        elif t == '}': stack.pop(); i += 1
        elif t == 'OFFSET': joints[-1]['offset'] = np.array(list(map(float, tokens[i+1:i+4]))); i += 4
        elif t == 'CHANNELS':
            n = int(tokens[i+1]); joints[-1]['channels'] = tokens[i+2:i+2+n]; i += 2 + n
        else: i += 1
    lines = motion.strip().split('\n')
    frames = int(lines[0].split()[1]); dt = float(lines[1].split()[2])
    data = np.array([list(map(float, l.split())) for l in lines[2:2+frames]])
    return joints, data, dt
def fk(joints, data):
    F = len(data); J = len(joints)
    pos = np.zeros((F, J, 3)); R = np.zeros((F, J, 3, 3))
    col = 0; cols = []
    for j in joints: cols.append(col); col += len(j['channels'])
    for f in range(F):
        for k, j in enumerate(joints):
            local = np.eye(3); t = np.zeros(3)
            c0 = cols[k]
            for n, ch in enumerate(j['channels']):
                v = data[f, c0 + n]
                if ch.endswith('position'): t['XYZ'.index(ch[0])] = v
                else: local = local @ rot(ch[0], v)
            if j['parent'] is None:
                pos[f, k] = (j['offset'] + t); R[f, k] = local
            else:
                p = j['parent']
                pos[f, k] = pos[f, p] + R[f, p] @ j['offset']; R[f, k] = R[f, p] @ local
    return pos * SCALE, R
