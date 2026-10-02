import { readFileSync } from 'node:fs';
import { compareCarry, summariseClubs } from '../src/analysis/compare.ts';
import { importShots } from '../src/analysis/shots.ts';
import { toDegrees, toMph, toRpm, toYards } from '../src/physics/units.ts';

// Usage: npm run analyse -- path/to/export.csv
const path = process.argv[2];
if (!path) {
  console.error('Give the path to a launch monitor CSV export, e.g. npm run analyse -- data/uploads/shots.csv');
  process.exit(1);
}

const { shots, skipped } = importShots(readFileSync(path, 'utf8'));
console.log(`${shots.length} shots imported, ${skipped} skipped for missing launch data.\n`);

console.log('Club               Shots  Ball mph  Launch  Spin rpm  Carry yd  Spread yd  Side yd');
for (const c of summariseClubs(shots)) {
  console.log(
    [
      c.club.padEnd(18),
      String(c.count).padStart(5),
      toMph(c.typical.ballSpeed).toFixed(0).padStart(9),
      toDegrees(c.typical.launchAngle).toFixed(1).padStart(7),
      toRpm(c.typical.spinRate).toFixed(0).padStart(9),
      toYards(c.medianCarry).toFixed(0).padStart(9),
      toYards(c.carrySpread).toFixed(1).padStart(10),
      toYards(c.lateralSpread).toFixed(1).padStart(8),
    ].join(' '),
  );
}

console.log('\nEngine carry versus the monitor, measured-spin shots only (positive = engine longer):');
for (const c of compareCarry(shots)) {
  const sign = c.medianError >= 0 ? '+' : '';
  console.log(`${c.club.padEnd(18)} ${String(c.count).padStart(5)} shots  median ${sign}${(c.medianError * 100).toFixed(1)}%  typical gap ${(c.medianAbsoluteError * 100).toFixed(1)}%`);
}
