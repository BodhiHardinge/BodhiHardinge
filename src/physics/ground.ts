import { TOUR_BALL, type Ball } from './ball.ts';
import { STANDARD_GRAVITY, type Environment } from './dynamics.ts';
import { flyFrom, simulateFlight, type FlightResult, type FlightOptions } from './flight.ts';
import { dropsIn, type HoleLayout } from './hole.ts';
import { FlatTerrain, type Terrain } from './terrain.ts';
import type { Surface } from './surfaces.ts';
import type { LaunchConditions } from './launch.ts';
import type { Trajectory } from './trajectory.ts';
import { vec3, type Vec3 } from './vec3.ts';

const UP: Vec3 = vec3(0, 1, 0);

export { SURFACES, type Surface, type SurfaceKey } from './surfaces.ts';

/** Normal coefficient of restitution of a ball on turf (Penner 2002), scaled by firmness. */
export function turfRestitution(surface: Surface, normalSpeed: number): number {
  const v = Math.abs(normalSpeed);
  const e = v <= 20 ? 0.51 - 0.0375 * v + 0.000903 * v * v : 0.12;
  return Math.min(0.85, Math.max(0.05, e * surface.firmness));
}

/** Pitch-mark angle that tilts the effective surface back toward the golfer (Penner 2002), rad. */
export function craterAngle(surface: Surface, speed: number, landingAngle: number): number {
  const deg = 15.4 * (speed / 18.6) * (((landingAngle * 180) / Math.PI) / 44.4) * surface.softness;
  return (Math.min(30, Math.max(0, deg)) * Math.PI) / 180;
}

const MIN_HOP_SPEED = 0.6;
const MAX_BOUNCES = 15;

/** One rigid-sphere impact with the turf, whose undisturbed surface faces `ground`. Returns the state just after. */
export function bounce(state: Float64Array, surface: Surface, ball: Ball, ground: Vec3 = UP): Float64Array {
  const radius = ball.diameter / 2;
  const [vx, vy, vz, ox, oy, oz] = [state[3], state[4], state[5], state[6], state[7], state[8]];
  // Split the incoming velocity into parts along and across the ground.
  const into = vx * ground.x + vy * ground.y + vz * ground.z;
  let tx = vx - into * ground.x;
  let ty = vy - into * ground.y;
  let tz = vz - into * ground.z;
  const along = Math.hypot(tx, ty, tz);
  if (along > 1e-9) {
    tx /= along;
    ty /= along;
    tz /= along;
  } else {
    tx = 1;
    ty = 0;
    tz = 0;
  }
  const theta = craterAngle(surface, Math.hypot(vx, vy, vz), Math.atan2(-into, along));

  // The pitch mark tilts the effective surface back toward where the ball came from.
  const nx = Math.cos(theta) * ground.x - Math.sin(theta) * tx;
  const ny = Math.cos(theta) * ground.y - Math.sin(theta) * ty;
  const nz = Math.cos(theta) * ground.z - Math.sin(theta) * tz;

  const vn = vx * nx + vy * ny + vz * nz;
  if (vn >= 0) return Float64Array.from(state);
  const e = turfRestitution(surface, vn);

  // Velocity of the contact point (at -radius * n), tangential part only.
  const rx = -radius * nx;
  const ry = -radius * ny;
  const rz = -radius * nz;
  let ux = vx + (oy * rz - oz * ry);
  let uy = vy + (oz * rx - ox * rz);
  let uz = vz + (ox * ry - oy * rx);
  const un = ux * nx + uy * ny + uz * nz;
  ux -= un * nx;
  uy -= un * ny;
  uz -= un * nz;
  const slip = Math.hypot(ux, uy, uz);

  // Tangential impulse per unit mass: enough to stop the contact slipping (ball leaves rolling), or full friction.
  const normalImpulse = (1 + e) * -vn;
  const scale = slip <= 3.5 * surface.friction * normalImpulse ? 2 / 7 : (surface.friction * normalImpulse) / Math.max(slip, 1e-12);
  const jx = -scale * ux;
  const jy = -scale * uy;
  const jz = -scale * uz;

  // Spin change from the friction impulse: r x J / I, with I = 2/5 m r².
  const k = 5 / (2 * radius * radius);
  return Float64Array.of(
    state[0],
    state[1],
    state[2],
    vx + normalImpulse * nx + jx,
    vy + normalImpulse * ny + jy,
    vz + normalImpulse * nz + jz,
    ox + k * (ry * jz - rz * jy),
    oy + k * (rz * jx - rx * jz),
    oz + k * (rx * jy - ry * jx),
  );
}

