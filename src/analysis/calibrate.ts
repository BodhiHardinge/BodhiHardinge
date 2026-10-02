import type { AeroModel, Ball } from '../physics/ball.ts';
import type { Environment } from '../physics/dynamics.ts';
import { nelderMead } from './nelder-mead.ts';
import { TOUR_CONDITIONS, type ReferenceShot } from './reference-data.ts';
import { validate, validationScore } from './validate.ts';

export type AeroKey = keyof AeroModel;

export interface CalibrationResult {
  readonly ball: Ball;
  readonly score: number;
  readonly iterations: number;
}

const INFEASIBLE = 1e9;

// Physically plausible ranges, so the fit cannot exploit unrealistic shapes such as an instant drag drop.
export const AERO_BOUNDS: Record<AeroKey, readonly [number, number]> = {
  dragBase: [0.1, 0.4],
  dragSubcritical: [0.3, 0.6],
  criticalReynolds: [20_000, 200_000],
  crisisWidth: [5_000, 100_000],
  inducedDrag: [0, 5],
  liftMax: [0.1, 1],
  liftHalfSpin: [0.01, 1],
  liftExponent: [0.3, 3],
  spinDecay: [1e-4, 3e-3],
};

/** Tunes the chosen aero parameters so simulated shots match the reference shots as closely as possible. */
export function calibrateAero(
  base: Ball,
  shots: readonly ReferenceShot[],
  keys: readonly AeroKey[],
  env: Environment = TOUR_CONDITIONS,
): CalibrationResult {
  const build = (x: number[]): Ball => {
    const aero: Record<AeroKey, number> = { ...base.aero };
    keys.forEach((key, i) => { aero[key] = x[i]; });
    return { ...base, aero };
  };
  const feasible = (x: number[]) => keys.every((key, i) => x[i] >= AERO_BOUNDS[key][0] && x[i] <= AERO_BOUNDS[key][1]);
  const objective = (x: number[]) => (feasible(x) ? validationScore(validate(shots, build(x), env)) : INFEASIBLE);

  // Restarting from the best point guards against the simplex collapsing early.
  let x = keys.map((key) => base.aero[key]);
  let iterations = 0;
  let value = objective(x);
  for (let round = 0; round < 3; round++) {
    const result = nelderMead(objective, x, { steps: x.map((v) => v * 0.15), maxIterations: 800, tolerance: 1e-10 });
    iterations += result.iterations;
    x = result.x;
    value = result.value;
  }
  return { ball: build(x), score: value, iterations };
}
