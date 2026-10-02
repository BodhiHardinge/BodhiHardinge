import { calibrateAero, type AeroKey } from '../src/analysis/calibrate.ts';
import { LPGA_TOUR_AVERAGES, PGA_TOUR_AVERAGES } from '../src/analysis/reference-data.ts';
import { validate } from '../src/analysis/validate.ts';
import { TOUR_BALL } from '../src/physics/ball.ts';
import { printValidation } from './table.ts';

// Usage: npm run calibrate -- dragBase liftMax (defaults to the parameters the Tour data can determine)
const requested = process.argv.slice(2) as AeroKey[];
const keys: AeroKey[] = requested.length > 0 ? requested : [
  'dragBase',
  'inducedDrag',
  'liftMax',
  'liftHalfSpin',
  'liftExponent',
];

const started = performance.now();
const result = calibrateAero(TOUR_BALL, PGA_TOUR_AVERAGES, keys);
const seconds = (performance.now() - started) / 1000;

console.log(`Fitted ${keys.join(', ')} in ${result.iterations} iterations (${seconds.toFixed(1)} s). Score ${result.score.toFixed(4)}.`);
console.log('aero:', JSON.stringify(result.ball.aero, null, 2));
printValidation('PGA Tour averages (fitting set)', validate(PGA_TOUR_AVERAGES, result.ball));
printValidation('LPGA Tour averages (held out)', validate(LPGA_TOUR_AVERAGES, result.ball));
