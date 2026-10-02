import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Shot } from '../physics/ground.ts';
import type { Vec3 } from '../physics/vec3.ts';
import { unitFor, type UnitSystem } from './units.ts';

export type CameraMode = 'tee' | 'follow' | 'side' | 'above' | 'free';
export type Phase = 'Ready' | 'In flight' | 'Bouncing' | 'Rolling' | 'At rest';

// The ball and tracer are drawn many times real size so they stay visible 250 yards away.
const BALL_RADIUS = 0.3;
const TRACER_RADIUS = 0.22;
const SAMPLE_STEP = 1 / 60;
const GROUND_SPEEDUP = 2;

const COLOURS = {
  skyTop: '#5b97c9',
  horizon: '#dbe7ea',
  rough: '#3d7334',
  fairwayLight: '#5fae4f',
  fairwayDark: '#4f9b43',
  tee: '#6cbd5c',
  pine: '#1d4a2a',
  trunk: '#5a4330',
  azalea: '#d6457a',
  tracer: '#f4d35e',
  groundPath: '#ffffff',
  landing: '#c8102e',
  flag: '#f4d35e',
  marker: '#fffdf8',
  markerText: '#0b3b2c',
} as const;

// Small deterministic random generator so the trees grow in the same place every load.
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const toThree = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

// Thin near the tee, full width by about 50 m, so the tracer doesn't fill the tee camera's view.
function taperFromTee(geometry: THREE.TubeGeometry, curve: THREE.Curve<THREE.Vector3>): void {
  const { tubularSegments, radialSegments } = geometry.parameters;
  const position = geometry.attributes.position;
  const centre = new THREE.Vector3();
  const vertex = new THREE.Vector3();
  for (let i = 0; i <= tubularSegments; i++) {
    curve.getPointAt(i / tubularSegments, centre);
    const scale = Math.min(1, (0.03 + 0.004 * Math.hypot(centre.x, centre.z)) / TRACER_RADIUS);
    for (let j = 0; j <= radialSegments; j++) {
      const k = i * (radialSegments + 1) + j;
      vertex.fromBufferAttribute(position, k).sub(centre).multiplyScalar(scale).add(centre);
      position.setXYZ(k, vertex.x, vertex.y, vertex.z);
    }
  }
  position.needsUpdate = true;
}

