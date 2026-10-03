"""Exports one CMU golf swing (BVH) as aligned joint positions for the game: python tools/export_mocap.py 64_04.bvh out.json"""
import numpy as np, json, sys
from scipy.signal import medfilt
from bvh import parse, fk
path = sys.argv[1]
joints, data, dt = parse(path)
names = [j['name'] for j in joints]
pos, R = fk(joints, data)
J = lambda n: pos[:, names.index(n)]
hand = (J('LeftHand') + J('RightHand')) / 2
for k in range(3): hand[:, k] = medfilt(hand[:, k], 7)
v = medfilt(np.linalg.norm(np.gradient(hand, dt, axis=0), axis=1), 5)
impact = int(np.argmax(v))
top = int(np.argmax(hand[:impact, 1]))
# Address: last frame before the top where the hands were nearly still.
still = np.where(v[:top] < 0.08)[0]
address = int(still[-1]) if len(still) else 0
# Finish: first frame after impact where the hands slow right down, or the end.
after = np.where(v[impact:] < 0.15)[0]
finish = impact + int(after[0]) if len(after) else len(v) - 1
finish = min(len(v) - 1, finish + 20)
start = max(0, address - 30)
print('address', address, 'top', top, 'impact', impact, 'finish', finish, 'downswing', (impact - top) * dt, 'backswing', (top - address) * dt)
# Align: target along +x (left toe ahead of right toe), y up, golfer behind (-z) the ball.
lt, rt = J('LeftToeBase')[address], J('RightToeBase')[address]
tdir = (lt - rt); tdir[1] = 0; tdir /= np.linalg.norm(tdir)
up = np.array([0, 1, 0.]); side = np.cross(tdir, up)  # x cross y = z: points right of the target line
# Is the ball on the +side of the golfer? Hands at impact relative to the mid-feet.
mid = (lt + rt) / 2
hands_side = np.dot(hand[impact] - mid, side)
Rm = np.stack([tdir, up, side])  # rows: new x, y, z
keep = ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
        'LowerBack', 'Spine', 'Spine1', 'Neck', 'Neck1', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
        'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand']
keep = [k for k in keep if k in names]
foot_y = min(J('LeftToeBase')[:, 1].min(), J('RightToeBase')[:, 1].min(), J('LeftFoot')[:, 1].min(), J('RightFoot')[:, 1].min())
frames = []
step = 2  # 120 fps -> 60 fps
for f in range(start, finish + 1, step):
    out = []
    for k in keep:
        p = Rm @ (J(k)[f] - mid)
        p[1] = J(k)[f][1] - foot_y
        out += [round(float(x), 3) for x in p]
    frames.append(out)
arm = np.linalg.norm((J('LeftArm')[address] + J('RightArm')[address]) / 2 - hand[address])
info = dict(source='CMU Graphics Lab Motion Capture Database, subject 64 trial ' + path.split('_')[-1][:2] + ' (BVH by Bruce Hahne)',
            fps=60, joints=keep, frames=frames,
            phases=dict(address=(address - start) / step, top=(top - start) / step, impact=(impact - start) / step, finish=(finish - start) / step),
            ballSide=float(np.sign(hands_side)), armLength=round(float(arm), 3))
json.dump(info, open(sys.argv[2], 'w'), separators=(',', ':'))
print('frames', len(frames), 'arm', arm, 'ball side', hands_side, 'bytes', len(json.dumps(info, separators=(",", ":"))))
