import type { ClubSpec } from '../physics/club.ts';
import { degrees } from '../physics/units.ts';
import type { Difficulty, Faults } from './timing.ts';

/**
 * One standard deviation of swing-to-swing variation, even with perfect timing. Real golfers never repeat a swing
 * exactly; better players vary less. Units: fraction (speed), rad (angles), m (distances).
 */
export interface Spread {
  readonly speed: number;
  readonly face: number;
  readonly path: number;
  readonly attack: number;
  readonly loft: number;
  /** Bottom of the swing arc along the target line. */
  readonly lowPoint: number;
  /** Bottom of the arc up and down. */
  readonly depth: number;
  /** Strike point across the face. */
  readonly toe: number;
}

export type SpreadKey = keyof Spread;

/** A scratch golfer's spread with a mid iron from a good lie. */
export const SCRATCH_SPREAD: Spread = {
  speed: 0.012,
  face: degrees(0.9),
  path: degrees(1.2),
  attack: degrees(0.8),
  loft: degrees(0.8),
  lowPoint: 0.012,
  depth: 0.0025,
  toe: 0.005,
};

export const SPREAD_LABELS: Record<SpreadKey, { label: string; unit: 'percent' | 'degrees' | 'mm' | 'cm' }> = {
  speed: { label: 'Club speed', unit: 'percent' },
  face: { label: 'Face angle', unit: 'degrees' },
  path: { label: 'Club path', unit: 'degrees' },
  attack: { label: 'Attack angle', unit: 'degrees' },
  loft: { label: 'Dynamic loft', unit: 'degrees' },
  lowPoint: { label: 'Low point', unit: 'cm' },
  depth: { label: 'Low point depth', unit: 'mm' },
  toe: { label: 'Strike across face', unit: 'mm' },
};

/** How much more a golfer of this handicap varies than scratch. Plus handicaps are negative numbers. */
export function handicapScale(handicap: number): number {
  return Math.max(0.35, 0.75 + handicap / 12);
}

const DIFFICULTY_SCALE: Record<Difficulty, number> = { easy: 0.6, medium: 1, hard: 1.2, pro: 1.4 };
export const DEFAULT_HANDICAP: Record<Difficulty, number> = { easy: 24, medium: 14, hard: 6, pro: 0 };

/**
 * Some clubs are harder to repeat than others: a long shaft and low loft magnify face and path errors, and long
 * clubs find the low point less reliably. Wedges are the most repeatable. The putter is its own thing.
 */
export function clubScale(spec: ClubSpec): Partial<Record<SpreadKey, number>> {
  const loft = (spec.loft * 180) / Math.PI;
  if (spec.head === 'putter') return { speed: 3, face: 0.6, path: 0.5, attack: 0.5, loft: 0.3, lowPoint: 0.2, depth: 0.2, toe: 0.8 };
  if (spec.head === 'driver') return { face: 1.35, path: 1.3, lowPoint: 1.2, toe: 1.4 };
  if (spec.head === 'wood') return { face: 1.2, path: 1.2, lowPoint: 1.3, toe: 1.25 };
  const long = Math.max(0, (32 - loft) / 10);
  const short = Math.max(0, (loft - 40) / 15);
  const k = 1 + 0.25 * long - 0.2 * short;
  return { face: k, path: k, lowPoint: 1 + 0.3 * long - 0.15 * short, toe: k };
}

/** Awkward lies make the low point and strike harder to control. */
export function lieScale(lie: string): Partial<Record<SpreadKey, number>> {
  switch (lie) {
    case 'Rough': return { lowPoint: 1.2, depth: 1.3, face: 1.15 };
    case 'Thick rough': case 'Native area': return { lowPoint: 1.5, depth: 1.6, face: 1.4, speed: 1.3 };
    case 'Sand': return { lowPoint: 1.5, depth: 1.8, toe: 1.2 };
    case 'Tee': return { lowPoint: 0.8, depth: 0.7 };
    default: return {};
  }
}

/**
 * The spread for this player, difficulty, club and lie. Overrides replace the mid-iron, good-lie value; clubs and
 * lies still scale them.
 */
export function spreadFor(handicap: number, difficulty: Difficulty, spec: ClubSpec, lie: string, overrides: Partial<Spread> = {}): Spread {
  const k = handicapScale(handicap) * DIFFICULTY_SCALE[difficulty];
  const club = clubScale(spec);
  const where = lieScale(lie);
  const out = {} as Record<SpreadKey, number>;
  for (const key of Object.keys(SCRATCH_SPREAD) as SpreadKey[]) {
    out[key] = (overrides[key] ?? SCRATCH_SPREAD[key] * k) * (club[key] ?? 1) * (where[key] ?? 1);
  }
  return out;
}

/** Standard normal sample (Box-Muller). */
export function gaussian(random: () => number): number {
  const u = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** One swing's natural variation, as faults to add to the timing faults. */
export function naturalError(spread: Spread, random: () => number): Faults {
  const n = () => gaussian(random);
  return {
    speedFactor: Math.max(0.5, 1 + spread.speed * n()),
    attack: spread.attack * n(),
    path: spread.path * n(),
    face: spread.face * n(),
    loft: spread.loft * n(),
    strike: { lowPointShift: spread.lowPoint * n(), depth: spread.depth * n(), toe: spread.toe * n() },
  };
}

/** Adds two sets of faults. */
export function combineFaults(a: Faults, b: Faults): Faults {
  return {
    speedFactor: a.speedFactor * b.speedFactor,
    attack: a.attack + b.attack,
    path: a.path + b.path,
    face: a.face + b.face,
    loft: a.loft + b.loft,
    strike: {
      lowPointShift: a.strike.lowPointShift + b.strike.lowPointShift,
      depth: a.strike.depth + b.strike.depth,
      toe: a.strike.toe + b.strike.toe,
    },
  };
}
