import * as THREE from 'three';
import type { CourseFeatures, FeaturePolygon } from '../game/course-file.ts';
import { COLOURS, random } from './scenery.ts';

/** Everything needed to draw a course: heights, surface codes and outlines. */
export interface CourseScene {
  readonly width: number;
  readonly depth: number;
  readonly codes: Uint8Array;
  /** Surface codes per metre. */
  readonly codeScale: number;
  readonly features: CourseFeatures | undefined;
  height(x: number, z: number): number;
}

const TILE = 100;

interface Level {
  /** Metres between mesh vertices. */
  readonly step: number;
  /** Texture pixels per metre. */
  readonly ppm: number;
}

const NEAR: Level = { step: 1, ppm: 6 };
const MID: Level = { step: 2, ppm: 3 };
const FAR: Level = { step: 4, ppm: 1.5 };

const PAINT = {
  native: '#9b8f68',
  thick: '#4a6d36',
  rough: '#3f7a35',
  fairway: '#62b052',
  fairwayStripe: '#559f47',
  fringe: '#57a447',
  green: '#86d06c',
  greenStripe: '#7cc663',
  tee: '#6abf5a',
  sand: '#e6d6a6',
  sandLip: '#c9b582',
  water: '#3f7fb3',
  waterEdge: '#6aa3cf',
};

function path(polys: readonly FeaturePolygon[]): Path2D {
  const p = new Path2D();
  for (const poly of polys) {
    for (const ring of poly) {
      ring.forEach(([x, z], i) => (i === 0 ? p.moveTo(x, z) : p.lineTo(x, z)));
      p.closePath();
    }
  }
  return p;
}

/**
 * The course terrain as 100 m tiles. Tiles around the hole being played get a vertex every metre (the resolution of
 * the lidar) and a texture painted at 6 pixels per metre from the course outlines, so edges stay crisp; distant
 * tiles are coarser. Shading comes from the true ground slope, so tiles join without seams.
 */
export class TerrainView {
  readonly group = new THREE.Group();
  private readonly scene: CourseScene;
  private readonly tiles = new Map<string, { mesh: THREE.Mesh; level: Level }>();
  private readonly paths: Record<keyof CourseFeatures, Path2D> | null;
  private readonly noise: HTMLCanvasElement;
  private readonly cols: number;
  private readonly rows: number;

  constructor(scene: CourseScene) {
    this.scene = scene;
    this.cols = Math.ceil(scene.width / TILE);
    this.rows = Math.ceil(scene.depth / TILE);
    const f = scene.features;
    this.paths = f
      ? { boundary: path(f.boundary), rough: path(f.rough), fairway: path(f.fairway), tee: path(f.tee), green: path(f.green), sand: path(f.sand), water: path(f.water) }
      : null;
    this.noise = makeNoise();
    for (let j = 0; j < this.rows; j++) for (let i = 0; i < this.cols; i++) this.build(i, j, FAR);
    this.group.add(buildPlanting(scene));
  }