interface AirSegment {
  readonly kind: 'air';
  readonly start: number;
  readonly trajectory: Trajectory;
}

/** Ball on the ground (sliding or rolling), sampled every `step` seconds: x, y, z per sample. */
interface GroundSegment {
  readonly kind: 'ground';
  readonly start: number;
  readonly step: number;
  readonly points: Float64Array;
}

type Segment = AirSegment | GroundSegment;

const groundDuration = (seg: GroundSegment) => (seg.points.length / 3 - 1) * seg.step;

export interface ShotOptions extends FlightOptions {
  /** Turf used everywhere on level ground; without it, a hole decides the turf by position. */
  readonly surface?: Surface;
  /** A hole: turf then depends on where the ball lands, and the ball can drop in the cup. */
  readonly hole?: HoleLayout;
  /** Real ground: heights, slopes and turf. Overrides `surface` and the hole's turf; the hole still has the cup. */
  readonly terrain?: Terrain;
}

/** A full shot: flight, bounces, slide and roll until the ball stops. */
export class Shot {
  readonly flight: FlightResult;
  readonly bounces: readonly FlightResult[];
  readonly restPosition: Vec3;
  readonly duration: number;
  /** True when the ball finished in the cup. */
  readonly holed: boolean;
  /** Set when the ball finished in a hazard, such as water. */
  readonly hazard: Surface['hazard'] | null;
  /** Turf the ball came to rest on. */
  readonly restSurface: Surface | null;
  private readonly segments: readonly Segment[];

  constructor(
    flight: FlightResult, bounces: FlightResult[], segments: Segment[], rest: Vec3, holed = false,
    hazard: Surface['hazard'] | null = null, restSurface: Surface | null = null,
  ) {
    this.flight = flight;
    this.bounces = bounces;
    this.segments = segments;
    this.restPosition = rest;
    this.holed = holed;
    this.hazard = hazard;
    this.restSurface = restSurface;
    const last = segments[segments.length - 1];
    this.duration = last.kind === 'air' ? last.start + last.trajectory.duration : last.start + groundDuration(last);
  }

  /** Horizontal distance from the tee to where the ball stops, m. */
  get total(): number {
    return Math.hypot(this.restPosition.x, this.restPosition.z);
  }

  /** Distance gained after the first landing, m (negative if it spins back). */
  get roll(): number {
    return this.total - this.flight.carry;
  }

  /** Distance right of the target line where the ball stops, m. */
  get totalOffline(): number {
    return this.restPosition.z;
  }

  /** Times the ball hits the ground: each bounce, then the start of the roll. */
  get impactTimes(): number[] {
    const firstGround = this.segments.findIndex((seg) => seg.kind === 'ground');
    return this.segments
      .filter((seg, i) => i > 0 && (seg.kind === 'air' || i === firstGround))
      .map((seg) => seg.start);
  }

  /** Full state (position, velocity, spin) while the ball is in the air; null while it is on the ground. */
  airStateAt(t: number): Float64Array | null {
    const seg = this.segments[this.segmentIndex(t)];
    return seg.kind === 'air' ? seg.trajectory.stateAt(Math.min(t - seg.start, seg.trajectory.duration)) : null;
  }

  /** Velocity at time t, m/s (finite difference of position). */
  velocityAt(t: number): Vec3 {
    const h = 1e-3;
    const a = this.positionAt(Math.max(0, t - h));
    const b = this.positionAt(Math.min(this.duration, t + h));
    const dt = Math.min(this.duration, t + h) - Math.max(0, t - h) || 1;
    return vec3((b.x - a.x) / dt, (b.y - a.y) / dt, (b.z - a.z) / dt);
  }

  /** What the ball is doing at time t. */
  phaseAt(t: number): 'flight' | 'bounce' | 'roll' {
    const i = this.segmentIndex(t);
    return this.segments[i].kind === 'ground' ? 'roll' : i === 0 ? 'flight' : 'bounce';
  }

