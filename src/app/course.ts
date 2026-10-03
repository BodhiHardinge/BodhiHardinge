import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TOUR_BALL } from '../physics/ball.ts';
import type { ClubSpec } from '../physics/club.ts';
import { createContext, forceBreakdown, STANDARD_GRAVITY, type Environment, type FlightContext } from '../physics/dynamics.ts';
import type { Shot } from '../physics/ground.ts';
import { holeInFrame, WORLD_FRAME, type Frame, type HoleLayout } from '../physics/hole.ts';
import type { Swing } from '../physics/swing.ts';
import { toRpm } from '../physics/units.ts';
import { vec3, type Vec3 } from '../physics/vec3.ts';
import { Golfer } from './golfer.ts';
import { ARROWS, ForcesInset, SPIN_DISPLAY_SLOWDOWN, type ForceSnapshot } from './pip.ts';
import { buildCup, buildHole, buildMarkers, buildRange, canvasTexture } from './scenery.ts';
import { TerrainView, type CourseScene } from './terrain-view.ts';
import { GreenRead } from './green-read.ts';
import type { Terrain } from '../physics/terrain.ts';
import { unitFor, type UnitSystem } from './units.ts';

export type CameraMode = 'tee' | 'swing' | 'follow' | 'landing' | 'green' | 'side' | 'above' | 'free';

export interface SceneInput {
  readonly shot: Shot;
  /** The same shot in standard conditions, drawn as a ghost; null when conditions are standard. */
  readonly ghost: Shot | null;
  /** The Tour average for the same club, flown in the same conditions; null when there is none. */
  readonly tour: Shot | null;
  /** Other recorded shots to show as faint trails. */
  readonly trails: readonly Shot[];
  readonly hole: HoleLayout;
  readonly swing: Swing;
  readonly club: ClubSpec;
  readonly env: Environment;
  readonly system: UnitSystem;
  /** Landing points of the selected club's recorded shots, m. */
  readonly dispersion: readonly { readonly x: number; readonly z: number }[];
  /** Where this shot is played from, in world coordinates: the shot itself is in this frame. Default: the tee. */
  readonly frame?: Frame;
  /** A shot drawn as a dotted line before the swing: what a perfect strike would do. */
  readonly preview?: Shot | null;
  /** Show the golfer at address, ready to swing, instead of the shot at rest. */
  readonly atAddress?: boolean;
  /** Height of the ground under the ball in world coordinates, m, when playing on a course. */
  readonly frameHeight?: number;
  /** The ground in the shot frame, for keeping cameras above it. */
  readonly terrain?: Terrain;
}

export interface CourseViewOptions {
  /** Yardage posts along the range. */
  readonly markers?: boolean;
  /** Draw the hole's own fairway instead of the range's long straight one. */
  readonly holeFairway?: boolean;
}

