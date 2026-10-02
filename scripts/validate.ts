import { LPGA_TOUR_AVERAGES, PGA_TOUR_AVERAGES } from '../src/analysis/reference-data.ts';
import { validate, validationScore } from '../src/analysis/validate.ts';
import { TOUR_BALL } from '../src/physics/ball.ts';
import { printValidation } from './table.ts';

const pga = validate(PGA_TOUR_AVERAGES, TOUR_BALL);
const lpga = validate(LPGA_TOUR_AVERAGES, TOUR_BALL);
printValidation(`PGA Tour averages (fitting set), score ${validationScore(pga).toFixed(3)}`, pga);
printValidation(`LPGA Tour averages (held out), score ${validationScore(lpga).toFixed(3)}`, lpga);
