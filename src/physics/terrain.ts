import { surfaceOn, type Frame, type HoleLayout } from './hole.ts';
import { SURFACE_CODES, type Surface } from './surfaces.ts';
import { vec3, type Vec3 } from './vec3.ts';

/** The ground: its height, which way it faces, and what grows on it. */
export interface Terrain {
  /** Ground height at a point, m. */
  height(x: number, z: number): number;
  /** Unit vector straight out of the ground. */
  normal(x: number, z: number): Vec3;
  surface(x: number, z: number): Surface;
}

/** Level ground at height 0, with turf from a hole layout (or one surface everywhere). */
export class FlatTerrain implements Terrain {
  private readonly hole: HoleLayout | null;
  private readonly fixed: Surface | null;
  constructor(hole: HoleLayout | null, fixed: Surface | null = null) {
    this.hole = hole;
    this.fixed = fixed;
  }
  height(): number {
    return 0;
  }
  normal(): Vec3 {
    return vec3(0, 1, 0);
  }
  surface(x: number, z: number): Surface {
    return this.fixed ?? (this.hole ? surfaceOn(this.hole, x, z) : SURFACE_CODES[3]);
  }
}

/**
 * A height grid with a surface code per cell, both 1 cell per `cell` metres. World x runs along columns (east),
 * z along rows (south). Heights are bilinear between cell centres, so the ground is continuous.
 */
export class GridTerrain implements Terrain {
  readonly width: number;
  readonly depth: number;
  readonly cell: number;
  private readonly heights: Float32Array;
  private readonly codes: Uint8Array;

  constructor(width: number, depth: number, heights: Float32Array, codes: Uint8Array, cell = 1) {
    this.width = width;
    this.depth = depth;
    this.heights = heights;
    this.codes = codes;
    this.cell = cell;
  }

  private at(i: number, j: number): number {
    const ci = Math.min(this.width - 1, Math.max(0, i));
    const cj = Math.min(this.depth - 1, Math.max(0, j));
    return this.heights[cj * this.width + ci];
  }

  height(x: number, z: number): number {
    const u = x / this.cell - 0.5;
    const v = z / this.cell - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const a = this.at(i, j) * (1 - fu) + this.at(i + 1, j) * fu;
    const b = this.at(i, j + 1) * (1 - fu) + this.at(i + 1, j + 1) * fu;
    return a * (1 - fv) + b * fv;
  }

  normal(x: number, z: number): Vec3 {
    const h = this.cell * 0.5;
    const dx = (this.height(x + h, z) - this.height(x - h, z)) / (2 * h);
    const dz = (this.height(x, z + h) - this.height(x, z - h)) / (2 * h);
    const n = Math.hypot(dx, 1, dz);
    return vec3(-dx / n, 1 / n, -dz / n);
  }

  surface(x: number, z: number): Surface {
    const i = Math.floor(x / this.cell);
    const j = Math.floor(z / this.cell);
    if (i < 0 || j < 0 || i >= this.width || j >= this.depth) return SURFACE_CODES[0];
    return SURFACE_CODES[this.codes[j * this.width + i]] ?? SURFACE_CODES[0];
  }
}

/**
 * The terrain seen from a shot frame: origin at the ball, +x along the frame heading, heights relative to the
 * ground under the ball. Shots are simulated in this frame.
 */
export class FramedTerrain implements Terrain {
  readonly base: number;
  private readonly world: Terrain;
  private readonly frame: Frame;
  private readonly c: number;
  private readonly s: number;

  constructor(world: Terrain, frame: Frame) {
    this.world = world;
    this.frame = frame;
    this.c = Math.cos(frame.heading);
    this.s = Math.sin(frame.heading);
    this.base = world.height(frame.x, frame.z);
  }

  private wx(x: number, z: number): number {
    return this.frame.x + x * this.c - z * this.s;
  }
  private wz(x: number, z: number): number {
    return this.frame.z + x * this.s + z * this.c;
  }

  height(x: number, z: number): number {
    return this.world.height(this.wx(x, z), this.wz(x, z)) - this.base;
  }

  normal(x: number, z: number): Vec3 {
    const n = this.world.normal(this.wx(x, z), this.wz(x, z));
    return vec3(n.x * this.c + n.z * this.s, n.y, -n.x * this.s + n.z * this.c);
  }

  surface(x: number, z: number): Surface {
    return this.world.surface(this.wx(x, z), this.wz(x, z));
  }
}
