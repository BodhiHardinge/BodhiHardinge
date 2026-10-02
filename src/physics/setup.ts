import { type ClubSpec, type Delivery } from './club.ts';
import { speedRatio, tourDynamicLoft } from './impact.ts';
import { ARM_LENGTH } from './swing.ts';
import { degrees } from './units.ts';

/** How the golfer stands to the ball and means to swing. Angles in rad, distances in m; all zero is the stock shot. */
export interface Setup {
  readonly club: ClubSpec;
  /** Share of full swing speed, 1 = full. */
  readonly effort: number;
  /** Ball forward (+, toward the target) or back (-) of the club's stock position in the stance, m. */
  readonly ballPosition: number;
  /** Extra forward shaft lean at impact, rad. Hands ahead take loft off. */
  readonly shaftLean: number;
  /** Where the body and club are aimed, relative to the target line, rad. + right. */
  readonly aim: number;
  /** Clubface relative to the aim, rad. + open. */
  readonly face: number;
  /** Swing direction relative to the aim, rad. + in-to-out. */
  readonly path: number;
  /** Change to the club's swing plane, rad. + more upright. */
  readonly plane: number;
}

export interface Player {
  /** Driver club speed at full effort, m/s. */
  readonly driverSpeed: number;
  /** Putter head speed at a full-length stroke, m/s. */
  readonly putterSpeed: number;
}

export function stockSetup(club: ClubSpec, effort = 1): Setup {
  return { club, effort, ballPosition: 0, shaftLean: 0, aim: 0, face: 0, path: 0, plane: 0 };
}

/** The swing plane this setup actually uses, rad from the ground. */
export function planeOf(setup: Setup): number {
  return Math.min(degrees(85), Math.max(degrees(25), setup.club.plane + setup.plane));
}

// How far the face rotates (closes) per radian the club travels round its arc near impact.
const FACE_CLOSURE = 0.9;

/**
 * The club delivery a perfectly timed swing gives from this setup. The club head runs on a circle tilted at the
 * swing plane, so moving the ball forward meets it later on the arc: the attack angle climbs, the path swings
 * left, the face has closed further, and the shaft has less forward lean, so the loft rises.
 */
export function deliveryFor(setup: Setup, player: Player): Delivery {
  const spec = setup.club;
  const radius = ARM_LENGTH + spec.length;
  const stockPlane = spec.plane;
  const plane = planeOf(setup);

  // Where on the arc the stock ball position sits (negative = before the low point, so hitting down).
  const stockArc = Math.asin(Math.max(-0.9, Math.min(0.9, Math.sin(spec.attackAngle) / Math.sin(stockPlane))));
  const arc = stockArc + setup.ballPosition / radius;

  const attackAngle = Math.asin(Math.sin(arc) * Math.sin(plane));
  // Past the low point the club is heading back inside (left): the horizontal part of the arc's direction.
  const clubPath = setup.aim + setup.path + Math.atan(Math.tan(stockArc) * Math.cos(stockPlane)) - Math.atan(Math.tan(arc) * Math.cos(plane));
  const dynamicLoft = tourDynamicLoft(spec) - setup.shaftLean + setup.ballPosition / spec.length;
  const faceAngle = setup.aim + setup.face - FACE_CLOSURE * (setup.ballPosition / radius);
  const full = spec.head === 'putter' ? player.putterSpeed : player.driverSpeed * speedRatio(spec);

  return { clubSpeed: Math.max(0.1, setup.effort * full), attackAngle, clubPath, faceAngle, dynamicLoft };
}
