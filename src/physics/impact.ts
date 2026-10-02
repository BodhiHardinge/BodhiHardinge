import type { ClubSpec, Delivery } from './club.ts';
import type { LaunchConditions } from './launch.ts';
import { degrees } from './units.ts';

/** Where and how the face met the ball. All zero for a centred, clean strike. */
export interface Contact {
  /** Strike point toward the toe (+) or heel (-) from the sweet spot, m. */
  readonly toe: number;
  /** Strike point above (+) or below (-) the sweet spot, m. Thin shots are struck low. */
  readonly height: number;
  /** How far behind the ball the club first meets the ground, m. Fat shots lose speed and spin. */
  readonly turf: number;
}

export const CLEAN_CONTACT: Contact = { toe: 0, height: 0, turf: 0 };

/** How the lie changes the strike: grass trapped between face and ball cuts spin and some speed. */
export interface Lie {
  readonly speed: number;
  readonly spin: number;
}

export const LIES = {
  tee: { speed: 1, spin: 1 },
  fairway: { speed: 1, spin: 1 },
  rough: { speed: 0.93, spin: 0.55 },
  green: { speed: 1, spin: 1 },
} as const satisfies Record<string, Lie>;

// Piecewise-linear lookup on static loft in degrees.
function byLoft(table: readonly (readonly [number, number])[], loftDeg: number): number {
  if (loftDeg <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (loftDeg <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (loftDeg - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

// The rest of this file is fitted to the Trackman PGA Tour averages (club speed, attack, launch, spin, smash).
// Dynamic loft is not in that table, so it comes from inverting the launch model below on each Tour row.

/** Shaft lean at a Tour delivery, deg: static loft minus dynamic loft. Drivers are hit with added loft. */
const TOUR_SHAFT_LEAN: readonly (readonly [number, number])[] = [
  [3, 0], [10.5, -2.8], [15, 3.1], [18, 5.6], [21, 7.3], [25, 8.5], [32, 9.1], [36, 10.1], [40, 10.3], [45, 9.0], [60, 7],
];

/** Spin per unit of club speed times sin(spin loft), (rad/s) per (m/s). Low-spin driver faces sit well below irons. */
const SPIN_EFFICIENCY: readonly (readonly [number, number])[] = [
  [3, 22], [10.5, 22], [15, 31.3], [18, 36.5], [21, 35.2], [22, 37.9], [25, 38.7], [28, 39.7], [32, 40.5], [36, 42.6], [40, 42.2], [45, 40.1], [60, 38],
];

/** Club speed relative to the driver at the same effort, from the Tour averages. */
const SPEED_RATIO: readonly (readonly [number, number])[] = [
  [10.5, 1], [15, 0.947], [18, 0.912], [21, 0.885], [22, 0.85], [25, 0.832], [28, 0.814], [32, 0.796], [36, 0.77],
  [40, 0.752], [45, 0.735], [50, 0.72], [56, 0.7], [60, 0.69],
];

const loftDeg = (spec: ClubSpec) => (spec.loft * 180) / Math.PI;

/** Dynamic loft of a Tour player's stock strike with this club, rad. */
export function tourDynamicLoft(spec: ClubSpec): number {
  return spec.loft - degrees(byLoft(TOUR_SHAFT_LEAN, loftDeg(spec)));
}

/** Club speed of this club as a fraction of driver speed at the same effort. */
export function speedRatio(spec: ClubSpec): number {
  return spec.head === 'putter' ? 1 : byLoft(SPEED_RATIO, loftDeg(spec));
}

/**
 * Share of the spin loft by which the ball launches below the face normal, toward the club path. A rigid
 * impact gives about 0.15; the ball's compression and the friction of grooves push it higher with loft.
 */
export function gearFraction(spec: ClubSpec): number {
  return Math.min(0.3, Math.max(0.15, 0.13 + 0.2 * spec.loft));
}

// Ball speed over club speed at zero spin loft, chosen so the stock Tour strike gives the club's smash factor.
function headEfficiency(spec: ClubSpec): number {
  return spec.smash / Math.cos(tourDynamicLoft(spec) - spec.attackAngle);
}

type V = readonly [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V): V => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const direction = (elevation: number, azimuth: number): V => [
  Math.cos(elevation) * Math.cos(azimuth),
  Math.sin(elevation),
  Math.cos(elevation) * Math.sin(azimuth),
];

/** The angle between where the club is moving and where the face points, rad (3D spin loft). */
export function spinLoft(d: Delivery): number {
  const path = direction(d.attackAngle, d.clubPath);
  const normal = direction(d.dynamicLoft, d.faceAngle);
  return Math.acos(Math.min(1, Math.max(-1, dot(path, normal))));
}

/**
 * What the ball does when the club meets it. The ball leaves between the face normal and the club path
 * (closer to the normal), spinning about the axis perpendicular to both; spin grows with club speed times the
 * sine of the spin loft. This is the D-plane model, calibrated to the Tour averages.
 */
export function strike(delivery: Delivery, spec: ClubSpec, contact: Contact = CLEAN_CONTACT, lie: Lie = LIES.fairway): LaunchConditions {
  const path = direction(delivery.attackAngle, delivery.clubPath);
  const normal = direction(delivery.dynamicLoft, delivery.faceAngle);
  const theta = Math.acos(Math.min(1, Math.max(-1, dot(path, normal))));
  const g = gearFraction(spec);

  // Ball direction: slerp from the face normal toward the path by the gear fraction.
  let ball: V = normal;
  if (theta > 1e-6) {
    const a = Math.sin(g * theta) / Math.sin(theta);
    const b = Math.sin((1 - g) * theta) / Math.sin(theta);
    ball = unit([a * path[0] + b * normal[0], a * path[1] + b * normal[1], a * path[2] + b * normal[2]]);
  }

  // Fat: the club digs in first and loses speed, and turf between face and ball cuts spin.
  const dig = Math.max(0, contact.turf);
  const turfLoss = Math.exp(-dig / 0.05);
  const clubSpeed = delivery.clubSpeed * turfLoss;

  // Off-centre strikes lose ball speed; vertical and horizontal gear effect change launch, spin and curve.
  const miss = Math.hypot(contact.toe, contact.height);
  const centred = Math.max(0.4, 1 - 400 * miss * miss);
  const wood = spec.head === 'driver' || spec.head === 'wood';
  const ballSpeed = clubSpeed * headEfficiency(spec) * Math.max(0, Math.cos(theta)) * centred * lie.speed;

  let launchAngle = Math.asin(ball[1]) + degrees(150) * contact.height;
  const launchDirection = Math.atan2(ball[2], ball[0]);

  // Spin axis: perpendicular to the path and the face normal; for a square strike it points right (+z), pure backspin.
  let axisTilt = 0;
  if (theta > 1e-6) {
    const w = unit(cross(path, normal));
    const v = direction(launchAngle, launchDirection);
    const right: V = [-Math.sin(launchDirection), 0, Math.cos(launchDirection)];
    const up = cross(right, v);
    axisTilt = Math.atan2(-dot(w, up), dot(w, right));
  }
  // Toe strikes hook (axis tilts left) and heel strikes slice; much stronger on rounded wood faces.
  axisTilt -= contact.toe * degrees(wood ? 400 : 150);

  const spinGear = wood ? 1 - 12 * contact.height : 1 + 10 * contact.height;
  const turfSpin = 1 / (1 + 40 * dig);
  const spinRate =
    byLoft(SPIN_EFFICIENCY, loftDeg(spec)) * clubSpeed * Math.sin(theta) * Math.max(0.2, spinGear) * turfSpin * lie.spin;

  launchAngle = Math.max(degrees(-10), launchAngle);
  return { ballSpeed, launchAngle, launchDirection, spinRate, spinAxis: axisTilt };
}
