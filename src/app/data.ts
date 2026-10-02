import { median } from '../analysis/compare.ts';
import { compareClubs, importShots, type ShotRecord } from '../analysis/shots.ts';
import type { KnownValues } from './readout.ts';

export interface ShotLibrary {
  readonly name: string;
  readonly shots: readonly ShotRecord[];
}

// Exports saved in data/uploads are bundled at build time; that folder is kept out of git.
const bundled = import.meta.glob('../../data/uploads/*.csv', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function bundledLibrary(): ShotLibrary | null {
  const entries = Object.entries(bundled);
  if (entries.length === 0) return null;
  const shots = entries.flatMap(([, text]) => importShots(text).shots);
  return { name: `${shots.length.toLocaleString()} shots from your export`, shots };
}

export async function readLibrary(file: File): Promise<ShotLibrary> {
  const { shots, skipped } = importShots(await file.text());
  if (shots.length === 0) throw new Error(`No shots with launch data found in ${file.name}.`);
  return { name: `${shots.length.toLocaleString()} shots from ${file.name}${skipped ? ` (${skipped} skipped)` : ''}`, shots };
}

export function clubsIn(library: ShotLibrary): { club: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const shot of library.shots) counts.set(shot.club, (counts.get(shot.club) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => compareClubs(a, b)).map(([club, count]) => ({ club, count }));
}

/** What the launch monitor reported for a shot. */
export function measuredValues(shot: ShotRecord): KnownValues {
  return { carry: shot.carry, total: shot.total, offline: shot.totalLateral, apex: shot.apex, landAngle: shot.descentAngle };
}

/** A typical shot for a club: the median of every launch and result value. */
export function typicalShot(shots: readonly ShotRecord[]): ShotRecord {
  const pick = (f: (s: ShotRecord) => number | undefined) => {
    const values = shots.map(f).filter((v): v is number => v !== undefined);
    return values.length ? median(values) : undefined;
  };
  const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return strip({
    date: 'Typical',
    club: shots[0]?.club ?? 'Unknown',
    ballSpeed: pick((s) => s.ballSpeed)!,
    launchAngle: pick((s) => s.launchAngle)!,
    launchDirection: pick((s) => s.launchDirection)!,
    spinRate: pick((s) => s.spinRate)!,
    spinAxis: pick((s) => s.spinAxis)!,
    spinMeasured: true,
    clubSpeed: pick((s) => s.clubSpeed),
    attackAngle: pick((s) => s.attackAngle),
    dynamicLoft: pick((s) => s.dynamicLoft),
    clubPath: pick((s) => s.clubPath),
    faceAngle: pick((s) => s.faceAngle),
    carry: pick((s) => s.carry),
    total: pick((s) => s.total),
    apex: pick((s) => s.apex),
    descentAngle: pick((s) => s.descentAngle),
    totalLateral: pick((s) => s.totalLateral),
  });
}

/** Where each shot first landed, m (x downrange, z right). */
export function landingSpots(shots: readonly ShotRecord[]): { x: number; z: number }[] {
  return shots
    .filter((s) => s.carry !== undefined && s.carryLateral !== undefined)
    .map((s) => ({ x: Math.sqrt(Math.max(0, s.carry! ** 2 - s.carryLateral! ** 2)), z: s.carryLateral! }));
}
