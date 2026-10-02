import type { LaunchConditions } from './launch.ts';
import { degrees, inches } from './units.ts';

export interface ClubSpec {
  readonly name: string;
  /** Shaft length, m. */
  readonly length: number;
  /** Static loft, rad. */
  readonly loft: number;
  /** Ball speed / club speed for a centred strike. */
  readonly smash: number;
  /** Typical attack angle, rad (negative = hitting down). */
  readonly attackAngle: number;
  /** How steep the swing plane is from the ground, rad. */
  readonly plane: number;
  readonly head: 'driver' | 'wood' | 'iron' | 'putter';
}

const club = (
  name: string, lengthIn: number, loftDeg: number, smash: number, attackDeg: number, planeDeg: number, head: ClubSpec['head'],
): ClubSpec => ({
  name, length: inches(lengthIn), loft: degrees(loftDeg), smash, attackAngle: degrees(attackDeg), plane: degrees(planeDeg), head,
});

// Typical modern specifications; attack angles follow the Trackman PGA Tour averages.
export const CLUBS: readonly ClubSpec[] = [
  club('Driver', 45.5, 10.5, 1.48, -1.3, 46, 'driver'),
  club('3 Wood', 43, 15, 1.47, -2.9, 49, 'wood'),
  club('5 Wood', 42, 18, 1.46, -3.3, 50, 'wood'),
  club('3 Hybrid', 40.5, 21, 1.45, -3.5, 52, 'wood'),
  club('4 Iron', 38.5, 22, 1.42, -3.4, 54, 'iron'),
  club('5 Iron', 38, 25, 1.40, -3.7, 55, 'iron'),
  club('6 Iron', 37.5, 28, 1.37, -4.1, 56, 'iron'),
  club('7 Iron', 37, 32, 1.33, -4.3, 57, 'iron'),
  club('8 Iron', 36.5, 36, 1.30, -4.5, 58, 'iron'),
  club('9 Iron', 36, 40, 1.27, -4.7, 59, 'iron'),
  club('Pitching Wedge', 35.5, 45, 1.23, -5.0, 60, 'iron'),
  club('Gap Wedge', 35.25, 50, 1.20, -5.0, 61, 'iron'),
  club('Sand Wedge', 35, 56, 1.15, -5.0, 62, 'iron'),
  club('Lob Wedge', 35, 60, 1.10, -5.0, 62, 'iron'),
];

/** Kept out of CLUBS so loft matching on full shots never picks it. */
export const PUTTER: ClubSpec = club('Putter', 34, 3, 1.45, 2, 72, 'putter');

const ALIASES: Record<string, string> = { pw: 'Pitching Wedge', '3-wood': '3 Wood', '5-wood': '5 Wood', hybrid: '3 Hybrid' };

/** Finds a club by name ("7 Iron", "7-iron", "PW"), or the club whose loft best suits the launch. */
export function clubFor(name: string | null, launch?: LaunchConditions): ClubSpec {
  if (name) {
    const key = name.trim().toLowerCase();
    const wanted = (ALIASES[key] ?? key).replace('-', ' ').toLowerCase();
    if (wanted === 'putter') return PUTTER;
    const found = CLUBS.find((c) => c.name.toLowerCase() === wanted);
    if (found) return found;
  }
  if (!launch) return CLUBS[7];
  // Launch angle is typically about two thirds of static loft, so pick the nearest loft.
  const loft = launch.launchAngle / 0.66;
  return CLUBS.reduce((best, c) => (Math.abs(c.loft - loft) < Math.abs(best.loft - loft) ? c : best));
}

/** How the club met the ball. All angles in rad, speed in m/s. */
export interface Delivery {
  readonly clubSpeed: number;
  readonly attackAngle: number;
  /** Swing direction relative to the target line; positive = in-to-out (right). */
  readonly clubPath: number;
  /** Face direction relative to the target line; positive = open (right). */
  readonly faceAngle: number;
  readonly dynamicLoft: number;
}

/**
 * Club delivery consistent with a launch, from the D-plane: start direction mostly follows the face,
 * curve follows face-to-path. Measured values, when given, win over estimates.
 */
export function estimateDelivery(launch: LaunchConditions, spec: ClubSpec, measured: Partial<Delivery> = {}): Delivery {
  const faceWeight = spec.head === 'driver' ? 0.85 : 0.75;
  const faceToPath = launch.spinAxis / 0.8;
  const clubPath = measured.clubPath ?? launch.launchDirection - faceWeight * faceToPath;
  return {
    clubSpeed: measured.clubSpeed ?? launch.ballSpeed / spec.smash,
    attackAngle: measured.attackAngle ?? spec.attackAngle,
    clubPath,
    faceAngle: measured.faceAngle ?? clubPath + faceToPath,
    dynamicLoft: measured.dynamicLoft ?? launch.launchAngle / 0.8,
  };
}
