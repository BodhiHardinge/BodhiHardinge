import { atmosphereAt } from '../physics/atmosphere.ts';
import type { Environment } from '../physics/dynamics.ts';
import { celsius } from '../physics/units.ts';
import { CALM } from '../physics/wind.ts';

/** One row of a published launch monitor average, in the units it was published in. */
export interface ReferenceShot {
  readonly club: string;
  readonly clubSpeedMph: number;
  readonly attackAngleDeg: number;
  readonly ballSpeedMph: number;
  readonly smashFactor: number;
  readonly launchAngleDeg: number;
  readonly spinRpm: number;
  readonly apexYards: number;
  readonly landingAngleDeg: number;
  readonly carryYards: number;
}

const row = (
  club: string,
  clubSpeedMph: number,
  attackAngleDeg: number,
  ballSpeedMph: number,
  smashFactor: number,
  launchAngleDeg: number,
  spinRpm: number,
  apexYards: number,
  landingAngleDeg: number,
  carryYards: number,
): ReferenceShot => ({
  club, clubSpeedMph, attackAngleDeg, ballSpeedMph, smashFactor, launchAngleDeg, spinRpm, apexYards,
  landingAngleDeg, carryYards,
});

// Trackman PGA Tour averages.
export const PGA_TOUR_AVERAGES: readonly ReferenceShot[] = [
  row('Driver', 113, -1.3, 167, 1.48, 10.9, 2686, 32, 38, 275),
  row('3-wood', 107, -2.9, 158, 1.48, 9.2, 3655, 30, 43, 243),
  row('5-wood', 103, -3.3, 152, 1.47, 9.4, 4350, 31, 47, 230),
  row('Hybrid', 100, -3.5, 146, 1.46, 10.2, 4437, 29, 47, 225),
  row('3-iron', 98, -3.1, 142, 1.45, 10.4, 4630, 27, 46, 212),
  row('4-iron', 96, -3.4, 137, 1.43, 11.0, 4836, 28, 48, 203),
  row('5-iron', 94, -3.7, 132, 1.41, 12.1, 5361, 31, 49, 194),
  row('6-iron', 92, -4.1, 127, 1.38, 14.1, 6231, 30, 50, 183),
  row('7-iron', 90, -4.3, 120, 1.33, 16.3, 7097, 32, 50, 172),
  row('8-iron', 87, -4.5, 115, 1.32, 18.1, 7998, 31, 50, 160),
  row('9-iron', 85, -4.7, 109, 1.28, 20.4, 8647, 30, 51, 148),
  row('PW', 83, -5.0, 102, 1.23, 24.2, 9304, 29, 52, 136),
];

// Trackman LPGA Tour averages. Not used for fitting, so they test how well the model generalises.
export const LPGA_TOUR_AVERAGES: readonly ReferenceShot[] = [
  row('Driver', 94, 3.0, 140, 1.48, 13.2, 2611, 25, 37, 218),
  row('3-wood', 90, -0.9, 132, 1.47, 11.2, 2704, 23, 39, 195),
  row('5-wood', 88, -1.8, 128, 1.47, 12.1, 4501, 26, 43, 185),
  row('7-wood', 85, -3.0, 123, 1.45, 12.7, 4693, 25, 46, 174),
  row('4-iron', 80, -1.7, 116, 1.45, 14.3, 4801, 24, 43, 169),
  row('5-iron', 79, -1.9, 112, 1.42, 14.8, 5081, 23, 45, 161),
  row('6-iron', 78, -2.3, 109, 1.39, 17.1, 5943, 25, 46, 152),
  row('7-iron', 76, -2.3, 104, 1.37, 19.0, 6699, 26, 47, 141),
  row('8-iron', 74, -3.1, 100, 1.35, 20.8, 7494, 25, 47, 130),
  row('9-iron', 72, -3.1, 93, 1.28, 23.9, 7589, 26, 47, 119),
  row('PW', 70, -2.8, 86, 1.23, 25.6, 8403, 23, 48, 107),
];

// The averages were collected across many venues; these are assumed typical conditions.
export const TOUR_CONDITIONS: Environment = {
  atmosphere: atmosphereAt(0, celsius(25), 0.5),
  wind: CALM,
  landingHeight: 0,
};
