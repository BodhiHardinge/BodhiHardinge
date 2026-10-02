import { TOUR_BALL, type Ball } from '../physics/ball.ts';
import type { Environment } from '../physics/dynamics.ts';
import { simulateFlight } from '../physics/flight.ts';
import type { LaunchConditions } from '../physics/launch.ts';
import { degrees, mph, rpm, toDegrees, toYards } from '../physics/units.ts';
import { TOUR_CONDITIONS, type ReferenceShot } from './reference-data.ts';

export interface ValidationRow {
  readonly shot: ReferenceShot;
  readonly carryYards: number;
  readonly apexYards: number;
  readonly landingAngleDeg: number;
  /** Fractional carry error: +0.02 means 2% long. */
  readonly carryError: number;
  readonly apexErrorYards: number;
  readonly landingAngleErrorDeg: number;
}

// An error of this size counts as 1 in the calibration score.
const SCORE_SCALE = { carry: 0.03, apexYards: 3, landingAngleDeg: 3 } as const;

// Pass/fail limits. Reference apex and angles are whole numbers averaged over many players and venues.
export const VALIDATION_TOLERANCE = { carry: 0.03, apexYards: 4, landingAngleDeg: 3.5 } as const;

export function referenceLaunch(shot: ReferenceShot): LaunchConditions {
  return {
    ballSpeed: mph(shot.ballSpeedMph),
    launchAngle: degrees(shot.launchAngleDeg),
    launchDirection: 0,
    spinRate: rpm(shot.spinRpm),
    spinAxis: 0,
  };
}

export function validate(
  shots: readonly ReferenceShot[],
  ball: Ball = TOUR_BALL,
  env: Environment = TOUR_CONDITIONS,
): ValidationRow[] {
  return shots.map((shot) => {
    const result = simulateFlight(referenceLaunch(shot), env, { ball });
    const carryYards = toYards(result.carry);
    const apexYards = toYards(result.apexPosition.y);
    const landingAngleDeg = toDegrees(result.landingAngle);
    return {
      shot,
      carryYards,
      apexYards,
      landingAngleDeg,
      carryError: carryYards / shot.carryYards - 1,
      apexErrorYards: apexYards - shot.apexYards,
      landingAngleErrorDeg: landingAngleDeg - shot.landingAngleDeg,
    };
  });
}

/** One number for how far a model is from the reference: mean squared error in units of the tolerance. */
export function validationScore(rows: readonly ValidationRow[]): number {
  let sum = 0;
  for (const r of rows) {
    sum +=
      (r.carryError / SCORE_SCALE.carry) ** 2 +
      (r.apexErrorYards / SCORE_SCALE.apexYards) ** 2 +
      (r.landingAngleErrorDeg / SCORE_SCALE.landingAngleDeg) ** 2;
  }
  return sum / rows.length;
}

export function withinTolerance(row: ValidationRow): boolean {
  return (
    Math.abs(row.carryError) <= VALIDATION_TOLERANCE.carry &&
    Math.abs(row.apexErrorYards) <= VALIDATION_TOLERANCE.apexYards &&
    Math.abs(row.landingAngleErrorDeg) <= VALIDATION_TOLERANCE.landingAngleDeg
  );
}
