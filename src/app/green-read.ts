import * as THREE from 'three';

type XZ = readonly [number, number];

/** Slope bands for the arrows, in percent, with their colours. */
export const SLOPE_BANDS: readonly { readonly max: number; readonly colour: string; readonly label: string }[] = [
  { max: 1, colour: '#4f9ee8', label: 'under 1%' },
  { max: 2, colour: '#46c46a', label: '1 to 2%' },
  { max: 3, colour: '#f4d35e', label: '2 to 3%' },
  { max: 4, colour: '#f59a3c', label: '3 to 4%' },
  { max: Infinity, colour: '#e0473a', label: 'over 4%' },
];

function inside(poly: readonly XZ[], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

function edgeDistance(poly: readonly XZ[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j];
    const [bx, bz] = poly[i];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

interface Arrow {
  readonly x: number;
  readonly z: number;
  readonly dx: number;
  readonly dz: number;
  readonly size: number;
  readonly percent: number;
  readonly phase: number;
}

/**
 * Green reading: contour lines every 2.5 cm of height and arrows that drift downhill, coloured and sized by slope.
 * Built in world coordinates for one green from the terrain's own heights, so it shows exactly what the ball feels.
 */
export class GreenRead {
  readonly group = new THREE.Group();
  private arrows: THREE.InstancedMesh | null = null;
  private data: Arrow[] = [];
  private height: (x: number, z: number) => number = () => 0;
  private readonly dummy = new THREE.Object3D();
  private key = '';

  get active(): boolean {
    return this.group.visible && this.data.length > 0;
  }

  /** Builds the overlay for a green outline (world coordinates). Rebuilding the same green is free. */
  build(green: readonly XZ[], height: (x: number, z: number) => number): void {
    const key = green.map((p) => p.join(',')).join(';');
    if (key === this.key) return;
    this.key = key;
    this.clear();
    this.height = height;
    const xs = green.map((p) => p[0]);
    const zs = green.map((p) => p[1]);
    const margin = 3;
    const x0 = Math.min(...xs) - margin;
    const z0 = Math.min(...zs) - margin;
    const x1 = Math.max(...xs) + margin;
    const z1 = Math.max(...zs) + margin;
    const within = (x: number, z: number) => inside(green, x, z) || edgeDistance(green, x, z) < 1.5;

    // Contours by marching squares on a 0.5 m grid.
    const step = 0.5;
    const nx = Math.ceil((x1 - x0) / step) + 1;
    const nz = Math.ceil((z1 - z0) / step) + 1;
    const H = new Float32Array(nx * nz);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const v = height(x0 + i * step, z0 + j * step);
        H[j * nx + i] = v;
        if (within(x0 + i * step, z0 + j * step)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    const interval = 0.025;
    const positions: number[] = [];
    const colours: number[] = [];
    const cLow = new THREE.Color('#9ec9ff');
    const cHigh = new THREE.Color('#ffe7a8');
    const edge = (a: number, b: number, level: number, ax: number, az: number, bx: number, bz: number): [number, number] => {
      const t = (level - a) / (b - a || 1e-9);
      return [ax + (bx - ax) * t, az + (bz - az) * t];
    };
    for (let level = Math.ceil(lo / interval) * interval; level < hi; level += interval) {
      const major = Math.abs(level / 0.1 - Math.round(level / 0.1)) < 1e-6;
      const colour = cLow.clone().lerp(cHigh, (level - lo) / (hi - lo || 1)).multiplyScalar(major ? 1 : 0.8);
      for (let j = 0; j < nz - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const ax = x0 + i * step;
          const az = z0 + j * step;
          const a = H[j * nx + i];
          const b = H[j * nx + i + 1];
          const c = H[(j + 1) * nx + i + 1];
          const d = H[(j + 1) * nx + i];
          const pts: [number, number][] = [];
          if (a < level !== b < level) pts.push(edge(a, b, level, ax, az, ax + step, az));
          if (b < level !== c < level) pts.push(edge(b, c, level, ax + step, az, ax + step, az + step));
          if (c < level !== d < level) pts.push(edge(c, d, level, ax + step, az + step, ax, az + step));
          if (d < level !== a < level) pts.push(edge(d, a, level, ax, az + step, ax, az));
          for (let k = 0; k + 1 < pts.length; k += 2) {
            const [px, pz] = pts[k];
            const [qx, qz] = pts[k + 1];
            if (!within((px + qx) / 2, (pz + qz) / 2)) continue;
            positions.push(px, level + 0.025, pz, qx, level + 0.025, qz);
            colours.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b);
          }
        }
      }
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    lines.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    this.group.add(new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, toneMapped: false })));

    // Arrows every 1.5 m inside the green, pointing downhill.
    const spacing = 1.5;
    for (let z = Math.min(...zs); z <= Math.max(...zs); z += spacing) {
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += spacing) {
        if (!inside(green, x, z)) continue;
        const gx = (height(x + 0.5, z) - height(x - 0.5, z));
        const gz = (height(x, z + 0.5) - height(x, z - 0.5));
        const slope = Math.hypot(gx, gz);
        if (slope < 0.002) continue;
        this.data.push({ x, z, dx: -gx / slope, dz: -gz / slope, size: Math.min(1.4, Math.max(0.45, slope / 0.025)), percent: slope * 100, phase: (((x * 0.37 + z * 0.61) % 1) + 1) % 1 });
      }
    }
    const shape = new THREE.Shape();
    shape.moveTo(0.35, 0);
    shape.lineTo(-0.2, 0.17);
    shape.lineTo(-0.08, 0);
    shape.lineTo(-0.2, -0.17);
    shape.closePath();
    // Lie the chevron flat, pointing along +x.
    const geometry = new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false, transparent: true, opacity: 0.95 });
    this.arrows = new THREE.InstancedMesh(geometry, material, Math.max(1, this.data.length));
    this.arrows.count = this.data.length;
    this.data.forEach((a, i) => this.arrows!.setColorAt(i, new THREE.Color(SLOPE_BANDS.find((b) => a.percent < b.max)!.colour)));
    this.group.add(this.arrows);
    this.update(0);
  }

  /** Moves each arrow a little way downhill and back, fading in and out, so the slope reads as flow. */
  update(time: number): void {
    if (!this.arrows) return;
    this.data.forEach((a, i) => {
      const f = (time * 0.45 + a.phase) % 1;
      const travel = (f - 0.5) * 1.2;
      const x = a.x + a.dx * travel;
      const z = a.z + a.dz * travel;
      this.dummy.position.set(x, this.height(x, z) + 0.04, z);
      this.dummy.rotation.set(0, -Math.atan2(a.dz, a.dx), 0);
      const s = a.size * Math.sin(Math.PI * f);
      this.dummy.scale.set(s, 1, s);
      this.dummy.updateMatrix();
      this.arrows!.setMatrixAt(i, this.dummy.matrix);
    });
    this.arrows.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    this.arrows = null;
    this.data = [];
  }

  /** Slope at a point: percent, and the direction the ground falls (unit vector in x, z). */
  static slopeAt(height: (x: number, z: number) => number, x: number, z: number): { percent: number; dx: number; dz: number } {
    const gx = height(x + 0.5, z) - height(x - 0.5, z);
    const gz = height(x, z + 0.5) - height(x, z - 0.5);
    const s = Math.hypot(gx, gz);
    return { percent: s * 100, dx: s ? -gx / s : 0, dz: s ? -gz / s : 0 };
  }
}
