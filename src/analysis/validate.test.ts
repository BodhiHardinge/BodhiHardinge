import { describe, expect, it } from 'vitest';
import { TOUR_BALL } from '../physics/ball.ts';
import { calibrateAero } from './calibrate.ts';
import { LPGA_TOUR_AVERAGES, PGA_TOUR_AVERAGES } from './reference-data.ts';
import { validate, VALIDATION_TOLERANCE } from './validate.ts';

describe('Tour ball against Trackman PGA Tour averages', () => {
  for (const row of validate(PGA_TOUR_AVERAGES)) {
    it(`${row.shot.club} carry, apex and landing angle are within tolerance`, () => {
      expect(Math.abs(row.carryError)).toBeLessThanOrEqual(VALIDATION_TOLERANCE.carry);
      expect(Math.abs(row.apexErrorYards)).toBeLessThanOrEqual(VALIDATION_TOLERANCE.apexYards);
      expect(Math.abs(row.landingAngleErrorDeg)).toBeLessThanOrEqual(VALIDATION_TOLERANCE.landingAngleDeg);
    });
  }
});

describe('Tour ball against LPGA Tour averages it was not fitted to', () => {
  const rows = validate(LPGA_TOUR_AVERAGES);

  it('predicts carry within 3% on average', () => {
    const mean = rows.reduce((sum, r) => sum + Math.abs(r.carryError), 0) / rows.length;
    expect(mean).toBeLessThan(0.03);
  });

  it('predicts every club within 4%', () => {
    for (const r of rows) expect(Math.abs(r.carryError), r.shot.club).toBeLessThan(0.04);
  });
});

describe('calibration', () => {
  it('recovers a known parameter from a wrong starting guess', () => {
    const wrong = { ...TOUR_BALL, aero: { ...TOUR_BALL.aero, dragBase: 0.26 } };
    const result = calibrateAero(wrong, PGA_TOUR_AVERAGES, ['dragBase']);
    expect(result.ball.aero.dragBase).toBeCloseTo(TOUR_BALL.aero.dragBase, 2);
  });
});
