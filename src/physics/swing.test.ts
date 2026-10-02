import { describe, expect, it } from 'vitest';
import { clubFor, estimateDelivery, type Delivery } from './club.ts';
import { Swing } from './swing.ts';
import { degrees, mph, toDegrees } from './units.ts';

const delivery: Delivery = {
  clubSpeed: mph(90),
  attackAngle: degrees(-4.3),
  clubPath: degrees(-3),
  faceAngle: degrees(1),
  dynamicLoft: degrees(22),
};

describe('swing kinematics', () => {
  for (const name of ['Driver', '7 Iron', 'Lob Wedge']) {
    const spec = clubFor(name);
    const swing = new Swing({ ...delivery, attackAngle: spec.attackAngle }, spec);

    it(`${name}: the club head meets the ball at impact`, () => {
      const head = swing.poseAt(0).head;
      expect(Math.hypot(head.x, head.y, head.z)).toBeLessThan(1e-9);
    });

    it(`${name}: club head speed, path and attack angle at impact match the delivery`, () => {
      const v = swing.headVelocity(0);
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(delivery.clubSpeed, 3);
      expect(toDegrees(Math.atan2(v.z, v.x))).toBeCloseTo(-3, 3);
      expect(toDegrees(Math.atan2(v.y, Math.hypot(v.x, v.z)))).toBeCloseTo(toDegrees(spec.attackAngle), 3);
    });

    it(`${name}: takes a realistic time to come down`, () => {
      expect(swing.downswing).toBeGreaterThan(0.15);
      expect(swing.downswing).toBeLessThan(0.45);
    });

    it(`${name}: keeps the club above the ground through the swing`, () => {
      for (let t = swing.start; t <= swing.end; t += 0.01) expect(swing.poseAt(t).head.y).toBeGreaterThan(-0.12);
    });
  }

  it('builds a full delivery from ball data alone', () => {
    const d = estimateDelivery(
      { ballSpeed: mph(120), launchAngle: degrees(16), launchDirection: 0, spinRate: 700, spinAxis: 0 },
      clubFor('7 Iron'),
    );
    expect(new Swing(d, clubFor('7 Iron')).poseAt(0).head.y).toBeCloseTo(0, 9);
  });
});

describe('putting stroke', () => {
  const spec = clubFor('Putter');
  const swing = new Swing({ clubSpeed: 2, attackAngle: degrees(2), clubPath: 0, faceAngle: 0, dynamicLoft: degrees(4) }, spec);

  it('meets the ball at the putt speed with a short, quick stroke', () => {
    const v = swing.headVelocity(0);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(2, 3);
    expect(swing.downswing).toBeLessThan(0.6);
    for (let t = swing.start; t <= swing.end; t += 0.01) expect(swing.poseAt(t).head.y).toBeLessThan(0.5);
  });
});
