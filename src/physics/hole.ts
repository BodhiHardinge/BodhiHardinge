import { SURFACES, type Surface } from './surfaces.ts';

/** Cup radius from the Rules of Golf (108 mm diameter), m. */
export const CUP_RADIUS = 0.054;
/** Fastest a ball can cross the centre of the cup and still drop, m/s. */
export const CAPTURE_SPEED = 1.3;

export interface HoleLayout {
  /** Flagstick position, m (x downrange, z right). */
  readonly pin: { readonly x: number; readonly z: number };
  /** Green centre and radius, m. */
  readonly green: { readonly x: number; readonly z: number; readonly radius: number };
  /** The fairway: a strip of turf from one point to another, `halfWidth` either side of the line. */
  readonly fairway: { readonly from: Point; readonly to: Point; readonly halfWidth: number };
}

export interface Point {
  readonly x: number;
  readonly z: number;
}

/** A straight hole with the pin `distance` metres away and `offset` metres right of the target line. */
export function makeHole(distance: number, offset = 0, fairwayHalfWidth = 22): HoleLayout {
  const green = { x: distance + 2, z: offset * 0.6, radius: 14 };
  return {
    pin: { x: distance, z: offset },
    green,
    fairway: { from: { x: -10, z: 0 }, to: { x: green.x + green.radius + 20, z: 0 }, halfWidth: fairwayHalfWidth },
  };
}

// Distance from a point to the segment a-b, m.
function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

/** The turf under a point on the hole. */
export function surfaceOn(hole: HoleLayout, x: number, z: number): Surface {
  if (Math.hypot(x - hole.green.x, z - hole.green.z) <= hole.green.radius) return SURFACES.green;
  const { from, to, halfWidth } = hole.fairway;
  // Square ends: the strip stops at its end points rather than rounding off.
  const length = Math.hypot(to.x - from.x, to.z - from.z) || 1;
  const along = ((x - from.x) * (to.x - from.x) + (z - from.z) * (to.z - from.z)) / length;
  if (along >= 0 && along <= length && toSegment({ x, z }, from, to) <= halfWidth) return SURFACES.fairway;
  return SURFACES.rough;
}

/**
 * A local frame for one shot: origin at the ball, +x along `heading` (rad, measured from the world +x toward +z).
 * Shots are simulated in this frame, so every shot starts at the origin.
 */
export interface Frame {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
}

export const WORLD_FRAME: Frame = { x: 0, z: 0, heading: 0 };

/** A world point in the frame's coordinates. */
export function toFrame(frame: Frame, p: Point): Point {
  const dx = p.x - frame.x;
  const dz = p.z - frame.z;
  const c = Math.cos(frame.heading);
  const s = Math.sin(frame.heading);
  return { x: dx * c + dz * s, z: -dx * s + dz * c };
}

/** A point in the frame back in world coordinates. */
export function fromFrame(frame: Frame, p: Point): Point {
  const c = Math.cos(frame.heading);
  const s = Math.sin(frame.heading);
  return { x: frame.x + p.x * c - p.z * s, z: frame.z + p.x * s + p.z * c };
}

/** The frame at `from` facing `toward`. */
export function frameFacing(from: Point, toward: Point): Frame {
  return { x: from.x, z: from.z, heading: Math.atan2(toward.z - from.z, toward.x - from.x) };
}

/** The hole as seen from a shot frame. */
export function holeInFrame(hole: HoleLayout, frame: Frame): HoleLayout {
  return {
    pin: toFrame(frame, hole.pin),
    green: { ...toFrame(frame, hole.green), radius: hole.green.radius },
    fairway: { from: toFrame(frame, hole.fairway.from), to: toFrame(frame, hole.fairway.to), halfWidth: hole.fairway.halfWidth },
  };
}

/** Whether a ball passing `miss` metres from the cup centre at `speed` m/s drops in. */
export function dropsIn(miss: number, speed: number): boolean {
  if (miss >= CUP_RADIUS) return false;
  return speed <= CAPTURE_SPEED * Math.sqrt(1 - (miss / CUP_RADIUS) ** 2);
}