  /** Gives full detail to the tiles a region touches, and middle detail to their neighbours. */
  focus(x0: number, z0: number, x1: number, z1: number): void {
    const i0 = Math.floor(Math.max(0, x0) / TILE);
    const i1 = Math.floor(Math.min(this.scene.width - 1, x1) / TILE);
    const j0 = Math.floor(Math.max(0, z0) / TILE);
    const j1 = Math.floor(Math.min(this.scene.depth - 1, z1) / TILE);
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const inside = i >= i0 && i <= i1 && j >= j0 && j <= j1;
        const near = i >= i0 - 1 && i <= i1 + 1 && j >= j0 - 1 && j <= j1 + 1;
        const level = inside ? NEAR : near ? MID : FAR;
        if (this.tiles.get(`${i},${j}`)?.level !== level) this.build(i, j, level);
      }
    }
  }

  private build(i: number, j: number, level: Level): void {
    const key = `${i},${j}`;
    const old = this.tiles.get(key);
    if (old) {
      this.group.remove(old.mesh);
      old.mesh.geometry.dispose();
      const m = old.mesh.material as THREE.MeshLambertMaterial;
      m.map?.dispose();
      m.dispose();
    }
    const x0 = i * TILE;
    const z0 = j * TILE;
    const x1 = Math.min(this.scene.width, x0 + TILE);
    const z1 = Math.min(this.scene.depth, z0 + TILE);
    const mesh = new THREE.Mesh(this.geometry(x0, z0, x1, z1, level.step), new THREE.MeshLambertMaterial({ map: this.paint(x0, z0, x1, z1, level.ppm), side: THREE.DoubleSide }));
    this.tiles.set(key, { mesh, level });
    this.group.add(mesh);
  }

  private geometry(x0: number, z0: number, x1: number, z1: number, step: number): THREE.BufferGeometry {
    const nx = Math.ceil((x1 - x0) / step) + 1;
    const nz = Math.ceil((z1 - z0) / step) + 1;
    // The grid plus a skirt hanging below each edge, which hides cracks where coarse and fine tiles meet.
    const count = nx * nz + 2 * (nx + nz);
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const h = (x: number, z: number) => this.scene.height(x, z);
    let k = 0;
    const put = (x: number, z: number, drop: number) => {
      const dx = (h(x + 0.5, z) - h(x - 0.5, z));
      const dz = (h(x, z + 0.5) - h(x, z - 0.5));
      const len = Math.hypot(dx, 1, dz);
      position.set([x, h(x, z) - drop, z], 3 * k);
      normal.set([-dx / len, 1 / len, -dz / len], 3 * k);
      uv.set([(x - x0) / (x1 - x0), 1 - (z - z0) / (z1 - z0)], 2 * k);
      return k++;
    };
    const X = (a: number) => Math.min(x1, x0 + a * step);
    const Z = (b: number) => Math.min(z1, z0 + b * step);
    for (let b = 0; b < nz; b++) for (let a = 0; a < nx; a++) put(X(a), Z(b), 0);
    const index: number[] = [];
    for (let b = 0; b < nz - 1; b++) {
      for (let a = 0; a < nx - 1; a++) {
        const p = b * nx + a;
        index.push(p, p + nx, p + 1, p + 1, p + nx, p + nx + 1);
      }
    }
    const skirt = (edge: number[]) => {
      const low = edge.map((v) => put(position[3 * v], position[3 * v + 2], 1.5));
      for (let s = 0; s < edge.length - 1; s++) index.push(edge[s], low[s], edge[s + 1], edge[s + 1], low[s], low[s + 1]);
    };
    const top = Array.from({ length: nx }, (_, a) => a);
    const bottom = Array.from({ length: nx }, (_, a) => (nz - 1) * nx + a);
    const left = Array.from({ length: nz }, (_, b) => b * nx);
    const right = Array.from({ length: nz }, (_, b) => b * nx + nx - 1);
    skirt(top.reverse());
    skirt(bottom);
    skirt(left);
    skirt(right.reverse());
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position.subarray(0, 3 * k), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normal.subarray(0, 3 * k), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, 2 * k), 2));
    g.setIndex(index);
    g.computeBoundingSphere();
    return g;
  }

  // Paints one tile from the outlines (or, without outlines, from the surface raster).
  private paint(x0: number, z0: number, x1: number, z1: number, ppm: number): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round((x1 - x0) * ppm));
    canvas.height = Math.max(2, Math.round((z1 - z0) * ppm));
    const ctx = canvas.getContext('2d')!;
    const sx = canvas.width / (x1 - x0);
    const sz = canvas.height / (z1 - z0);
    ctx.setTransform(sx, 0, 0, sz, -x0 * sx, -z0 * sz);
    const p = this.paths;
    ctx.fillStyle = PAINT.native;
    ctx.fillRect(x0, z0, x1 - x0, z1 - z0);
    if (p) {
      ctx.fillStyle = PAINT.thick;
      ctx.fill(p.boundary, 'evenodd');
      ctx.fillStyle = PAINT.rough;
      ctx.fill(p.rough, 'evenodd');
      // Fairways with 8 m mowing stripes running diagonally.
      ctx.fillStyle = PAINT.fairway;
      ctx.fill(p.fairway, 'evenodd');
      ctx.save();
      ctx.clip(p.fairway, 'evenodd');
      stripes(ctx, x0, z0, x1, z1, 8, Math.PI / 5, PAINT.fairwayStripe);
      ctx.restore();
      ctx.fillStyle = PAINT.tee;
      ctx.fill(p.tee, 'evenodd');
      // Fringe: a 1.5 m collar round each green.
      ctx.strokeStyle = PAINT.fringe;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.stroke(p.green);
      ctx.fillStyle = PAINT.green;
      ctx.fill(p.green, 'evenodd');
      ctx.save();
      ctx.clip(p.green, 'evenodd');
      stripes(ctx, x0, z0, x1, z1, 3, Math.PI / 4, PAINT.greenStripe);
      stripes(ctx, x0, z0, x1, z1, 3, -Math.PI / 4, PAINT.greenStripe, 0.35);
      ctx.restore();
      ctx.fillStyle = PAINT.sand;
      ctx.fill(p.sand, 'evenodd');
      ctx.strokeStyle = PAINT.sandLip;
      ctx.lineWidth = 0.6;
      ctx.stroke(p.sand);
      ctx.fillStyle = PAINT.water;
      ctx.fill(p.water, 'evenodd');
      ctx.strokeStyle = PAINT.waterEdge;
      ctx.lineWidth = 0.8;
      ctx.stroke(p.water);
    } else {
      paintFromCodes(ctx, this.scene, x0, z0, x1, z1);
    }
    // Fine grain so close-up turf does not look like flat paint.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = 'overlay';
    const pattern = ctx.createPattern(this.noise, 'repeat');
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  dispose(): void {
    for (const key of [...this.tiles.keys()]) {
      const t = this.tiles.get(key)!;
      t.mesh.geometry.dispose();
      const m = t.mesh.material as THREE.MeshLambertMaterial;
      m.map?.dispose();
      m.dispose();
    }
    this.tiles.clear();
  }
}

