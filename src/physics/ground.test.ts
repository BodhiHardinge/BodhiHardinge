import { describe, expect, it } from 'vitest';
import { atmosphereAt } from './atmosphere.ts';
import { TOUR_BALL } from './ball.ts';
import type { Environment } from './dynamics.ts';
import { bounce, simulateShot, SURFACES, type Surface } from './ground.ts';
import type { LaunchConditions } from './launch.ts';
import { celsius, degrees, mph, rpm, toYards } from './units.ts';
import { CALM } from './wind.ts';

const env: Environment = { atmosphere: atmosphereAt(0, celsius(25), 0.5), wind: CALM, landingHeight: 0 };
const DRIVE: LaunchConditions = { ballSpeed: mph(167), launchAngle: degrees(10.9), launchDirection: 0, spinRate: rpm(2686), spinAxis: 0 };
const SEVEN: LaunchConditions = { ballSpeed: mph(120), launchAngle: degrees(16.3), launchDirection: 0, spinRate: rpm(7097), spinAxis: 0 };
const rollYards = (launch: LaunchConditions, surface: Surface) => toYards(simulateShot(launch, env, { surface }).roll);

describe('bounce', () => {
  const incoming = Float64Array.of(0, 0, 0, 20, -15, 0, 0, 0, rpm(3000));

  it('loses energy on every bounce', () => {
    for (const surface of Object.values(SURFACES)) {
      const out = bounce(incoming, surface, TOUR_BALL);
      expect(Math.hypot(out[3], out[4], out[5])).toBeLessThan(Math.hypot(20, 15));
      expect(out[4]).toBeGreaterThan(0);
    }
  });

  it('leaves a ball on hard grippy ground rolling, with no slip at the contact point', () => {
    const grippy: Surface = { name: 'test', firmness: 1, friction: 5, rollingResistance: 1, softness: 0 };
    const out = bounce(incoming, grippy, TOUR_BALL);
    const radius = TOUR_BALL.diameter / 2;
    expect(out[3] + radius * out[8]).toBeCloseTo(0, 9);
  });
});

describe('a full shot', () => {
  it('rolls a Tour drive about 15 to 30 yards on a fairway', () => {
    const roll = rollYards(DRIVE, SURFACES.fairway);
    expect(roll).toBeGreaterThan(15);
    expect(roll).toBeLessThan(30);
  });

  it('rolls furthest on firm fairway and least in rough', () => {
    const firm = rollYards(DRIVE, SURFACES.firmFairway);
    const fairway = rollYards(DRIVE, SURFACES.fairway);
    const rough = rollYards(DRIVE, SURFACES.rough);
    expect(firm).toBeGreaterThan(fairway);
    expect(fairway).toBeGreaterThan(rough);
  });

  it('stops a Tour 7-iron within 3 yards of where it lands on a green', () => {
    expect(Math.abs(rollYards(SEVEN, SURFACES.green))).toBeLessThan(3);
  });

  it('rolls further with less backspin', () => {
    expect(rollYards({ ...SEVEN, spinRate: rpm(3000) }, SURFACES.green)).toBeGreaterThan(rollYards(SEVEN, SURFACES.green) + 3);
  });

  it('stays on the target line when hit straight, and mirrors a fade with a draw', () => {
    expect(Math.abs(simulateShot(DRIVE, env).totalOffline)).toBeLessThan(1e-9);
    const fade = simulateShot({ ...DRIVE, spinAxis: degrees(10) }, env);
    const draw = simulateShot({ ...DRIVE, spinAxis: degrees(-10) }, env);
    expect(draw.totalOffline).toBeCloseTo(-fade.totalOffline, 6);
  });

  it('ends its timeline exactly at the resting position', () => {
    const shot = simulateShot(DRIVE, env);
    const end = shot.positionAt(shot.duration);
    expect(end.x).toBeCloseTo(shot.restPosition.x, 9);
    expect(shot.phaseAt(0.5)).toBe('flight');
    expect(shot.phaseAt(shot.duration)).toBe('roll');
  });

  it('never moves backwards in time: distance along the line only changes smoothly', () => {
    const shot = simulateShot(DRIVE, env);
    let previous = shot.positionAt(0);
    for (let t = 0.05; t <= shot.duration; t += 0.05) {
      const p = shot.positionAt(t);
      expect(Math.hypot(p.x - previous.x, p.z - previous.z)).toBeLessThan(5);
      previous = p;
    }
  });
});
