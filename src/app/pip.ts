import * as THREE from 'three';
import type { Vec3 } from '../physics/vec3.ts';
import { canvasTexture } from './scenery.ts';

/** What acts on the ball at one instant. Forces in N, velocities in m/s, spin in rad/s. */
export interface ForceSnapshot {
  readonly velocity: Vec3;
  readonly spin: Vec3;
  readonly gravity: Vec3;
  readonly drag?: Vec3;
  readonly lift?: Vec3;
  readonly wind?: Vec3;
  /** Ground reaction while the ball sits or rolls on the turf. */
  readonly normal?: Vec3;
  /** Turf friction or rolling resistance. */
  readonly friction?: Vec3;
  /** Bounce impulse just after an impact, N·s. */
  readonly impulse?: Vec3;
  readonly details: readonly (readonly [string, string])[];
}

const NEWTON = 2.2;
const SPEED = 1 / 22;
const IMPULSE = 90;
// Real spin is 30 to 150 revolutions a second; showing it 40 times slower keeps it readable.
export const SPIN_DISPLAY_SLOWDOWN = 40;

export const ARROWS = {
  velocity: { colour: '#1d2621', label: 'Velocity' },
  drag: { colour: '#c8102e', label: 'Drag' },
  lift: { colour: '#e0a800', label: 'Lift (Magnus)' },
  gravity: { colour: '#2f5fb3', label: 'Gravity' },
  wind: { colour: '#24a3b8', label: 'Wind' },
  normal: { colour: '#6b4fb8', label: 'Ground push' },
  friction: { colour: '#b85a1f', label: 'Turf friction' },
  impulse: { colour: '#e05a00', label: 'Bounce impulse' },
  spin: { colour: '#006747', label: 'Spin axis' },
} as const;

type ArrowKey = keyof typeof ARROWS;

/** A close-up of the ball with live force arrows, drawn into a corner of the main view. */
export class ForcesInset {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 4 / 3, 0.1, 100);
  private readonly ball: THREE.Mesh;
  private readonly arrows = new Map<ArrowKey, THREE.ArrowHelper>();

  constructor() {
    this.scene.background = new THREE.Color('#fffdf8');
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#c9d6c4', 2.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(3, 5, 4);
    this.scene.add(sun);

    const dimples = canvasTexture(512, 256, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 512, 256);
      ctx.fillStyle = '#d9ddd6';
      for (let y = 8; y < 256; y += 16) for (let x = (y / 16) % 2 ? 8 : 0; x < 512; x += 16) {
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.fillStyle = '#0b3b2c';
      ctx.fillRect(0, 122, 512, 12);
      ctx.fillRect(250, 0, 12, 256);
    });
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshStandardMaterial({ map: dimples, roughness: 0.45 }));
    this.scene.add(this.ball);

    const grid = new THREE.GridHelper(10, 10, '#c9d6c4', '#e4ece4');
    grid.position.y = -1;
    this.scene.add(grid);

    for (const [key, { colour }] of Object.entries(ARROWS) as [ArrowKey, { colour: string }][]) {
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, colour, 0.35, 0.2);
      arrow.visible = false;
      this.arrows.set(key, arrow);
      this.scene.add(arrow);
    }
    // Looking from the right of the target line, so downrange runs left to right as in the side chart.
    this.camera.position.set(2.2, 2.4, 13);
    this.camera.lookAt(0, 0, 0);
  }

  /** Spins the ball by the given real spin vector over a slice of shot time. */
  rotate(spin: Vec3, dt: number): void {
    const w = Math.hypot(spin.x, spin.y, spin.z);
    if (w < 1e-6 || dt === 0) return;
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(spin.x / w, spin.y / w, spin.z / w), (w * dt) / SPIN_DISPLAY_SLOWDOWN);
    this.ball.quaternion.premultiply(turn);
  }

  show(snapshot: ForceSnapshot): void {
    const set = (key: ArrowKey, v: Vec3 | undefined, scale: number, from = new THREE.Vector3()) => {
      const arrow = this.arrows.get(key)!;
      const length = v ? Math.hypot(v.x, v.y, v.z) * scale : 0;
      arrow.visible = length > 0.05;
      if (!arrow.visible || !v) return;
      const capped = Math.min(length, 4.2);
      const dir = new THREE.Vector3(v.x, v.y, v.z).normalize();
      arrow.position.copy(from.lengthSq() > 0 ? from : dir.clone().multiplyScalar(1.02));
      arrow.setDirection(dir);
      arrow.setLength(capped + 0.35, Math.min(0.35, capped * 0.5 + 0.1), 0.2);
    };
    set('velocity', snapshot.velocity, SPEED);
    set('drag', snapshot.drag, NEWTON);
    set('lift', snapshot.lift, NEWTON);
    set('gravity', snapshot.gravity, NEWTON);
    set('wind', snapshot.wind, SPEED * 3, new THREE.Vector3(-3.4, -0.6, 0));
    set('normal', snapshot.normal, NEWTON, new THREE.Vector3(0, -1, 0));
    set('friction', snapshot.friction, NEWTON, new THREE.Vector3(0, -1, 0));
    set('impulse', snapshot.impulse, IMPULSE, new THREE.Vector3(0, -1, 0));

    const s = snapshot.spin;
    const w = Math.hypot(s.x, s.y, s.z);
    const spinArrow = this.arrows.get('spin')!;
    spinArrow.visible = w > 1;
    if (spinArrow.visible) {
      const dir = new THREE.Vector3(s.x / w, s.y / w, s.z / w);
      spinArrow.position.copy(dir.clone().multiplyScalar(-1.7));
      spinArrow.setDirection(dir);
      spinArrow.setLength(3.4, 0.3, 0.18);
    }
  }

  /** Arrow keys currently drawn, for the legend. */
  visibleArrows(): ArrowKey[] {
    return [...this.arrows.entries()].filter(([, a]) => a.visible).map(([k]) => k);
  }
}
