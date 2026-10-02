import * as THREE from 'three';
import type { HoleLayout } from '../physics/hole.ts';
import { CUP_RADIUS } from '../physics/hole.ts';
import { unitFor, type UnitSystem } from './units.ts';

export const COLOURS = {
  skyTop: '#5b97c9',
  horizon: '#dbe7ea',
  rough: '#3d7334',
  fairwayLight: '#5fae4f',
  fairwayDark: '#4f9b43',
  greenLight: '#97de7a',
  greenDark: '#8ad46d',
  fringe: '#4e9a3f',
  tee: '#6cbd5c',
  pine: '#1d4a2a',
  trunk: '#5a4330',
  azalea: '#d6457a',
  marker: '#fffdf8',
  markerText: '#0b3b2c',
  flag: '#f4d35e',
} as const;

// Small deterministic random generator so the trees grow in the same place every load.
export function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Turf layers are painted back to front without depth, so nearly coplanar layers can never flicker (z-fighting).
// One invisible depth-only plane afterwards gives everything else correct occlusion, with a hole at the cup.
export function groundLayer<T extends THREE.Mesh>(mesh: T, order: number): T {
  mesh.renderOrder = -100 + order;
  const material = mesh.material as THREE.Material;
  material.depthTest = false;
  material.depthWrite = false;
  return mesh;
}

/**
 * Sky, light, rough, striped fairway, tee, pines and azaleas. Sky and light go on the scene; the ground and
 * planting go in `world`, which a game moves so each shot is played from the origin.
 */
export function buildRange(scene: THREE.Scene, world: THREE.Object3D = scene, options: { fairway?: boolean } = {}): void {
  scene.background = canvasTexture(2, 256, (ctx) => {
    const sky = ctx.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0, COLOURS.skyTop);
    sky.addColorStop(1, COLOURS.horizon);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 2, 256);
  });
  scene.fog = new THREE.Fog(COLOURS.horizon, 160, 900);
  scene.add(new THREE.HemisphereLight('#d7ebff', '#46703a', 1.6));
  const sun = new THREE.DirectionalLight('#fff3df', 2.2);
  sun.position.set(-80, 140, -60);
  scene.add(sun);

    const rough = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000),
      new THREE.MeshLambertMaterial({
        map: (() => {
          const t = canvasTexture(128, 128, (ctx) => {
            ctx.fillStyle = COLOURS.rough;
            ctx.fillRect(0, 0, 128, 128);
            const rnd = random(7);
            for (let i = 0; i < 1400; i++) {
              ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
              ctx.fillRect(rnd() * 128, rnd() * 128, 2, 2);
            }
          });
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.repeat.set(300, 300);
          return t;
        })(),
      }),
    );
    rough.rotation.x = -Math.PI / 2;
    world.add(groundLayer(rough, 0));

    const length = 480;
    const stripes = canvasTexture(64, 4, (ctx) => {
      ctx.fillStyle = COLOURS.fairwayLight;
      ctx.fillRect(0, 0, 32, 4);
      ctx.fillStyle = COLOURS.fairwayDark;
      ctx.fillRect(32, 0, 32, 4);
    });
    stripes.wrapS = THREE.RepeatWrapping;
    stripes.repeat.set(length / 24, 1);
    const fairway = new THREE.Mesh(new THREE.PlaneGeometry(length, 48), new THREE.MeshLambertMaterial({ map: stripes }));
    fairway.rotation.x = -Math.PI / 2;
    fairway.position.set(length / 2 - 15, 0, 0);
    if (options.fairway !== false) world.add(groundLayer(fairway, 1));

    const tee = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshLambertMaterial({ color: COLOURS.tee }));
    tee.rotation.x = -Math.PI / 2;
    tee.position.set(0, 0, 0);
    world.add(groundLayer(tee, 2));

    const rnd = random(1934);
    const spots: THREE.Matrix4[] = [];
    for (const sideSign of [-1, 1]) {
      for (let x = -60; x < 560; x += 7 + rnd() * 6) {
        for (const row of [0, 1]) {
          const z = sideSign * (40 + row * 16 + rnd() * 14);
          const s = 0.75 + rnd() * 0.7;
          spots.push(new THREE.Matrix4().compose(
            new THREE.Vector3(x + rnd() * 5, 0, z),
            new THREE.Quaternion(),
            new THREE.Vector3(s, s * (0.9 + rnd() * 0.5), s),
          ));
        }
      }
    }
    const crown = new THREE.ConeGeometry(3.4, 12, 7).translate(0, 9, 0);
    const trunk = new THREE.CylinderGeometry(0.35, 0.45, 3.2, 6).translate(0, 1.6, 0);
    for (const [geometry, colour] of [[crown, COLOURS.pine], [trunk, COLOURS.trunk]] as const) {
      const trees = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ color: colour }), spots.length);
      spots.forEach((m, i) => trees.setMatrixAt(i, m));
      world.add(trees);
    }

    const bushes = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1.3, 0),
      new THREE.MeshLambertMaterial({ color: COLOURS.azalea }),
      60,
    );
    for (let i = 0; i < 60; i++) {
      const sideSign = i % 2 === 0 ? -1 : 1;
      const s = 0.7 + rnd() * 0.8;
      bushes.setMatrixAt(i, new THREE.Matrix4().compose(
        new THREE.Vector3(-30 + rnd() * 180, 0.6 * s, sideSign * (33 + rnd() * 5)),
        new THREE.Quaternion(),
        new THREE.Vector3(s * 1.6, s, s * 1.2),
      ));
    }
    world.add(bushes);
  }