  positionAt(t: number): Vec3 {
    const seg = this.segments[this.segmentIndex(t)];
    if (seg.kind === 'air') return seg.trajectory.positionAt(t - seg.start);
    const p = seg.points;
    const last = p.length / 3 - 1;
    const u = Math.min(Math.max((t - seg.start) / seg.step, 0), last);
    const i = Math.min(Math.floor(u), Math.max(0, last - 1));
    const f = last === 0 ? 0 : u - i;
    const j = Math.min(i + 1, last);
    return vec3(
      p[3 * i] + (p[3 * j] - p[3 * i]) * f,
      p[3 * i + 1] + (p[3 * j + 1] - p[3 * i + 1]) * f,
      p[3 * i + 2] + (p[3 * j + 2] - p[3 * i + 2]) * f,
    );
  }

  private segmentIndex(t: number): number {
    for (let i = this.segments.length - 1; i > 0; i--) if (t >= this.segments[i].start) return i;
    return 0;
  }
}

export function simulateShot(launch: LaunchConditions, env: Environment, options: ShotOptions = {}): Shot {
  const ball = options.ball ?? TOUR_BALL;
  const hole = options.hole;
  const terrain = options.terrain ?? new FlatTerrain(hole ?? null, options.surface ?? null);
  const level = !options.terrain;
  const ground = level ? undefined : (x: number, z: number) => terrain.height(x, z);
  const flightOptions = { ...options, ball, ground };
  const flight = simulateFlight(launch, env, flightOptions);
  const segments: Segment[] = [{ kind: 'air', start: 0, trajectory: flight.trajectory }];
  const bounces: FlightResult[] = [];
  let clock = flight.flightTime;
  let end = flight.trajectory.stateAt(flight.flightTime);
  const at = (state: ArrayLike<number>) => vec3(state[0], state[1], state[2]);

  if (!flight.landed || flight.carry === 0) return new Shot(flight, bounces, segments, flight.landingPosition);
  if (hole && dropsIn(Math.hypot(end[0] - hole.pin.x, end[2] - hole.pin.z), 0)) {
    return new Shot(flight, bounces, segments, vec3(hole.pin.x, end[1], hole.pin.z), true);
  }

  for (let i = 0; i < MAX_BOUNCES; i++) {
    const surface = terrain.surface(end[0], end[2]);
    if (surface.hazard) return new Shot(flight, bounces, segments, at(end), false, surface.hazard, surface);
    const normal = terrain.normal(end[0], end[2]);
    const after = bounce(end, surface, ball, normal);
    // Speed leaving the ground, measured along its normal.
    const leaving = after[3] * normal.x + after[4] * normal.y + after[5] * normal.z;
    if (leaving < MIN_HOP_SPEED) {
      end = after;
      break;
    }
    // Start the hop a hair above the ground so the landing search sees it leave.
    const lifted = Float64Array.from(after);
    lifted[1] += 1e-6;
    const hop = flyFrom(lifted, env, flightOptions);
    const touchdown = hop.trajectory.stateAt(hop.flightTime);
    bounces.push(hop);
    segments.push({ kind: 'air', start: clock, trajectory: hop.trajectory });
    if (hole && hop.landed && dropsIn(Math.hypot(touchdown[0] - hole.pin.x, touchdown[2] - hole.pin.z), 0)) {
      return new Shot(flight, bounces, segments, vec3(hole.pin.x, touchdown[1], hole.pin.z), true);
    }
    clock += hop.flightTime;
    end = touchdown;
    if (!hop.landed) return new Shot(flight, bounces, segments, hop.landingPosition);
  }

  const result = roll(end, terrain, ball, clock, segments, hole ?? null);
  return new Shot(flight, bounces, segments, result.rest, result.holed, result.hazard, result.surface);
}

const GROUND_STEP = 1 / 120;
const MAX_ROLL_TIME = 90;

/**
 * Slides until friction makes the ball roll (contact point at rest), then rolls to a stop, following the ground.
 * While rolling, gravity pulls the ball downhill at 5/7 g times the slope (a rolling sphere), and the turf slows
 * it by its rolling resistance. Appends one sampled ground segment; checks the cup along the way.
 */
