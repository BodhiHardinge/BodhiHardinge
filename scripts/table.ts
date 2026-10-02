import { withinTolerance, type ValidationRow } from '../src/analysis/validate.ts';

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const signed = (x: number, digits = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;

export function printValidation(title: string, rows: readonly ValidationRow[]): void {
  const header = ['Club', 'Carry', 'Ref', 'Err', 'Apex', 'Ref', 'Err', 'Land', 'Ref', 'Err', ''];
  const widths = [8, 7, 5, 7, 6, 5, 6, 6, 5, 6, 4];
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join(' ');

  console.log(`\n${title}`);
  console.log(line(header));
  for (const r of rows) {
    console.log(
      line([
        r.shot.club,
        r.carryYards.toFixed(1),
        String(r.shot.carryYards),
        pct(r.carryError),
        r.apexYards.toFixed(1),
        String(r.shot.apexYards),
        signed(r.apexErrorYards),
        r.landingAngleDeg.toFixed(1),
        String(r.shot.landingAngleDeg),
        signed(r.landingAngleErrorDeg),
        withinTolerance(r) ? 'ok' : 'MISS',
      ]),
    );
  }
  const worst = Math.max(...rows.map((r) => Math.abs(r.carryError)));
  const mean = rows.reduce((s, r) => s + Math.abs(r.carryError), 0) / rows.length;
  console.log(`Carry error: mean ${(mean * 100).toFixed(1)}%, worst ${(worst * 100).toFixed(1)}%. Distances in yards, angles in degrees.`);
}
