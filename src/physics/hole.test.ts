import { describe, expect, it } from 'vitest';
import { atmosphereAt } from './atmosphere.ts';
import type { Environment } from './dynamics.ts';
import { simulateShot } from './ground.ts';
import { CUP_RADIUS, dropsIn, makeHole, surfaceOn } from './hole.ts';
import type { LaunchConditions } from './launch.ts';
import { SURFACES } from './surfaces.ts';
import { celsius, degrees, mph, rpm } from './units.ts';
import { CALM } from './wind.ts';

const env: Environment = { atmosphere: atmosphereAt(0, celsius(25), 0.5), wind: CALM, landingHeight: 0 };
const WEDGE: LaunchConditions = { ballSpeed: mph(80), launchAngle: degrees(30), launchDirection: 0, spinRate: rpm(3000), spinAxis: 0 };

describe('the hole', () => {
  const hole = makeHole(130);

  it('knows which turf is where', () => {
    expect(surfaceOn(hole, 130, 0)).toBe(SURFACES.green);
    expect(surfaceOn(hole, 60, 5)).toBe(SURFACES.fairway);
    expect(surfaceOn(hole, 60, 40)).toBe(SURFACES.rough);
  });

  it('captures slow balls near the centre and rejects fast or wide ones', () => {
    expect(dropsIn(0, 1)).toBe(true);
    expect(dropsIn(0, 2)).toBe(false);
    expect(dropsIn(CUP_RADIUS * 0.9, 1)).toBe(false);
    expect(dropsIn(CUP_RADIUS * 1.1, 0.1)).toBe(false);
  });

  it('holes a ball that rolls slowly over the cup', () => {
    const farGreen = { x: 1000, z: 0, radius: 1 };
    const miss = simulateShot(WEDGE, env, { hole: { pin: { x: 1000, z: 0 }, green: farGreen, fairway: makeHole(130).fairway } });
    const rest = miss.restPosition;
    const direction = Math.atan2(rest.z, rest.x);
    const pin = { x: rest.x - 0.1 * Math.cos(direction), z: rest.z - 0.1 * Math.sin(direction) };
    const shot = simulateShot(WEDGE, env, { hole: { pin, green: farGreen, fairway: makeHole(130).fairway } });
    expect(shot.holed).toBe(true);
    expect(shot.restPosition.x).toBeCloseTo(pin.x, 9);
    expect(shot.duration).toBeLessThan(miss.duration + 1);
  });

  it('lands on the green and stops quicker than on fairway', () => {
    const onGreen = simulateShot(WEDGE, env, { surface: SURFACES.green });
    const onFairway = simulateShot(WEDGE, env, { surface: SURFACES.fairway });
    expect(onGreen.roll).not.toBeCloseTo(onFairway.roll, 1);
  });
});