/** Yardage posts every 50 units either side of the fairway, labelled in the chosen units. */
export function buildMarkers(group: THREE.Group, system: UnitSystem): void {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
          o.geometry.dispose();
          const material = o.material as THREE.Material & { map?: THREE.Texture | null };
          material.map?.dispose();
          material.dispose();
        }
      });
    }
    const distance = unitFor('distance', system);
    const font = getComputedStyle(document.documentElement).getPropertyValue('--display').trim();
    const post = new THREE.BoxGeometry(0.3, 1.4, 0.3).translate(0, 0.7, 0);
    for (let d = 50; d <= 400; d += 50) {
      const x = distance.toSI(d);
      for (const z of [-25.5, 25.5]) {
        const mesh = new THREE.Mesh(post, new THREE.MeshLambertMaterial({ color: COLOURS.marker }));
        mesh.position.set(x, 0, z);
        group.add(mesh);
      }
      const label = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: canvasTexture(256, 128, (ctx) => {
            ctx.fillStyle = COLOURS.marker;
            ctx.beginPath();
            ctx.roundRect(8, 16, 240, 96, 18);
            ctx.fill();
            ctx.fillStyle = COLOURS.markerText;
            ctx.font = `64px ${font}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${d}`, 128, 68);
          }),
          fog: true,
        }),
      );
      label.scale.set(6, 3, 1);
      label.position.set(x, 3.6, -25.5);
      group.add(label);
    }
  }

/** Green, fringe, a real cup, the depth plane with its hole, and a seven-foot flagstick with a yellow flag. */
export function buildHole(hole: HoleLayout, options: { fairway?: boolean } = {}): THREE.Group {
  const group = new THREE.Group();
  const flat = (geometry: THREE.BufferGeometry, material: THREE.Material, order: number, x: number, z: number) => {
    const mesh = groundLayer(new THREE.Mesh(geometry, material), order);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0, z);
    group.add(mesh);
    return mesh;
  };
  if (options.fairway) {
    const { from, to, halfWidth } = hole.fairway;
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const mown = canvasTexture(64, 4, (ctx) => {
      ctx.fillStyle = COLOURS.fairwayLight;
      ctx.fillRect(0, 0, 32, 4);
      ctx.fillStyle = COLOURS.fairwayDark;
      ctx.fillRect(32, 0, 32, 4);
    });
    mown.wrapS = THREE.RepeatWrapping;
    mown.repeat.set(length / 24, 1);
    const strip = flat(new THREE.PlaneGeometry(length, halfWidth * 2), new THREE.MeshLambertMaterial({ map: mown }), 1, (from.x + to.x) / 2, (from.z + to.z) / 2);
    strip.rotation.z = -Math.atan2(to.z - from.z, to.x - from.x);
  }
  const g = hole.green;
  flat(new THREE.CircleGeometry(g.radius + 1.2, 64), new THREE.MeshLambertMaterial({ color: COLOURS.fringe }), 3, g.x, g.z);
  const stripes = canvasTexture(64, 4, (ctx) => {
    ctx.fillStyle = COLOURS.greenLight;
    ctx.fillRect(0, 0, 32, 4);
    ctx.fillStyle = COLOURS.greenDark;
    ctx.fillRect(32, 0, 32, 4);
  });
  stripes.wrapS = stripes.wrapT = THREE.RepeatWrapping;
  stripes.repeat.set(g.radius / 2.5, 1);
  flat(new THREE.CircleGeometry(g.radius, 64), new THREE.MeshLambertMaterial({ map: stripes }), 4, g.x, g.z);
  flat(new THREE.RingGeometry(CUP_RADIUS, CUP_RADIUS + 0.01, 32), new THREE.MeshBasicMaterial({ color: '#f2f2f2' }), 5, hole.pin.x, hole.pin.z);

  const outline = new THREE.Shape();
  outline.moveTo(-3000, -3000);
  outline.lineTo(3000, -3000);
  outline.lineTo(3000, 3000);
  outline.lineTo(-3000, 3000);
  outline.closePath();
  const cutout = new THREE.Path();
  cutout.absarc(hole.pin.x, -hole.pin.z, CUP_RADIUS, 0, Math.PI * 2, true);
  outline.holes.push(cutout);
  const depth = new THREE.Mesh(new THREE.ShapeGeometry(outline, 48), new THREE.MeshBasicMaterial({ colorWrite: false }));
  depth.rotation.x = -Math.PI / 2;
  depth.renderOrder = -1;
  group.add(depth);

  const cupDepth = 0.1;
  const liner = new THREE.Mesh(
    new THREE.CylinderGeometry(CUP_RADIUS, CUP_RADIUS, cupDepth, 32, 1, true).translate(0, -cupDepth / 2, 0),
    new THREE.MeshLambertMaterial({ color: '#e9e9e9', side: THREE.BackSide }),
  );
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(CUP_RADIUS, 32).rotateX(-Math.PI / 2).translate(0, -cupDepth, 0), new THREE.MeshLambertMaterial({ color: '#3a2a1c' }));
  liner.position.set(hole.pin.x, 0, hole.pin.z);
  bottom.position.set(hole.pin.x, 0, hole.pin.z);
  group.add(liner, bottom);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0125, 0.0125, 2.13, 8).translate(0, 1.065, 0),
    new THREE.MeshLambertMaterial({ color: '#f3f1ea' }),
  );
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(0.5, 0);
  shape.lineTo(0.5, -0.35);
  shape.lineTo(0, -0.35);
  shape.closePath();
  const flag = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color: COLOURS.flag, side: THREE.DoubleSide, toneMapped: false }),
  );
  flag.position.set(0, 2.13, 0);
  const stick = new THREE.Group();
  stick.add(pole, flag);
  stick.position.set(hole.pin.x, 0, hole.pin.z);
  group.add(stick);
  return group;
}
