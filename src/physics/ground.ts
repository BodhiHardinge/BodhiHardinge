import { TOUR_BALL, type Ball } from './ball.ts';
import { STANDARD_GRAVITY, type Environment } from './dynamics.ts';
import { flyFrom, simulateFlight, type FlightResult, type FlightOptions } from './flight.ts';
import { dropsIn, surfaceOn, type HoleLayout } from './hole.ts';
import { SURFACES, type Surface } from './surfaces.ts';
import type { LaunchConditions } from './launch.ts';
import type { Trajectory } from './trajectory.ts';
import { vec3, type Vec3 } from './vec3.ts';

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

/** One rigid-sphere impact with the turf. Returns the state just after the bounce. */
export function bounce(state: Float64Array, surface: Surface, ball: Ball): Float64Array {
  const radius = ball.diameter / 2;
  const [vx, vy, vz, ox, oy, oz] = [state[3], state[4], state[5], state[6], state[7], state[8]];
  const horizontal = Math.hypot(vx, vz);
  const dx = horizontal > 1e-9 ? vx / horizontal : 1;
  const dz = horizontal > 1e-9 ? vz / horizontal : 0;
  const theta = craterAngle(surface, Math.hypot(vx, vy, vz), Math.atan2(-vy, horizontal));

  // Surface normal tilted back toward where the ball came from.
  const nx = -Math.sin(theta) * dx;
  const ny = Math.cos(theta);
  const nz = -Math.sin(theta) * dz;

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

interface GroundSegment {
  readonly kind: 'ground';
  readonly start: number;
  readonly duration: number;
  readonly from: Vec3;
  readonly velocity: Vec3;
  readonly acceleration: Vec3;
}

type Segment = AirSegment | GroundSegment;

export interface ShotOptions extends FlightOptions {
  /** Turf used everywhere; without it, a hole decides the turf by position. */
  readonly surface?: Surface;
  /** A hole: turf then depends on where the ball lands, and the ball can drop in the cup. */
  readonly hole?: HoleLayout;
}

/** A full shot: flight, bounces, slide and roll until the ball stops. */
export class Shot {
  readonly flight: FlightResult;
  readonly bounces: readonly FlightResult[];
  readonly restPosition: Vec3;
  readonly duration: number;
  /** True when the ball finished in the cup. */
  readonly holed: boolean;
  private readonly segments: readonly Segment[];

  constructor(flight: FlightResult, bounces: FlightResult[], segments: Segment[], rest: Vec3, holed = false) {
    this.flight = flight;
    this.bounces = bounces;
    this.segments = segments;
    this.restPosition = rest;
    this.holed = holed;
    const last = segments[segments.length - 1];
    this.duration = last.kind === 'air' ? last.start + last.trajectory.duration : last.start + last.duration;
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
    const tau = Math.min(Math.max(t - seg.start, 0), seg.duration);
    return vec3(
      seg.from.x + seg.velocity.x * tau + 0.5 * seg.acceleration.x * tau * tau,
      seg.from.y,
      seg.from.z + seg.velocity.z * tau + 0.5 * seg.acceleration.z * tau * tau,
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
  const turf = (x: number, z: number) => options.surface ?? (hole ? surfaceOn(hole, x, z) : SURFACES.fairway);
  const flight = simulateFlight(launch, env, options);
  const segments: Segment[] = [{ kind: 'air', start: 0, trajectory: flight.trajectory }];
  const bounces: FlightResult[] = [];
  let clock = flight.flightTime;
  let end = flight.trajectory.stateAt(flight.flightTime);

  if (!flight.landed || flight.carry === 0) return new Shot(flight, bounces, segments, flight.landingPosition);
  if (hole && dropsIn(Math.hypot(end[0] - hole.pin.x, end[2] - hole.pin.z), 0)) {
    return new Shot(flight, bounces, segments, vec3(hole.pin.x, end[1], hole.pin.z), true);
  }

  for (let i = 0; i < MAX_BOUNCES; i++) {
    const after = bounce(end, turf(end[0], end[2]), ball);
    if (after[4] < MIN_HOP_SPEED) {
      end = after;
      break;
    }
    const hop = flyFrom(after, env, { ...options, ball });
    bounces.push(hop);
    segments.push({ kind: 'air', start: clock, trajectory: hop.trajectory });
    clock += hop.flightTime;
    end = hop.trajectory.stateAt(hop.flightTime);
    if (!hop.landed) return new Shot(flight, bounces, segments, hop.landingPosition);
  }

  const first = segments.length;
  const rest = roll(end, turf(end[0], end[2]), ball, clock, segments);
  if (hole) {
    const holed = holeOut(segments, first, hole);
    if (holed) return new Shot(flight, bounces, segments, holed, true);
  }
  return new Shot(flight, bounces, segments, rest);
}

// Walks the ground segments; if the ball crosses the cup slowly enough, cuts the roll short there.
function holeOut(segments: Segment[], first: number, hole: HoleLayout): Vec3 | null {
  for (let i = first; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind !== 'ground') continue;
    for (let tau = 0; tau <= seg.duration; tau += 0.002) {
      const x = seg.from.x + seg.velocity.x * tau + 0.5 * seg.acceleration.x * tau * tau;
      const z = seg.from.z + seg.velocity.z * tau + 0.5 * seg.acceleration.z * tau * tau;
      const speed = Math.hypot(seg.velocity.x + seg.acceleration.x * tau, seg.velocity.z + seg.acceleration.z * tau);
      if (dropsIn(Math.hypot(x - hole.pin.x, z - hole.pin.z), speed)) {
        segments.length = i + 1;
        segments[i] = { ...seg, duration: tau };
        return vec3(hole.pin.x, seg.from.y, hole.pin.z);
      }
    }
  }
  return null;
}

// Slides until friction makes the ball roll (contact point at rest), then rolls to a stop. Appends ground segments.
function roll(state: Float64Array, surface: Surface, ball: Ball, start: number, segments: Segment[]): Vec3 {
  const radius = ball.diameter / 2;
  const g = STANDARD_GRAVITY;
  let position = vec3(state[0], state[1], state[2]);
  let vx = state[3];
  let vz = state[5];
  let clock = start;

  const ux = vx + radius * state[8];
  const uz = vz - radius * state[6];
  const slip = Math.hypot(ux, uz);
  if (slip > 1e-6) {
    const duration = (2 * slip) / (7 * surface.friction * g);
    const acceleration = vec3((-surface.friction * g * ux) / slip, 0, (-surface.friction * g * uz) / slip);
    segments.push({ kind: 'ground', start: clock, duration, from: position, velocity: vec3(vx, 0, vz), acceleration });
    position = vec3(
      position.x + vx * duration + 0.5 * acceleration.x * duration * duration,
      position.y,
      position.z + vz * duration + 0.5 * acceleration.z * duration * duration,
    );
    vx -= (2 / 7) * ux;
    vz -= (2 / 7) * uz;
    clock += duration;
  }

  const speed = Math.hypot(vx, vz);
  if (speed > 1e-6) {
    const duration = speed / surface.rollingResistance;
    const a = surface.rollingResistance / speed;
    segments.push({ kind: 'ground', start: clock, duration, from: position, velocity: vec3(vx, 0, vz), acceleration: vec3(-a * vx, 0, -a * vz) });
    position = vec3(position.x + (vx * duration) / 2, position.y, position.z + (vz * duration) / 2);
  }
  return position;
}
