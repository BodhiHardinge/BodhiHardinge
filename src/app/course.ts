import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TOUR_BALL } from '../physics/ball.ts';
import type { ClubSpec } from '../physics/club.ts';
import { createContext, forceBreakdown, STANDARD_GRAVITY, type Environment, type FlightContext } from '../physics/dynamics.ts';
import type { Shot } from '../physics/ground.ts';
import type { HoleLayout } from '../physics/hole.ts';
import type { Swing } from '../physics/swing.ts';
import { toRpm } from '../physics/units.ts';
import { vec3, type Vec3 } from '../physics/vec3.ts';
import { Golfer } from './golfer.ts';
import { ARROWS, ForcesInset, SPIN_DISPLAY_SLOWDOWN, type ForceSnapshot } from './pip.ts';
import { buildHole, buildMarkers, buildRange, canvasTexture } from './scenery.ts';
import { unitFor, type UnitSystem } from './units.ts';

export type CameraMode = 'tee' | 'swing' | 'follow' | 'side' | 'above' | 'free';

export interface SceneInput {
  readonly shot: Shot;
  /** The same shot in standard conditions, drawn as a ghost; null when conditions are standard. */
  readonly ghost: Shot | null;
  readonly hole: HoleLayout;
  readonly swing: Swing;
  readonly club: ClubSpec;
  readonly env: Environment;
  readonly system: UnitSystem;
  /** Landing points of the selected club's recorded shots, m. */
  readonly dispersion: readonly { readonly x: number; readonly z: number }[];
}

const BALL_RADIUS = TOUR_BALL.diameter / 2;
const TRACER_RADIUS = 0.2;
const SAMPLE_STEP = 1 / 60;
const IMPULSE_WINDOW = 0.15;

const toThree = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

// Thin near the tee, full width by about 50 m, so the tracer doesn't fill the tee camera's view.
function taperFromTee(geometry: THREE.TubeGeometry, curve: THREE.Curve<THREE.Vector3>): void {
  const { tubularSegments, radialSegments } = geometry.parameters;
  const position = geometry.attributes.position;
  const centre = new THREE.Vector3();
  const vertex = new THREE.Vector3();
  for (let i = 0; i <= tubularSegments; i++) {
    curve.getPointAt(i / tubularSegments, centre);
    const scale = Math.min(1, (0.02 + 0.004 * Math.hypot(centre.x, centre.z)) / TRACER_RADIUS);
    for (let j = 0; j <= radialSegments; j++) {
      const k = i * (radialSegments + 1) + j;
      vertex.fromBufferAttribute(position, k).sub(centre).multiplyScalar(scale).add(centre);
      position.setXYZ(k, vertex.x, vertex.y, vertex.z);
    }
  }
  position.needsUpdate = true;
}

interface Tracer {
  readonly mesh: THREE.Mesh | null;
  readonly ground: THREE.Line;
  readonly times: number[];
  readonly arc: number[];
  readonly flightSamples: number;
}