function roll(state: Float64Array, terrain: Terrain, ball: Ball, start: number, segments: Segment[], hole: HoleLayout | null) {
  const radius = ball.diameter / 2;
  const g = STANDARD_GRAVITY;
  let x = state[0];
  let z = state[2];
  let vx = state[3];
  let vz = state[5];
  const points: number[] = [x, terrain.height(x, z), z];
  const finish = (holed: boolean, hazard: Surface['hazard'] | null = null) => {
    segments.push({ kind: 'ground', start, step: GROUND_STEP, points: Float64Array.from(points) });
    const n = points.length;
    const rest = holed && hole ? vec3(hole.pin.x, points[n - 2], hole.pin.z) : vec3(points[n - 3], points[n - 2], points[n - 1]);
    return { rest, holed, hazard, surface: terrain.surface(rest.x, rest.z) };
  };
  const push = (nx: number, nz: number) => {
    // Check the cup on the way from the last point to this one.
    if (hole) {
      const dx = nx - x;
      const dz = nz - z;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((hole.pin.x - x) * dx + (hole.pin.z - z) * dz) / len2)) : 0;
      const miss = Math.hypot(x + dx * t - hole.pin.x, z + dz * t - hole.pin.z);
      if (dropsIn(miss, Math.sqrt(len2) / GROUND_STEP)) {
        x += dx * t;
        z += dz * t;
        points.push(x, terrain.height(x, z), z);
        return true;
      }
    }
    x = nx;
    z = nz;
    points.push(x, terrain.height(x, z), z);
    return false;
  };

  // Sliding: friction acts against the slip of the contact point until it reaches the 2/7 rolling condition.
  const surface0 = terrain.surface(x, z);
  const ux = vx + radius * state[8];
  const uz = vz - radius * state[6];
  const slip = Math.hypot(ux, uz);
  if (slip > 1e-6) {
    const duration = (2 * slip) / (7 * surface0.friction * g);
    const ax = (-surface0.friction * g * ux) / slip;
    const az = (-surface0.friction * g * uz) / slip;
    const x0 = x;
    const z0 = z;
    const steps = Math.max(1, Math.ceil(duration / GROUND_STEP));
    for (let k = 1; k <= steps; k++) {
      const t = Math.min(duration, k * GROUND_STEP);
      if (push(x0 + vx * t + 0.5 * ax * t * t, z0 + vz * t + 0.5 * az * t * t)) return finish(true);
    }
    vx -= (2 / 7) * ux;
    vz -= (2 / 7) * uz;
  }

  for (let t = 0; t < MAX_ROLL_TIME; t += GROUND_STEP) {
    const surface = terrain.surface(x, z);
    if (surface.hazard) return finish(false, surface.hazard);
    const n = terrain.normal(x, z);
    const gx = (5 / 7) * g * n.x;
    const gz = (5 / 7) * g * n.z;
    const pull = Math.hypot(gx, gz);
    const speed = Math.hypot(vx, vz);
    const resist = surface.rollingResistance;
    if (speed < 1e-3) {
      // At rest unless the slope beats the turf's grip.
      if (pull <= resist) return finish(false);
      vx = 0;
      vz = 0;
    }
    let ax = gx;
    let az = gz;
    if (speed >= 1e-3) {
      ax -= (resist * vx) / speed;
      az -= (resist * vz) / speed;
      // Comes to a stop within this step: stop exactly where the speed reaches zero.
      const slowing = -(ax * vx + az * vz) / speed;
      if (slowing > 0 && speed / slowing < GROUND_STEP && pull <= resist) {
        const tau = speed / slowing;
        if (push(x + vx * tau + 0.5 * ax * tau * tau, z + vz * tau + 0.5 * az * tau * tau)) return finish(true);
        return finish(false);
      }
    } else {
      const k = Math.max(0, pull - resist) / (pull || 1);
      ax = gx * k;
      az = gz * k;
    }
    const h = GROUND_STEP;
    if (push(x + vx * h + 0.5 * ax * h * h, z + vz * h + 0.5 * az * h * h)) return finish(true);
    vx += ax * h;
    vz += az * h;
  }
  return finish(false);
}
