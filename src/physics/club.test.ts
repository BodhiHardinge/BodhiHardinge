import { describe, expect, it } from 'vitest';
import { clubFor, estimateDelivery } from './club.ts';
import type { LaunchConditions } from './launch.ts';
import { degrees, mph, rpm } from './units.ts';

const SEVEN: LaunchConditions = { ballSpeed: mph(120), launchAngle: degrees(16.3), launchDirection: 0, spinRate: rpm(7097), spinAxis: 0 };

describe('clubs', () => {
  it('finds clubs by any common name', () => {
    expect(clubFor('7-iron').name).toBe('7 Iron');
    expect(clubFor('PW').name).toBe('Pitching Wedge');
    expect(clubFor('Driver').name).toBe('Driver');
  });

  it('guesses a sensible club from launch angle', () => {
    expect(clubFor(null, { ...SEVEN, launchAngle: degrees(11) }).head).not.toBe('iron');
    expect(clubFor(null, { ...SEVEN, launchAngle: degrees(30) }).name).toMatch(/Wedge/);
  });
});

describe('estimated delivery', () => {
  it('matches Tour 7-iron club speed from smash factor', () => {
    expect(estimateDelivery(SEVEN, clubFor('7 Iron')).clubSpeed).toBeCloseTo(mph(90), 0);
  });

  it('puts the face open to the path for a fade and closed for a draw', () => {
    const fade = estimateDelivery({ ...SEVEN, spinAxis: degrees(8) }, clubFor('7 Iron'));
    const draw = estimateDelivery({ ...SEVEN, spinAxis: degrees(-8) }, clubFor('7 Iron'));
    expect(fade.faceAngle - fade.clubPath).toBeGreaterThan(0);
    expect(draw.faceAngle - draw.clubPath).toBeLessThan(0);
  });

  it('starts the ball mostly where the face points', () => {
    const d = estimateDelivery({ ...SEVEN, launchDirection: degrees(3), spinAxis: degrees(4) }, clubFor('7 Iron'));
    expect(0.75 * d.faceAngle + 0.25 * d.clubPath).toBeCloseTo(degrees(3), 9);
  });

  it('prefers measured values', () => {
    expect(estimateDelivery(SEVEN, clubFor('7 Iron'), { clubPath: degrees(-4) }).clubPath).toBeCloseTo(degrees(-4), 12);
  });
});
