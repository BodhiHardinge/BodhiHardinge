import type { HoleLayout, Point } from '../physics/hole.ts';

type XZ = readonly [number, number];

/** A course built by tools/build_course.py. World x runs east, z south, in metres from the north-west corner. */
export interface CourseFile {
  readonly name: string;
  readonly location: string;
  readonly note: string;
  /** Raster size in metres (1 px = 1 m): width (east), depth (south). */
  readonly size: readonly [number, number];
  readonly heightSource: string;
  readonly shapeSource: string;
  readonly holes: readonly CourseFileHole[];
  /** Surface codes per metre in surfaces.png. */
  readonly surfaceScale?: number;
  /** Outlines for painting the course crisply: each feature is a polygon of rings (outer ring, then holes). */
  readonly features?: CourseFeatures;
}

export type Ring = readonly XZ[];
export type FeaturePolygon = readonly Ring[];

export interface CourseFeatures {
  readonly boundary: readonly FeaturePolygon[];
  readonly rough: readonly FeaturePolygon[];
  readonly fairway: readonly FeaturePolygon[];
  readonly tee: readonly FeaturePolygon[];
  readonly green: readonly FeaturePolygon[];
  readonly sand: readonly FeaturePolygon[];
  readonly water: readonly FeaturePolygon[];
}

export interface CourseFileHole {
  readonly number: number;
  readonly par: number;
  /** Playing length from the back tee along the path, m. */
  readonly length: number;
  /** Tee positions, back tee first. */
  readonly tees: readonly XZ[];
  /** Tee to green, through the fairway's bends. */
  readonly path: readonly XZ[];
  readonly pin: XZ;
  /** Green outline. */
  readonly green: readonly XZ[];
  /** True where the map had no tee and one was placed at the scorecard length. */
  readonly standInTee?: boolean;
  /** True where the par comes from the hole's length on the map rather than the scorecard. */
  readonly parFromMap?: boolean;
}

export const point = (p: XZ): Point => ({ x: p[0], z: p[1] });

/** The hole in the engine's terms. The terrain supplies the turf; this supplies the cup. */
export function holeLayout(h: CourseFileHole): HoleLayout {
  const pin = point(h.pin);
  const xs = h.green.map((p) => p[0]);
  const zs = h.green.map((p) => p[1]);
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const cz = zs.reduce((a, b) => a + b, 0) / zs.length;
  const radius = Math.max(...h.green.map((p) => Math.hypot(p[0] - cx, p[1] - cz)));
  const start = point(h.path[0]);
  return { pin, green: { x: cx, z: cz, radius }, fairway: { from: start, to: pin, halfWidth: 20 } };
}

/** Which tee to play from: the back tee for the best players, further forward for easier games. */
export function teeFor(h: CourseFileHole, choice: 'back' | 'middle' | 'forward'): Point {
  const i = choice === 'back' ? 0 : choice === 'middle' ? Math.floor((h.tees.length - 1) / 2) : h.tees.length - 1;
  return point(h.tees[i]);
}

/** Distance along the hole's path from a tee to the pin, m. */
export function playingLength(h: CourseFileHole, tee: Point): number {
  const path = h.path.map(point);
  // Start from the path point nearest the tee, then follow the path to the pin.
  let best = 0;
  for (let i = 0; i < path.length; i++) if (Math.hypot(path[i].x - tee.x, path[i].z - tee.z) < Math.hypot(path[best].x - tee.x, path[best].z - tee.z)) best = i;
  let length = Math.hypot(path[Math.min(best + 1, path.length - 1)].x - tee.x, path[Math.min(best + 1, path.length - 1)].z - tee.z);
  for (let i = best + 1; i < path.length - 1; i++) length += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
  const pin = point(h.pin);
  const end = path[path.length - 1];
  return length + Math.hypot(pin.x - end.x, pin.z - end.z);
}

/** Where to aim from a spot: the next bend in the path still ahead, or the pin. */
export function aimPoint(h: CourseFileHole, from: Point, reach: number): Point {
  const pin = point(h.pin);
  const toPin = Math.hypot(pin.x - from.x, pin.z - from.z);
  if (toPin <= reach) return pin;
  for (const p of h.path.slice(1, -1).map(point)) {
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    const ahead = Math.hypot(pin.x - p.x, pin.z - p.z) < toPin - 20;
    if (ahead && d > 40) return p;
  }
  return pin;
}
