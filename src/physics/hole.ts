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
  /** Fairway half-width either side of the target line, m. */
  readonly fairwayHalfWidth: number;
}

/** A straight hole with the pin `distance` metres away and `offset` metres right of the target line. */
export function makeHole(distance: number, offset = 0): HoleLayout {
  return {
    pin: { x: distance, z: offset },
    green: { x: distance + 2, z: offset * 0.6, radius: 14 },
    fairwayHalfWidth: 22,
  };
}

/** The turf under a point on the hole. */
export function surfaceOn(hole: HoleLayout, x: number, z: number): Surface {
  if (Math.hypot(x - hole.green.x, z - hole.green.z) <= hole.green.radius) return SURFACES.green;
  if (Math.abs(z) <= hole.fairwayHalfWidth && x > -10 && x < hole.green.x + hole.green.radius + 20) return SURFACES.fairway;
  return SURFACES.rough;
}

/** Whether a ball passing `miss` metres from the cup centre at `speed` m/s drops in. */
export function dropsIn(miss: number, speed: number): boolean {
  if (miss >= CUP_RADIUS) return false;
  return speed <= CAPTURE_SPEED * Math.sqrt(1 - (miss / CUP_RADIUS) ** 2);
}