const BALL_RADIUS = TOUR_BALL.diameter / 2;
const TRACER_RADIUS = 0.2;
const SAMPLE_STEP = 1 / 60;
const IMPULSE_WINDOW = 0.15;
const DROP_TIME = 0.35;
const CUP_DEPTH = 0.1;

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
  /** Called when a hit has played through to the ball stopping. */
  onFinish: () => void = () => {};

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
  private tourTracer: Tracer | null = null;
  private readonly trailGroup = new THREE.Group();
  /** Ground, planting and the hole, moved so the current shot frame sits at the origin. */
  private readonly world = new THREE.Group();
  private readonly rangeGroup = new THREE.Group();
  private terrainView: TerrainView | null = null;
  private course: CourseScene | null = null;
  private readonly options: CourseViewOptions;
  private preview: THREE.Line | null = null;
  private aimLine: THREE.Line | null = null;
  private readonly keys = new Set<string>();

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
  private showTour = true;
  private showTrails = false;
  /** Where the ball was last frame, for carrying the follow camera along with it. */
  private readonly followBall = new THREE.Vector3();
  private readonly greenRead = new GreenRead();
  private readonly started = performance.now();

  constructor(canvas: HTMLCanvasElement, container: HTMLElement, legend: HTMLElement, options: CourseViewOptions = {}) {
    this.options = options;
    this.container = container;
    this.legend = legend;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    buildRange(this.scene, this.rangeGroup, { fairway: !options.holeFairway });
    this.world.add(this.rangeGroup);
    this.scene.add(this.world, this.markers, this.golfer.group, this.trailGroup);
    this.markers.visible = options.markers !== false;

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
    // Dragging or zooming adjusts the current camera without leaving it: Follow keeps following, and the next shot
    // reframes the chosen view. Only W A S D switch to free flight.
    this.controls.addEventListener('change', () => this.requestRender());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.listenForFlying();
  }

  // W/A/S/D fly like a game camera: forward and back along the view, strafe left and right; Q/E sink and rise.
  private listenForFlying(): void {
    const typing = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
    const flyKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
    window.addEventListener('keydown', (event) => {
      if (typing(event.target) || !flyKeys.has(event.code) || document.querySelector('dialog[open]')) return;
      if (event.code.startsWith('Key')) event.preventDefault();
      this.keys.add(event.code);
      if (this.mode !== 'free' && event.code.startsWith('Key')) {
        this.mode = 'free';
        this.onCameraChange('free');
      }
      this.lastFrame = performance.now();
      this.requestRender();
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private fly(dt: number): void {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(forward);
    if (this.keys.has('KeyS')) move.sub(forward);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('KeyE')) move.y += 1;
    if (this.keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() === 0) return;
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    move.normalize().multiplyScalar((fast ? 60 : 15) * dt);
    const floor = this.groundAt(this.camera.position.x + move.x, this.camera.position.z + move.z) + 0.3;
    if (this.camera.position.y + move.y < floor) move.y = floor - this.camera.position.y;
    this.camera.position.add(move);
    this.controls.target.add(move);
    this.controls.update();
  }

  /** Replaces the driving range with a real course's terrain. */
  setCourse(course: CourseScene): void {
    if (this.terrainView) {
      this.world.remove(this.terrainView.group);
      this.terrainView.dispose();
    }
    this.course = course;
    this.holeKey = '';
    this.terrainView = new TerrainView(course);
    this.world.add(this.terrainView.group, this.greenRead.group);
    this.rangeGroup.visible = false;
    this.scene.fog = new THREE.Fog('#dbe7ea', 500, 3000);
    this.camera.far = 6000;
    this.camera.near = 0.05;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = 2500;
  }

  /** Full terrain detail around a region of the course (world coordinates), e.g. the hole being played. */
  focusCourse(x0: number, z0: number, x1: number, z1: number): void {
    this.terrainView?.focus(x0, z0, x1, z1);
    this.requestRender();
  }

  /**
   * Green reading: contours and flowing slope arrows for one green (outline in world coordinates). Pass null to
   * hide it.
   */
  setGreenRead(green: readonly (readonly [number, number])[] | null): void {
    if (green && this.course) {
      this.greenRead.build(green, (x, z) => this.course!.height(x, z));
      this.greenRead.group.visible = true;
    } else {
      this.greenRead.group.visible = false;
    }
    this.requestRender();
  }

  /** Ground height in the current shot frame, or 0 on the range. */
  private groundAt(x: number, z: number): number {
    return this.input?.terrain ? this.input.terrain.height(x, z) : 0;
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
    const key = `${input.hole.pin.x},${input.hole.pin.z},${input.hole.fairway.from.x},${input.hole.fairway.to.x}`;
    if (key !== this.holeKey) {
      this.holeKey = key;
      if (this.holeGroup) this.world.remove(this.holeGroup);
      this.holeGroup = this.course
        ? buildCup(input.hole.pin, this.course.height(input.hole.pin.x, input.hole.pin.z))
        : buildHole(input.hole, { fairway: this.options.holeFairway });
      this.world.add(this.holeGroup);
    }
    // Place the world so the shot frame's origin is at the scene origin, facing +x.
    const frame = input.frame ?? WORLD_FRAME;
    const c = Math.cos(frame.heading);
    const sn = Math.sin(frame.heading);
    this.world.rotation.y = frame.heading;
    this.world.position.set(-(frame.x * c + frame.z * sn), -(input.frameHeight ?? 0), -(-frame.x * sn + frame.z * c));
    this.buildPreview(input.preview ?? null);
    this.golfer.setClub(input.club);
    this.tracer = this.replaceTracer(this.tracer, input.shot, '#f4d35e', 1);
    this.ghostTracer = this.replaceTracer(this.ghostTracer, input.ghost, '#ffffff', 0.55);
    this.tourTracer = this.replaceTracer(this.tourTracer, input.tour, '#3d6fd1', 0.85);
    this.buildTrails(input.trails);
    this.buildDispersion(input.dispersion);
    const landed = input.shot.flight.landingPosition;
    this.landing.position.set(landed.x, landed.y + 0.03, landed.z);
    // Lie flat on sloping ground.
    const n = input.terrain ? input.terrain.normal(landed.x, landed.z) : { x: 0, y: 1, z: 0 };
    this.landing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(n.x, n.y, n.z));
    this.playing = false;
    this.clock = input.atAddress ? input.swing.start : this.endTime();
    this.showAt(this.clock, 0);
    this.frameCamera();
  }

  // A holed ball gets a moment to drop to the bottom of the cup.
  private endTime(): number {
    const shot = this.input!.shot;
    return shot.duration + (shot.holed ? DROP_TIME : 0);
  }

  /** Plays the swing, strike, flight, bounces and roll from address. */
  hit(): void {
    if (!this.input) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // No animation: show where the ball finished, and still tell the game the shot is over.
      this.clock = this.endTime();
      this.showAt(this.clock, 0);
      this.frameCamera();
      this.onFinish();
      return;
    }
    this.playing = true;
    this.clock = this.input.swing.start;
    this.lastFrame = performance.now();
    this.frameCamera();
    this.requestRender();
  }

  /** Jumps to the end of the shot being played. */
  skip(): void {
    if (!this.playing || !this.input) return;
    this.playing = false;
    this.clock = this.endTime();
    this.showAt(this.clock, 0);
    this.frameCamera();
    this.onFinish();
  }

  /** Chooses the captured golfer or the simple mannequin, and the putter head. */
  setGolfer(captured: boolean): void {
    this.golfer.useMotionCapture(captured);
    this.showAt(this.clock, 0);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  /** Changes the camera without touching playback. */
  setCamera(mode: CameraMode): void {
    this.mode = mode;
    this.frameCamera();
  }

  setLayers(forces: boolean, ghost: boolean, tour: boolean, trails: boolean): void {
    this.showForces = forces;
    this.showGhost = ghost;
    this.showTour = tour;
    this.showTrails = trails;
    this.trailGroup.visible = trails;
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
    if (this.keys.size > 0) {
      this.fly(Math.min(0.1, (now - this.lastFrame) / 1000));
      if (!this.playing) this.lastFrame = now;
    }
    if (this.playing && this.input) {
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000) * this.speed;
      this.lastFrame = now;
      const end = this.endTime();
      this.clock = Math.min(end, this.clock + dt);
      if (this.clock >= end) this.playing = false;
      this.showAt(this.clock, dt);
      if (this.mode === 'follow') this.carryFollow();
      if (!this.playing) this.onFinish();
    }
    const flowing = this.greenRead.active;
    if (flowing) this.greenRead.update((now - this.started) / 1000);
    this.draw();
    if (this.playing || this.keys.size > 0 || flowing) this.requestRender();
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
    points.push(toThree(shot.restPosition).setY(shot.restPosition.y + BALL_RADIUS));
    // A shot that barely moves still needs two points to draw.
    while (points.length < 2) {
      times.push(times[times.length - 1]);
      points.push(points[points.length - 1].clone());
    }
    const end = times.findIndex((t) => t >= shot.flight.flightTime);
    const flightSamples = Math.min(points.length, Math.max(2, end === -1 ? times.length : end + 1));
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
      new THREE.BufferGeometry().setFromPoints(points.slice(flightSamples - 1).map((p) => p.clone().setY(p.y - BALL_RADIUS + 0.03))),
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

  private buildPreview(shot: Shot | null): void {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview.geometry.dispose();
      this.preview = null;
    }
    if (!shot) return;
    const points: THREE.Vector3[] = [];
    for (let t = 0; t <= shot.duration; t += 1 / 30) {
      const p = shot.positionAt(t);
      points.push(new THREE.Vector3(p.x, p.y + 0.06, p.z));
    }
    const rest = shot.restPosition;
    points.push(new THREE.Vector3(rest.x, rest.y + 0.06, rest.z));
    this.preview = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({ color: '#ffffff', dashSize: 1.2, gapSize: 1.0, transparent: true, opacity: 0.6, toneMapped: false }),
    );
    this.preview.computeLineDistances();
    this.scene.add(this.preview);
    this.requestRender();
  }

  /**
   * The aim line: where the feet point, drawn along the ground from the ball (angle in the shot frame, rad, + right).
   * Pass null to hide it.
   */
  setAim(angle: number | null, length = 60): void {
    if (this.aimLine) {
      this.scene.remove(this.aimLine);
      this.aimLine.geometry.dispose();
      this.aimLine = null;
    }
    if (angle === null) return;
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    const points: THREE.Vector3[] = [];
    for (let d = 0.4; d <= length; d += 1) points.push(new THREE.Vector3(d * c, this.groundAt(d * c, d * sn) + 0.04, d * sn));
    // A short bar across the line where the feet are.
    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({ color: '#f4d35e', dashSize: 0.6, gapSize: 0.4, toneMapped: false }),
    );
    this.aimLine.computeLineDistances();
    this.scene.add(this.aimLine);
    this.requestRender();
  }

  /** Shows or hides the dotted perfect-strike line. */
  setPreviewVisible(visible: boolean): void {
    if (this.preview) this.preview.visible = visible;
    this.requestRender();
  }

  private buildTrails(shots: readonly Shot[]): void {
    for (const child of [...this.trailGroup.children]) {
      this.trailGroup.remove(child);
      (child as THREE.Line).geometry.dispose();
    }
    const material = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35 });
    for (const shot of shots) {
      const points: THREE.Vector3[] = [];
      for (let t = 0; t <= shot.duration; t += 0.05) {
        const p = shot.positionAt(t);
        points.push(new THREE.Vector3(p.x, p.y + 0.05, p.z));
      }
      this.trailGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    this.trailGroup.visible = this.showTrails;
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
    const st = Math.min(Math.max(t, swing.start), swing.end);
    this.golfer.update(swing.poseAt(st), st, swing);

    const p = t < 0 ? vec3(0, 0, 0) : shot.positionAt(Math.min(t, shot.duration));
    const drop = shot.holed ? Math.min(1, Math.max(0, (t - shot.duration) / DROP_TIME)) : 0;
    this.ball.position.set(p.x, p.y + BALL_RADIUS - drop * drop * (CUP_DEPTH - BALL_RADIUS), p.z);
    this.locator.position.copy(this.ball.position);
    this.locator.visible = drop < 1;
    this.revealTracer(this.tracer, t, true);
    this.revealTracer(this.ghostTracer, t, this.showGhost);
    this.revealTracer(this.tourTracer, t, this.showTour);
    // Putts and little hops have no landing worth marking.
    this.landing.visible = shot.flight.landed && shot.flight.carry > 3 && t >= shot.flight.flightTime;

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
    if (t >= shot.duration) return shot.holed ? 'Holed!' : 'At rest';
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
      return { velocity: vec3(0, 0, 0), spin: vec3(0, 0, 0), gravity: weight, normal: support, details: [['Status', 'At address']] };
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

  // Carries the follow camera along with the ball, preserving the angle and distance the player has set.
  private carryFollow(): void {
    const delta = this.ball.position.clone().sub(this.followBall);
    this.followBall.copy(this.ball.position);
    this.camera.position.add(delta);
    this.controls.target.add(delta);
    const floor = this.groundAt(this.camera.position.x, this.camera.position.z) + 1.2;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
    this.controls.update();
  }

  private frameCamera(): void {
    const input = this.input;
    if (!input) return;
    const { shot } = input;
    const rest = shot.restPosition;
    const pin = holeInFrame(input.hole, input.frame ?? WORLD_FRAME).pin;
    const reach = Math.max(40, shot.total, Math.min(pin.x, 320));
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
        position.set(reach * 0.58 - reach * 0.25, reach * 1.05, rest.z * 0.5);
        target.set(reach * 0.58, 0, rest.z * 0.5);
        break;
      case 'follow': {
        // Start behind the ball looking down the line; from then on the camera travels with the ball, keeping any
        // angle the player drags it to.
        const ball = this.ball.position;
        const ahead = this.clock < 0 ? new THREE.Vector3(30, 0, 0) : toThree(shot.positionAt(Math.min(shot.duration, this.clock + 0.4)));
        const direction = new THREE.Vector3(ahead.x - ball.x, 0, ahead.z - ball.z);
        if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0);
        direction.normalize();
        position.copy(ball).addScaledVector(direction, -10).add(new THREE.Vector3(0, 3, 0));
        target.copy(ball).addScaledVector(direction, 20);
        this.followBall.copy(ball);
        break;
      }
      case 'landing': {
        // Beside where the ball comes down, looking at the landing spot.
        const land = toThree(shot.flight.landingPosition);
        const u = new THREE.Vector3(land.x, 0, land.z);
        if (u.lengthSq() < 1) u.set(1, 0, 0);
        u.normalize();
        const side = new THREE.Vector3(-u.z, 0, u.x);
        const far = Math.max(8, Math.min(30, shot.flight.carry * 0.08));
        position.copy(land).addScaledVector(side, far).addScaledVector(u, -far * 0.4).setY(land.y + far * 0.35 + 1.5);
        target.copy(land).addScaledVector(u, 3);
        break;
      }
      case 'green': {
        // From beyond the flag looking back down the line of the shot, to read the green.
        const p = new THREE.Vector3(pin.x, input.terrain ? input.terrain.height(pin.x, pin.z) : 0, pin.z);
        const u = new THREE.Vector3(pin.x, 0, pin.z);
        const toPin = u.length();
        if (toPin < 1) u.set(1, 0, 0);
        u.normalize();
        const side = new THREE.Vector3(-u.z, 0, u.x);
        position.copy(p).addScaledVector(u, 14).addScaledVector(side, 5).setY(p.y + 6);
        target.copy(toPin < 40 ? p.clone().multiplyScalar(0.5) : p);
        break;
      }
      case 'free':
        return;
    }
    // Never put the camera inside a hill.
    position.y = Math.max(position.y, this.groundAt(position.x, position.z) + 1.2);
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.controls.update();
    this.requestRender();
  }
}
