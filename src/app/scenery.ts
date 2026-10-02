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
  greenLight: '#7cc964',
  greenDark: '#72c05b',
  fringe: '#5fb04d',
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

/** Sky, light, rough, striped fairway, tee, pines and azaleas. */
export function buildRange(scene: THREE.Scene): void {
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
    scene.add(rough);

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
    fairway.position.set(length / 2 - 15, 0.01, 0);
    scene.add(fairway);

    const tee = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshLambertMaterial({ color: COLOURS.tee }));
    tee.rotation.x = -Math.PI / 2;
    tee.position.set(0, 0.02, 0);
    scene.add(tee);

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
      scene.add(trees);
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
    scene.add(bushes);
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

/** Green, fringe, cup and a seven-foot flagstick with a yellow flag. */
export function buildHole(hole: HoleLayout): THREE.Group {
  const group = new THREE.Group();
  const flat = (geometry: THREE.BufferGeometry, colour: string | THREE.Texture, y: number) => {
    const material = typeof colour === 'string' ? new THREE.MeshLambertMaterial({ color: colour }) : new THREE.MeshLambertMaterial({ map: colour });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    group.add(mesh);
    return mesh;
  };
  const g = hole.green;
  const fringe = flat(new THREE.CircleGeometry(g.radius + 1.2, 64), COLOURS.fringe, 0.015);
  fringe.position.set(g.x, 0.015, g.z);
  const stripes = canvasTexture(64, 4, (ctx) => {
    ctx.fillStyle = COLOURS.greenLight;
    ctx.fillRect(0, 0, 32, 4);
    ctx.fillStyle = COLOURS.greenDark;
    ctx.fillRect(32, 0, 32, 4);
  });
  stripes.wrapS = stripes.wrapT = THREE.RepeatWrapping;
  stripes.repeat.set(g.radius / 2.5, 1);
  const green = flat(new THREE.CircleGeometry(g.radius, 64), stripes, 0.02);
  green.position.set(g.x, 0.02, g.z);
  const cup = flat(new THREE.CircleGeometry(CUP_RADIUS, 24), '#0c0c0c', 0.024);
  cup.position.set(hole.pin.x, 0.024, hole.pin.z);
  const rim = flat(new THREE.RingGeometry(CUP_RADIUS, CUP_RADIUS + 0.012, 24), '#f2f2f2', 0.025);
  rim.position.set(hole.pin.x, 0.025, hole.pin.z);

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
