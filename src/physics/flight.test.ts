import { describe, expect, it } from 'vitest';
import { atmosphereAt, type Atmosphere } from './atmosphere.ts';
import type { Environment } from './dynamics.ts';
import { STANDARD_GRAVITY } from './dynamics.ts';
import { simulateFlight } from './flight.ts';
import type { LaunchConditions } from './launch.ts';
import { celsius, degrees, mph, rpm } from './units.ts';
import { CALM } from './wind.ts';

const SEA_LEVEL = atmosphereAt(0, celsius(25), 0.5);
const VACUUM: Atmosphere = { temperature: 288.15, pressure: 0, relativeHumidity: 0 };

const env = (overrides: Partial<Environment> = {}): Environment => ({
  atmosphere: SEA_LEVEL,
  wind: CALM,
  landingHeight: 0,
  ...overrides,
});

const DRIVE: LaunchConditions = {
  ballSpeed: mph(167),
  launchAngle: degrees(10.9),
  launchDirection: 0,
  spinRate: rpm(2686),
  spinAxis: 0,
};

describe('flight in a vacuum', () => {
  const speed = 50;
  const angle = degrees(30);
  const result = simulateFlight(
    { ballSpeed: speed, launchAngle: angle, launchDirection: 0, spinRate: rpm(3000), spinAxis: 0 },
    env({ atmosphere: VACUUM }),
  );

  it('matches the textbook range, apex and flight time', () => {
    const g = STANDARD_GRAVITY;
    expect(result.carry).toBeCloseTo((speed ** 2 * Math.sin(2 * angle)) / g, 6);
    expect(result.apexPosition.y).toBeCloseTo((speed * Math.sin(angle)) ** 2 / (2 * g), 6);
    expect(result.flightTime).toBeCloseTo((2 * speed * Math.sin(angle)) / g, 8);
    expect(result.landingAngle).toBeCloseTo(angle, 8);
  });
});