/** The 3D range: a course, the shot's tracer, the ball and camera moves. */
export class CourseView {
  onPhase: (phase: Phase) => void = () => {};
  onCameraChange: (mode: CameraMode) => void = () => {};

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.5, 3000);
  private readonly controls: OrbitControls;
  private readonly ball: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private readonly landing: THREE.Mesh;
  private readonly flag: THREE.Group;
  private readonly markers = new THREE.Group();
  private tracer: THREE.Mesh | null = null;
  private groundPath: THREE.Line | null = null;

  private shot: Shot | null = null;
  private times: number[] = [];
  private points: THREE.Vector3[] = [];
  private flightSamples = 0;
  private arc: number[] = [];
  private system: UnitSystem | null = null;
  private mode: CameraMode = 'tee';
  private playing = false;
  private clock = 0;
  private lastFrame = 0;
  private frame = 0;
  private phase: Phase = 'Ready';
  private readonly followFrom = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = canvasTexture(2, 256, (ctx) => {
      const sky = ctx.createLinearGradient(0, 0, 0, 256);
      sky.addColorStop(0, COLOURS.skyTop);
      sky.addColorStop(1, COLOURS.horizon);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, 2, 256);
    });
    this.scene.fog = new THREE.Fog(COLOURS.horizon, 160, 900);
    this.scene.add(new THREE.HemisphereLight('#d7ebff', '#46703a', 1.6));
    const sun = new THREE.DirectionalLight('#fff3df', 2.2);
    sun.position.set(-80, 140, -60);
    this.scene.add(sun);

    this.buildCourse();
    this.scene.add(this.markers);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 24, 16),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35 }),
    );
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 24),
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.3, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.landing = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.6, 40),
      new THREE.MeshBasicMaterial({ color: COLOURS.landing, side: THREE.DoubleSide, toneMapped: false }),
    );
    this.landing.rotation.x = -Math.PI / 2;
    this.flag = this.buildFlag();
    this.scene.add(this.ball, this.shadow, this.landing, this.flag);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 900;
    this.controls.addEventListener('start', () => {
      if (this.mode !== 'free') {
        this.mode = 'free';
        this.onCameraChange('free');
      }
    });
    this.controls.addEventListener('change', () => this.requestRender());

    new ResizeObserver(() => this.resize(container)).observe(container);
    this.resize(container);
  }

  /** Shows a shot at rest, with its full tracer. Call replay() to animate it. */
  setShot(shot: Shot, system: UnitSystem): void {
    if (system !== this.system) {
      this.system = system;
      void document.fonts.ready.then(() => this.buildMarkers(system));
    }
    this.shot = shot;
    this.sample(shot);
    this.buildTracer();
    this.playing = false;
    this.clock = shot.duration;
    this.landing.position.set(shot.flight.landingPosition.x, shot.flight.landingPosition.y + 0.03, shot.flight.landingPosition.z);
    this.landing.visible = shot.flight.landed;
    this.flag.position.copy(toThree(shot.restPosition));
    this.showAt(shot.duration);
    this.setPhase('At rest');
    this.frameCamera(true);
  }

  replay(): void {
    if (!this.shot) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.showAt(this.shot.duration);
      return;
    }
    this.playing = true;
    this.clock = 0;
    this.lastFrame = performance.now();
    if (this.mode === 'follow') this.followFrom.set(-10, 3, 0);
    this.requestRender();
  }

  setCamera(mode: CameraMode): void {
    this.mode = mode;
    this.frameCamera(true);
  }

  private resize(container: HTMLElement): void {
    const { clientWidth: w, clientHeight: h } = container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private requestRender(): void {
    if (this.frame === 0) this.frame = requestAnimationFrame((now) => this.tick(now));
  }

  private tick(now: number): void {
    this.frame = 0;
    if (this.playing && this.shot) {
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.clock += dt * (this.clock < this.shot.flight.flightTime ? 1 : GROUND_SPEEDUP);
      if (this.clock >= this.shot.duration) {
        this.clock = this.shot.duration;
        this.playing = false;
      }
      this.showAt(this.clock);
      const phase = this.shot.phaseAt(this.clock);
      this.setPhase(!this.playing ? 'At rest' : phase === 'flight' ? 'In flight' : phase === 'bounce' ? 'Bouncing' : 'Rolling');
      if (this.mode === 'follow') this.frameCamera(false);
    }
    this.renderer.render(this.scene, this.camera);
    if (this.playing) this.requestRender();
  }

  private setPhase(phase: Phase): void {
    if (phase !== this.phase) {
      this.phase = phase;
      this.onPhase(phase);
    }
  }

  private sample(shot: Shot): void {
    this.times = [];
    this.points = [];
    for (let t = 0; t < shot.duration; t += SAMPLE_STEP) {
      this.times.push(t);
      this.points.push(toThree(shot.positionAt(t)));
    }
    this.times.push(shot.duration);
    this.points.push(toThree(shot.restPosition));
    this.flightSamples = Math.max(2, this.times.findIndex((t) => t >= shot.flight.flightTime) + 1 || this.times.length);
    this.arc = [0];
    for (let i = 1; i < this.flightSamples; i++) this.arc.push(this.arc[i - 1] + this.points[i].distanceTo(this.points[i - 1]));
  }

  private buildTracer(): void {
    for (const old of [this.tracer, this.groundPath]) {
      if (!old) continue;
      this.scene.remove(old);
      old.geometry.dispose();
    }
    const flight = this.points.slice(0, this.flightSamples);
    if (flight.length >= 2 && this.arc[this.arc.length - 1] > 0.5) {
      const curve = new THREE.CatmullRomCurve3(flight, false, 'centripetal');
      const geometry = new THREE.TubeGeometry(curve, Math.min(600, flight.length * 2), TRACER_RADIUS, 6, false);
      taperFromTee(geometry, curve);
      this.tracer = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: COLOURS.tracer, toneMapped: false }));
      this.scene.add(this.tracer);
    } else {
      this.tracer = null;
    }
    const ground = this.points.slice(this.flightSamples - 1).map((p) => new THREE.Vector3(p.x, Math.max(p.y, 0) + 0.06, p.z));
    this.groundPath = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(ground),
      new THREE.LineBasicMaterial({ color: COLOURS.groundPath, transparent: true, opacity: 0.85 }),
    );
    this.scene.add(this.groundPath);
  }

  private showAt(t: number): void {
    if (!this.shot) return;
    const p = this.shot.positionAt(t);
    this.ball.position.set(p.x, p.y + BALL_RADIUS, p.z);
    this.shadow.position.set(p.x, 0.02, p.z);
    const lift = Math.min(1, p.y / 30);
    this.shadow.scale.setScalar(1 - 0.6 * lift);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.32 * (1 - 0.8 * lift);

    let index = this.times.findIndex((time) => time > t);
    if (index === -1) index = this.times.length;
    if (this.tracer) {
      const geometry = this.tracer.geometry as THREE.TubeGeometry;
      const total = this.arc[this.arc.length - 1];
      const fraction = index >= this.flightSamples ? 1 : this.arc[Math.max(0, index - 1)] / total;
      const segments = geometry.parameters.tubularSegments;
      geometry.setDrawRange(0, Math.floor(fraction * segments) * geometry.parameters.radialSegments * 6);
    }
    if (this.groundPath) this.groundPath.geometry.setDrawRange(0, Math.max(0, index - this.flightSamples + 1));
    this.landing.visible = this.shot.flight.landed && t >= this.shot.flight.flightTime;
    this.flag.visible = t >= this.shot.duration;
    this.requestRender();
  }

  private frameCamera(jump: boolean): void {
    if (!this.shot) return;
    const rest = this.shot.restPosition;
    const reach = Math.max(40, this.shot.total);
    const apex = this.shot.flight.apexPosition.y;
    const target = new THREE.Vector3();
    const position = new THREE.Vector3();

    switch (this.mode) {
      case 'tee':
        position.set(-10, 2.6, 0);
        target.set(reach * 0.55, 3, rest.z * 0.55);
        break;
      case 'side':
        position.set(reach * 0.5, reach * 0.3 + 20, reach * 0.7 + 30);
        target.set(reach * 0.5, apex * 0.3, 0);
        break;
      case 'above':
        position.set(reach * 0.5 - reach * 0.22, reach * 0.95, rest.z * 0.5);
        target.set(reach * 0.5, 0, rest.z * 0.5);
        break;
      case 'follow': {
        const ball = this.ball.position;
        const ahead = this.points[Math.min(this.points.length - 1, this.times.findIndex((t) => t > this.clock) + 20)] ?? toThree(rest);
        const direction = new THREE.Vector3(ahead.x - ball.x, 0, ahead.z - ball.z);
        if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0);
        direction.normalize();
        const desired = ball.clone().addScaledVector(direction, -12).add(new THREE.Vector3(0, 3.5, 0));
        if (jump || !this.playing) this.followFrom.copy(desired);
        else this.followFrom.lerp(desired, 0.08);
        position.copy(this.followFrom);
        target.copy(ball).addScaledVector(direction, 20);
        break;
      }
      case 'free':
        return;
    }
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.controls.update();
    this.requestRender();
  }

  private buildCourse(): void {
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
    this.scene.add(rough);

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
    this.scene.add(fairway);

    const tee = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshLambertMaterial({ color: COLOURS.tee }));
    tee.rotation.x = -Math.PI / 2;
    tee.position.set(0, 0.02, 0);
    this.scene.add(tee);

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
      this.scene.add(trees);
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
    this.scene.add(bushes);
  }

  private buildMarkers(system: UnitSystem): void {
    for (const child of [...this.markers.children]) {
      this.markers.remove(child);
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
        this.markers.add(mesh);
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
      this.markers.add(label);
    }
    this.requestRender();
  }

  private buildFlag(): THREE.Group {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8).translate(0, 1.3, 0),
      new THREE.MeshLambertMaterial({ color: '#f3f1ea' }),
    );
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(1.1, -0.35);
    shape.lineTo(0, -0.7);
    shape.closePath();
    const cloth = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color: COLOURS.flag, side: THREE.DoubleSide, toneMapped: false }),
    );
    cloth.position.set(0, 2.6, 0);
    group.add(pole, cloth);
    return group;
  }
}