/** The 3D range: golfer, ball at true size, tracer, hole, a standard-conditions ghost and a forces inset. */
export class CourseView {
  onPhase: (phase: string) => void = () => {};
  onCameraChange: (mode: CameraMode) => void = () => {};

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 3000);
  private readonly controls: OrbitControls;
  private readonly container: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly ball: THREE.Mesh;
  private readonly locator: THREE.Sprite;
  private readonly landing: THREE.Mesh;
  private readonly markers = new THREE.Group();
  private readonly golfer = new Golfer();
  private readonly inset = new ForcesInset();
  private holeGroup: THREE.Group | null = null;
  private dispersion: THREE.InstancedMesh | null = null;
  private tracer: Tracer | null = null;
  private ghostTracer: Tracer | null = null;

  private input: SceneInput | null = null;
  private context: FlightContext | null = null;
  private impacts: number[] = [];
  private system: UnitSystem | null = null;
  private holeKey = '';
  private mode: CameraMode = 'tee';
  private playing = false;
  private speed = 1;
  private clock = 0;
  private lastFrame = 0;
  private frame = 0;
  private phase = '';
  private showForces = true;
  private showGhost = true;
  private readonly followFrom = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, container: HTMLElement, legend: HTMLElement) {
    this.container = container;
    this.legend = legend;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    buildRange(this.scene);
    this.scene.add(this.markers, this.golfer.group);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 24, 16),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35 }),
    );
    // The ball is drawn at its true 42.7 mm size; this ring only marks where it is on screen.
    this.locator = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: canvasTexture(64, 64, (ctx) => {
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(32, 32, 26, 0, 2 * Math.PI);
          ctx.stroke();
        }),
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
      }),
    );
    this.locator.scale.setScalar(0.028);
    this.landing = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.7, 40),
      new THREE.MeshBasicMaterial({ color: '#c8102e', side: THREE.DoubleSide, toneMapped: false }),
    );
    this.landing.rotation.x = -Math.PI / 2;
    this.scene.add(this.ball, this.locator, this.landing);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 900;
    this.controls.addEventListener('start', () => {
      if (this.mode !== 'free') {
        this.mode = 'free';
        this.onCameraChange('free');
      }
    });
    this.controls.addEventListener('change', () => this.requestRender());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /** Shows a new shot at rest. Call hit() to play the swing and flight. */
  setScene(input: SceneInput): void {
    this.input = input;
    this.context = createContext(TOUR_BALL, input.env);
    this.impacts = input.shot.impactTimes;
    if (input.system !== this.system) {
      this.system = input.system;
      void document.fonts.ready.then(() => {
        for (const child of [...this.markers.children]) this.markers.remove(child);
        buildMarkers(this.markers, input.system);
        this.requestRender();
      });
    }
    const key = `${input.hole.pin.x},${input.hole.pin.z}`;
    if (key !== this.holeKey) {
      this.holeKey = key;
      if (this.holeGroup) this.scene.remove(this.holeGroup);
      this.holeGroup = buildHole(input.hole);
      this.scene.add(this.holeGroup);
    }
    this.golfer.setClub(input.club);
    this.tracer = this.replaceTracer(this.tracer, input.shot, '#f4d35e', 1);
    this.ghostTracer = input.ghost ? this.replaceTracer(this.ghostTracer, input.ghost, '#ffffff', 0.55) : this.replaceTracer(this.ghostTracer, null, '', 0);
    this.buildDispersion(input.dispersion);
    this.landing.position.set(input.shot.flight.landingPosition.x, 0.03, input.shot.flight.landingPosition.z);
    this.playing = false;
    this.clock = input.shot.duration;
    this.showAt(this.clock, 0);
    this.frameCamera(true);
  }

  /** Plays the swing, strike, flight, bounces and roll from address. */
  hit(): void {
    if (!this.input) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.showAt(this.input.shot.duration, 0);
      return;
    }
    this.playing = true;
    this.clock = this.input.swing.start;
    this.lastFrame = performance.now();
    this.frameCamera(true);
    this.requestRender();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  /** Changes the camera without touching playback. */
  setCamera(mode: CameraMode): void {
    this.mode = mode;
    this.frameCamera(true);
  }

  setLayers(forces: boolean, ghost: boolean): void {
    this.showForces = forces;
    this.showGhost = ghost;
    this.legend.hidden = !forces;
    this.showAt(this.clock, 0);
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
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
    if (this.playing && this.input) {
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000) * this.speed;
      this.lastFrame = now;
      this.clock = Math.min(this.input.shot.duration, this.clock + dt);
      if (this.clock >= this.input.shot.duration) this.playing = false;
      this.showAt(this.clock, dt);
      if (this.mode === 'follow') this.frameCamera(false);
    }
    this.draw();
    if (this.playing) this.requestRender();
  }

  private draw(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.render(this.scene, this.camera);
    if (!this.showForces) return;
    const inset = this.insetRect(w, h);
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(inset.x, inset.y, inset.w, inset.h);
    this.renderer.setViewport(inset.x, inset.y, inset.w, inset.h);
    this.inset.camera.aspect = inset.w / inset.h;
    this.inset.camera.updateProjectionMatrix();
    this.renderer.render(this.inset.scene, this.inset.camera);
    this.renderer.setScissorTest(false);
  }

  // Bottom-left corner, matching the .pip overlay in the stylesheet.
  private insetRect(w: number, h: number) {
    const width = Math.round(Math.min(320, w * (w < 600 ? 0.62 : 0.42)));
    const height = Math.round(Math.min(width * 0.72, h * 0.55));
    return { x: 10, y: 10, w: width, h: height };
  }

  private replaceTracer(old: Tracer | null, shot: Shot | null, colour: string, opacity: number): Tracer | null {
    if (old) {
      if (old.mesh) {
        this.scene.remove(old.mesh);
        old.mesh.geometry.dispose();
      }
      this.scene.remove(old.ground);
      old.ground.geometry.dispose();
    }
    if (!shot) return null;
    const times: number[] = [];
    const points: THREE.Vector3[] = [];
    for (let t = 0; t < shot.duration; t += SAMPLE_STEP) {
      times.push(t);
      points.push(toThree(shot.positionAt(t)).setY(shot.positionAt(t).y + BALL_RADIUS));
    }
    times.push(shot.duration);
    points.push(toThree(shot.restPosition).setY(BALL_RADIUS));
    const end = times.findIndex((t) => t >= shot.flight.flightTime);
    const flightSamples = Math.max(2, end === -1 ? times.length : end + 1);
    const arc = [0];
    for (let i = 1; i < flightSamples; i++) arc.push(arc[i - 1] + points[i].distanceTo(points[i - 1]));

    let mesh: THREE.Mesh | null = null;
    const flight = points.slice(0, flightSamples);
    if (arc[arc.length - 1] > 0.5) {
      const curve = new THREE.CatmullRomCurve3(flight, false, 'centripetal');
      const geometry = new THREE.TubeGeometry(curve, Math.min(600, flight.length * 2), TRACER_RADIUS, 6, false);
      taperFromTee(geometry, curve);
      mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: colour, toneMapped: false, transparent: opacity < 1, opacity }));
      this.scene.add(mesh);
    }
    const ground = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points.slice(flightSamples - 1).map((p) => p.clone().setY(Math.max(p.y, 0.05)))),
      new THREE.LineBasicMaterial({ color: colour === '#f4d35e' ? '#ffffff' : colour, transparent: true, opacity: 0.85 * opacity }),
    );
    this.scene.add(ground);
    return { mesh, ground, times, arc, flightSamples };
  }

  private revealTracer(tracer: Tracer | null, t: number, visible: boolean): void {
    if (!tracer) return;
    let index = tracer.times.findIndex((time) => time > t);
    if (index === -1) index = tracer.times.length;
    if (t < 0) index = 0;
    if (tracer.mesh) {
      tracer.mesh.visible = visible;
      const geometry = tracer.mesh.geometry as THREE.TubeGeometry;
      const total = tracer.arc[tracer.arc.length - 1];
      const fraction = index >= tracer.flightSamples ? 1 : tracer.arc[Math.max(0, index - 1)] / total;
      geometry.setDrawRange(0, Math.floor(fraction * geometry.parameters.tubularSegments) * geometry.parameters.radialSegments * 6);
    }
    tracer.ground.visible = visible;
    tracer.ground.geometry.setDrawRange(0, Math.max(0, index - tracer.flightSamples + 1));
  }

  private buildDispersion(points: SceneInput['dispersion']): void {
    if (this.dispersion) {
      this.scene.remove(this.dispersion);
      this.dispersion.geometry.dispose();
      this.dispersion = null;
    }
    if (points.length === 0) return;
    this.dispersion = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.45, 12).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false }),
      points.length,
    );
    points.forEach((p, i) => this.dispersion!.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, 0.04, p.z)));
    this.scene.add(this.dispersion);
  }

  private showAt(t: number, dt: number): void {
    const input = this.input;
    if (!input) return;
    const { shot, swing } = input;
    this.golfer.update(swing.poseAt(Math.min(Math.max(t, swing.start), swing.end)));

    const p = t < 0 ? vec3(0, 0, 0) : shot.positionAt(t);
    const sunk = shot.holed && t >= shot.duration;
    this.ball.position.set(p.x, sunk ? -0.03 : p.y + BALL_RADIUS, p.z);
    this.locator.position.copy(this.ball.position);
    this.locator.visible = !sunk;
    this.revealTracer(this.tracer, t, true);
    this.revealTracer(this.ghostTracer, t, this.showGhost);
    this.landing.visible = shot.flight.landed && t >= shot.flight.flightTime;

    this.setPhase(this.phaseAt(t));
    if (this.showForces) {
      const snapshot = this.forcesAt(t);
      this.inset.rotate(snapshot.spin, dt);
      this.inset.show(snapshot);
      this.showLegend(snapshot);
    }
    this.requestRender();
  }

  private phaseAt(t: number): string {
    const { shot, swing } = this.input!;
    if (t >= shot.duration) return shot.holed ? 'Holed!' : this.playing ? 'Rolling' : 'At rest';
    if (t < swing.start + 0.6) return 'Address';
    if (t < -swing.downswing) return 'Backswing';
    if (t < 0) return 'Downswing';
    if (t < 0.06) return 'Impact';
    const phase = shot.phaseAt(t);
    return phase === 'flight' ? 'In flight' : phase === 'bounce' ? 'Bouncing' : 'Rolling';
  }

  private setPhase(phase: string): void {
    if (phase !== this.phase) {
      this.phase = phase;
      this.onPhase(phase);
    }
  }

  private forcesAt(t: number): ForceSnapshot {
    const { shot } = this.input!;
    const mass = TOUR_BALL.mass;
    const weight = vec3(0, -mass * STANDARD_GRAVITY, 0);
    const support = vec3(0, mass * STANDARD_GRAVITY, 0);
    if (t < 0) {
      return { velocity: vec3(0, 0, 0), spin: vec3(0, 0, 0), gravity: weight, normal: support, details: [['Status', 'On the tee']] };
    }
    const state = shot.airStateAt(t);
    const impact = this.impacts.find((ti) => t >= ti && t < ti + IMPULSE_WINDOW);
    const impulse =
      impact === undefined
        ? undefined
        : (() => {
            const before = shot.velocityAt(impact - 0.01);
            const after = shot.velocityAt(impact + 0.01);
            return vec3(mass * (after.x - before.x), mass * (after.y - before.y), mass * (after.z - before.z));
          })();
    if (state && this.context) {
      const f = forceBreakdown(this.context, state);
      const velocity = vec3(state[3], state[4], state[5]);
      const spin = vec3(state[6], state[7], state[8]);
      const n = (v: Vec3) => `${Math.hypot(v.x, v.y, v.z).toFixed(2)} N`;
      const speed = unitFor('speed', this.system ?? 'imperial');
      return {
        velocity, spin, gravity: f.gravity, drag: f.drag, lift: f.lift, impulse,
        wind: Math.hypot(f.wind.x, f.wind.z) > 0.05 ? f.wind : undefined,
        details: [
          ['Speed', `${speed.fromSI(Math.hypot(velocity.x, velocity.y, velocity.z)).toFixed(1)} ${speed.label}`],
          ['Spin', `${toRpm(Math.hypot(spin.x, spin.y, spin.z)).toFixed(0)} rpm`],
          ['Drag', `${n(f.drag)}  Cd ${f.dragCoefficient.toFixed(3)}`],
          ['Lift', `${n(f.lift)}  Cl ${f.liftCoefficient.toFixed(3)}`],
          ['Gravity', n(f.gravity)],
          ['Spin ratio', f.spinRatio.toFixed(3)],
          ['Reynolds', `${(f.reynolds / 1000).toFixed(0)}k`],
        ],
      };
    }
    // On the ground: rolling spin follows the speed, friction opposes the motion.
    const velocity = shot.velocityAt(t);
    const speed = Math.hypot(velocity.x, velocity.z);
    const later = shot.velocityAt(Math.min(shot.duration, t + 0.05));
    const slowing = (speed - Math.hypot(later.x, later.z)) / 0.05;
    const friction = speed > 0.01 ? vec3((-mass * slowing * velocity.x) / speed, 0, (-mass * slowing * velocity.z) / speed) : undefined;
    const spin = vec3(velocity.z / BALL_RADIUS, 0, -velocity.x / BALL_RADIUS);
    const units = unitFor('speed', this.system ?? 'imperial');
    return {
      velocity, spin, gravity: weight, normal: support, friction, impulse,
      details: [
        ['Status', impulse ? 'Bouncing' : speed > 0.01 ? 'Rolling' : 'At rest'],
        ['Speed', `${units.fromSI(Math.hypot(velocity.x, velocity.y, velocity.z)).toFixed(1)} ${units.label}`],
        ['Spin', `${toRpm(Math.hypot(spin.x, spin.z)).toFixed(0)} rpm`],
      ],
    };
  }

  private showLegend(snapshot: ForceSnapshot): void {
    const rows = this.inset
      .visibleArrows()
      .map((key) => `<li><i style="background:${ARROWS[key].colour}"></i>${ARROWS[key].label}</li>`)
      .join('');
    const details = snapshot.details.map(([k, v]) => `<li><b>${k}</b> ${v}</li>`).join('');
    this.legend.innerHTML = `<h3>Forces on the ball</h3><ul class="pip-keys">${rows}</ul><ul class="pip-values">${details}</ul><p>Spin shown ${SPIN_DISPLAY_SLOWDOWN}x slower</p>`;
  }

  private frameCamera(jump: boolean): void {
    const input = this.input;
    if (!input) return;
    const { shot } = input;
    const rest = shot.restPosition;
    const reach = Math.max(40, shot.total, input.hole.pin.x);
    const apex = shot.flight.apexPosition.y;
    const target = new THREE.Vector3();
    const position = new THREE.Vector3();

    switch (this.mode) {
      case 'tee':
        // Target below eye level: the orbit controls would lift a camera that looks upward.
        position.set(-9.5, 3, -1.0);
        target.set(reach * 0.5, 0, rest.z * 0.5);
        break;
      case 'swing':
        position.set(0.3, 1.15, 2.6);
        target.set(0, 0.85, -1.0);
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
        const ahead = this.clock < 0 ? new THREE.Vector3(30, 0, 0) : toThree(shot.positionAt(Math.min(shot.duration, this.clock + 0.4)));
        const direction = new THREE.Vector3(ahead.x - ball.x, 0, ahead.z - ball.z);
        if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0);
        direction.normalize();
        const desired = ball.clone().addScaledVector(direction, -10).add(new THREE.Vector3(0, 3, 0));
        if (jump) this.followFrom.copy(desired);
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
}