describe('flight in air', () => {
  const drive = simulateFlight(DRIVE, env());

  it('lands exactly on the landing surface', () => {
    expect(drive.landed).toBe(true);
    expect(Math.abs(drive.landingPosition.y)).toBeLessThan(1e-9);
  });

  it('is deterministic', () => {
    const again = simulateFlight(DRIVE, env());
    expect(again.carry).toBe(drive.carry);
    expect(again.flightTime).toBe(drive.flightTime);
  });

  it('flies straight with no sidespin and no launch direction', () => {
    expect(Math.abs(drive.offline)).toBeLessThan(1e-9);
  });

  it('flies higher with backspin than without', () => {
    const knuckleball = simulateFlight({ ...DRIVE, spinRate: 0 }, env());
    expect(drive.apexPosition.y).toBeGreaterThan(knuckleball.apexPosition.y * 1.5);
  });

  it('curves right with the spin axis tilted right, and mirrors exactly to the left', () => {
    const fade = simulateFlight({ ...DRIVE, spinAxis: degrees(15) }, env());
    const draw = simulateFlight({ ...DRIVE, spinAxis: degrees(-15) }, env());
    expect(fade.offline).toBeGreaterThan(10);
    expect(draw.offline).toBeCloseTo(-fade.offline, 9);
    expect(draw.carry).toBeCloseTo(fade.carry, 9);
  });

  it('starts right with a positive launch direction', () => {
    const push = simulateFlight({ ...DRIVE, launchDirection: degrees(3) }, env());
    expect(push.offline).toBeGreaterThan(0);
  });

  it('loses spin during flight', () => {
    expect(drive.landingSpinRate).toBeLessThan(DRIVE.spinRate);
    expect(drive.landingSpinRate).toBeGreaterThan(DRIVE.spinRate * 0.5);
  });

  it('goes further downwind and shorter into the wind', () => {
    const tail = simulateFlight(DRIVE, env({ wind: { ...CALM, speed: 5, direction: Math.PI } }));
    const head = simulateFlight(DRIVE, env({ wind: { ...CALM, speed: 5, direction: 0 } }));
    expect(tail.carry).toBeGreaterThan(drive.carry);
    expect(head.carry).toBeLessThan(drive.carry);
  });

  it('is pushed left by a wind from the right', () => {
    const cross = simulateFlight(DRIVE, env({ wind: { ...CALM, speed: 5, direction: Math.PI / 2 } }));
    expect(cross.offline).toBeLessThan(-1);
  });

  it('carries 4 to 10 percent further at Denver altitude', () => {
    const denver = simulateFlight(DRIVE, env({ atmosphere: atmosphereAt(1609, celsius(25), 0.5) }));
    const gain = denver.carry / drive.carry - 1;
    expect(gain).toBeGreaterThan(0.04);
    expect(gain).toBeLessThan(0.1);
  });

  // Not true without limit: a drive needs lift, and in a vacuum it would carry less than at sea level.
  it('carries further in thinner air at every real course altitude, for every kind of shot', () => {
    const shots: LaunchConditions[] = [
      DRIVE,
      { ...DRIVE, ballSpeed: mph(120), launchAngle: degrees(16.3), spinRate: rpm(7097) },
      { ...DRIVE, ballSpeed: mph(102), launchAngle: degrees(24.2), spinRate: rpm(9304) },
    ];
    for (const shot of shots) {
      let previous = 0;
      for (const altitude of [0, 500, 1000, 1500, 2000, 2500, 3000]) {
        const carry = simulateFlight(shot, env({ atmosphere: atmosphereAt(altitude, celsius(25), 0.5) })).carry;
        expect(carry).toBeGreaterThan(previous);
        previous = carry;
      }
    }
  });

  it('carries shorter to a raised green and further to a sunken one', () => {
    const up = simulateFlight(DRIVE, env({ landingHeight: 10 }));
    const down = simulateFlight(DRIVE, env({ landingHeight: -10 }));
    expect(up.carry).toBeLessThan(drive.carry);
    expect(down.carry).toBeGreaterThan(drive.carry);
    expect(up.landingPosition.y).toBeCloseTo(10, 9);
  });

  it('reports a ball that never reaches a green above its apex as not landed', () => {
    const result = simulateFlight(DRIVE, env({ landingHeight: 200 }), { maxTime: 15 });
    expect(result.landed).toBe(false);
  });

  it('lands immediately when launched into flat ground', () => {
    const topped = simulateFlight({ ...DRIVE, launchAngle: degrees(-2) }, env());
    expect(topped.landed).toBe(true);
    expect(topped.carry).toBe(0);
  });
});

describe('trajectory interpolation', () => {
  const drive = simulateFlight(DRIVE, env());
  const { trajectory } = drive;

  it('passes exactly through the integrator nodes', () => {
    const i = Math.floor(trajectory.nodeCount / 2);
    const state = trajectory.stateAt(trajectory.times[i]);
    for (let k = 0; k < 9; k++) expect(state[k]).toBe(trajectory.states[i * 9 + k]);
  });

  it('ends at the landing point', () => {
    const end = trajectory.positionAt(trajectory.duration);
    expect(end.x).toBeCloseTo(drive.landingPosition.x, 12);
  });

  it('agrees with the apex found by the event search', () => {
    expect(trajectory.positionAt(drive.apexTime).y).toBeCloseTo(drive.apexPosition.y, 4);
  });
});

describe('input validation', () => {
  it('rejects non-finite and impossible launches', () => {
    expect(() => simulateFlight({ ...DRIVE, ballSpeed: Number.NaN }, env())).toThrow(RangeError);
    expect(() => simulateFlight({ ...DRIVE, ballSpeed: 0 }, env())).toThrow(RangeError);
    expect(() => simulateFlight({ ...DRIVE, spinRate: -1 }, env())).toThrow(RangeError);
  });
});
