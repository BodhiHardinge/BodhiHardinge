import { describe, expect, it } from 'vitest';
import { atmosphereAt } from './atmosphere.ts';
import type { Environment } from './dynamics.ts';
import { simulateShot } from './ground.ts';
import type { LaunchConditions } from './launch.ts';
import { SURFACE_CODES } from './surfaces.ts';
import { FramedTerrain, GridTerrain, type Terrain } from './terrain.ts';
import { celsius, degrees, mph, rpm } from './units.ts';
import { CALM } from './wind.ts';

const env: Environment = { atmosphere: atmosphereAt(0, celsius(25), 0.5), wind: CALM, landingHeight: 0 };
const SEVEN: LaunchConditions = { ballSpeed: mph(120), launchAngle: degrees(16.3), launchDirection: 0, spinRate: rpm(7097), spinAxis: 0 };
const PUTT: LaunchConditions = { ballSpeed: 2, launchAngle: degrees(2), launchDirection: 0, spinRate: 1, spinAxis: 0 };

// A plane tilted so height = a*x + b*z, all one surface code.
function plane(a: number, b: number, code: number, size = 400): GridTerrain {
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) heights[j * size + i] = a * (i + 0.5) + b * (j + 0.5);
  return new GridTerrain(size, size, heights, new Uint8Array(size * size).fill(code));
}
const GREEN = SURFACE_CODES.indexOf(SURFACE_CODES[5]);

describe('terrain', () => {
  it('interpolates heights and points the normal up the slope', () => {
    const t = plane(0.1, 0, GREEN);
    expect(t.height(10, 10)).toBeCloseTo(1, 6);
    const n = t.normal(50, 50);
    expect(n.x).toBeLessThan(0);
    expect(n.y).toBeGreaterThan(0.99);
  });

  it('a framed terrain puts the ball at the origin, height zero, facing the heading', () => {
    const t = new FramedTerrain(plane(0.05, 0, GREEN), { x: 100, z: 100, heading: Math.PI / 2 });
    expect(t.height(0, 0)).toBeCloseTo(0, 6);
    // Heading +z in the world: local +x is world +z, which is level on this slope.
    expect(t.height(10, 0)).toBeCloseTo(0, 6);
    expect(t.height(0, -10)).toBeCloseTo(0.5, 6);
  });

  const framed = (t: Terrain) => new FramedTerrain(t, { x: 100, z: 200, heading: 0 });

  it('carries shorter landing uphill and longer landing downhill', () => {
    const flat = simulateShot(SEVEN, env, { terrain: framed(plane(0, 0, GREEN)) });
    const up = simulateShot(SEVEN, env, { terrain: framed(plane(0.08, 0, GREEN)) });
    const down = simulateShot(SEVEN, env, { terrain: framed(plane(-0.08, 0, GREEN)) });
    expect(up.flight.carry).toBeLessThan(flat.flight.carry - 3);
    expect(down.flight.carry).toBeGreaterThan(flat.flight.carry + 3);
  });

  it('a putt breaks downhill on a side slope and runs out further downhill', () => {
    const side = simulateShot(PUTT, env, { terrain: framed(plane(0, 0.02, GREEN)) });
    expect(side.restPosition.z).toBeLessThan(-0.05);
    const flat = simulateShot(PUTT, env, { terrain: framed(plane(0, 0, GREEN)) });
    const downhill = simulateShot(PUTT, env, { terrain: framed(plane(-0.02, 0, GREEN)) });
    expect(downhill.total).toBeGreaterThan(flat.total * 1.3);
  });

  it('a ball on a slope steeper than the turf can hold keeps rolling', () => {
    const steep = simulateShot(PUTT, env, { terrain: framed(plane(0, 0.12, GREEN)) });
    expect(Math.abs(steep.restPosition.z)).toBeGreaterThan(5);
  });

  it('stops a ball that lands in water and flags the hazard', () => {
    const wet = simulateShot(SEVEN, env, { terrain: framed(plane(0, 0, SURFACE_CODES.length - 1)) });
    expect(wet.hazard).toBe('water');
  });
});