function stripes(ctx: CanvasRenderingContext2D, x0: number, z0: number, x1: number, z1: number, width: number, angle: number, colour: string, alpha = 0.6): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Bands in a rotated frame, anchored to world coordinates so they line up across tiles.
  const corners = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([x, z]) => x * c + z * s);
  const lo = Math.floor(Math.min(...corners) / (2 * width)) * 2 * width;
  const hi = Math.max(...corners);
  const span = Math.hypot(x1 - x0, z1 - z0) * 2;
  const mx = (x0 + x1) / 2;
  const mz = (z0 + z1) / 2;
  const along = -mx * s + mz * c;
  for (let u = lo; u < hi; u += 2 * width) {
    ctx.beginPath();
    for (const [a, b] of [[u, along - span], [u + width, along - span], [u + width, along + span], [u, along + span]]) {
      ctx.lineTo(a * c - b * s, a * s + b * c);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

const CODE_PAINT = [PAINT.native, PAINT.thick, PAINT.rough, PAINT.fairway, PAINT.fringe, PAINT.green, PAINT.tee, PAINT.sand, PAINT.water];

function paintFromCodes(ctx: CanvasRenderingContext2D, scene: CourseScene, x0: number, z0: number, x1: number, z1: number): void {
  const step = 1 / scene.codeScale;
  for (let z = z0; z < z1; z += step) {
    for (let x = x0; x < x1; x += step) {
      const code = scene.codes[Math.floor(z * scene.codeScale) * Math.round(scene.width * scene.codeScale) + Math.floor(x * scene.codeScale)];
      ctx.fillStyle = CODE_PAINT[code] ?? PAINT.native;
      ctx.fillRect(x, z, step + 0.02, step + 0.02);
    }
  }
}

function makeNoise(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(128, 128);
  const rnd = random(5);
  for (let i = 0; i < 128 * 128; i++) {
    const v = 128 + (rnd() - 0.5) * 60;
    img.data.set([v, v, v, 255], 4 * i);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Scrub and a few pines in native ground, kept clear of the playing areas. */
function buildPlanting(scene: CourseScene): THREE.Group {
  const group = new THREE.Group();
  const spots: THREE.Matrix4[] = [];
  const pines: THREE.Matrix4[] = [];
  const plant = random(77);
  const codeWidth = Math.round(scene.width * scene.codeScale);
  for (let i = 0; i < 12000 && spots.length < 5000; i++) {
    const x = plant() * scene.width;
    const z = plant() * scene.depth;
    const code = scene.codes[Math.floor(z * scene.codeScale) * codeWidth + Math.floor(x * scene.codeScale)];
    if (code !== 0 && code !== 1) continue;
    const s = 0.6 + plant() * 1.2;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, scene.height(x, z), z), new THREE.Quaternion(), new THREE.Vector3(s * 1.4, s, s * 1.2));
    if (code === 0 && plant() < 0.12) pines.push(m);
    else spots.push(m);
  }
  const bush = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.9, 0).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: '#5d6b3a' }), spots.length);
  spots.forEach((m, i) => bush.setMatrixAt(i, m));
  group.add(bush);
  const crown = new THREE.ConeGeometry(2.6, 9, 7).translate(0, 7, 0);
  const trunk = new THREE.CylinderGeometry(0.3, 0.4, 2.6, 6).translate(0, 1.3, 0);
  for (const [geo, colour] of [[crown, COLOURS.pine], [trunk, COLOURS.trunk]] as const) {
    const trees = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: colour }), pines.length);
    pines.forEach((m, i) => trees.setMatrixAt(i, m));
    group.add(trees);
  }
  return group;
}
