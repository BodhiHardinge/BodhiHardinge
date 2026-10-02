import { describe, expect, it } from 'vitest';
import { atmosphereAt } from '../physics/atmosphere.ts';
import { makeHole } from '../physics/hole.ts';
import { simulateShot } from '../physics/ground.ts';
import { celsius, degrees, mph, rpm } from '../physics/units.ts';
import { CALM } from '../physics/wind.ts';
import { findHoleOut } from './aim.ts';
import { findOutliers } from './outliers.ts';
import type { ShotRecord } from './shots.ts';

const shot = (carry: number, ballSpeed = 48, spinMeasured = true): ShotRecord => ({
  date: '', club: '7 Iron', ballSpeed, launchAngle: 0.37, launchDirection: 0, spinRate: 660, spinAxis: 0, spinMeasured, carry,
});

describe('outliers', () => {
  const normal = Array.from({ length: 30 }, (_, i) => shot(135 + (i % 7) - 3, 48 + (i % 5) * 0.3 - 0.6));
  const thin = shot(100, 40);
  const verdicts = findOutliers([...normal, thin]);

  it('flags a badly struck 7-iron that went 100 m', () => {
    expect(verdicts.get(thin)?.outlier).toBe(true);
    expect(verdicts.get(thin)?.reasons.join()).toMatch(/carry .*low/);
  });

  it('keeps ordinary shots', () => {
    expect(normal.filter((s) => verdicts.get(s)?.outlier)).toHaveLength(0);
  });

  it('can reject estimated spin', () => {
    const guessed = shot(135, 48, false);
    expect(findOutliers([...normal, guessed], { threshold: 3, rejectEstimatedSpin: true }).get(guessed)?.outlier).toBe(true);
  });

  it('leaves small samples alone', () => {
    const few = [shot(130), shot(132), shot(60)];
    expect([...findOutliers(few).values()].some((v) => v.outlier)).toBe(false);
  });
});

describe('finding a hole-out', () => {
  it('nudges a wedge until it finishes in the cup', () => {
    const env = { atmosphere: atmosphereAt(0, celsius(25), 0.5), wind: CALM, landingHeight: 0 };
    const launch = { ballSpeed: mph(90), launchAngle: degrees(28), launchDirection: degrees(1), spinRate: rpm(8000), spinAxis: 0 };
    const hole = makeHole(100);
    const ace = findHoleOut(launch, env, hole);
    expect(ace).not.toBeNull();
    expect(simulateShot(ace!, env, { hole }).holed).toBe(true);
  });
});
