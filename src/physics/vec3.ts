// World frame: +X downrange along the target line, +Y up, +Z right. Right-handed, Y-up (same as three.js).
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
