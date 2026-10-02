import { TOUR_BALL, type Ball } from './ball.ts';
import { createContext, derivative, type Environment } from './dynamics.ts';
import { AdaptiveStepper, dormandPrinceStep, type Rhs, type StepWorkspace, type Tolerance } from './integrator.ts';
import { launchState, STATE_SIZE, type LaunchConditions } from './launch.ts';
import { Trajectory } from './trajectory.ts';
import { vec3, type Vec3 } from './vec3.ts';

export interface FlightOptions {
  readonly ball?: Ball;
  readonly tolerance?: Tolerance;
  /** Give up if the ball is still in the air after this long, s. */
  readonly maxTime?: number;
}

export interface FlightResult {
  readonly trajectory: Trajectory;
  /** False if the ball never came down to the landing height within maxTime. */
  readonly landed: boolean;
  readonly flightTime: number;
  readonly landingPosition: Vec3;
  readonly landingVelocity: Vec3;
  readonly landingSpin: Vec3;
  /** Straight-line horizontal distance from launch to landing, m. */
  readonly carry: number;
  /** Distance right of the target line at landing, m. */
  readonly offline: number;
  readonly apexPosition: Vec3;
  readonly apexTime: number;
  /** Descent angle below horizontal at landing, rad. */
  readonly landingAngle: number;
  readonly landingSpeed: number;
  /** rad/s */
  readonly landingSpinRate: number;
  /** kg/m³ */
  readonly airDensity: number;
}

const DEFAULT_TOLERANCE: Tolerance = { relative: 1e-9, absolute: 1e-9 };
const INITIAL_STEP = 1e-3;
const MAX_STEP = 0.25;
const ROOT_TOLERANCE = 1e-10;

export function simulateFlight(launch: LaunchConditions, env: Environment, options: FlightOptions = {}): FlightResult {
  assertValidLaunch(launch);
  const ball = options.ball ?? TOUR_BALL;
  const maxTime = options.maxTime ?? 30;
  const ctx = createContext(ball, env);
  const f: Rhs = (y, dydt) => derivative(ctx, y, dydt);
  const stepper = new AdaptiveStepper(f, launchState(launch), options.tolerance ?? DEFAULT_TOLERANCE, INITIAL_STEP, MAX_STEP);
  const ws = stepper.workspace;
  const height = env.landingHeight;

  const times = [0];
  const states = Array.from(stepper.y);
  const rates = Array.from(stepper.dydt);
  const before = new Float64Array(STATE_SIZE);
  const beforeRate = new Float64Array(STATE_SIZE);

  let apexTime = 0;
  let apex = vec3(0, 0, 0);
  let landed = stepper.y[4] <= 0 && height >= 0;

  while (!landed && stepper.t < maxTime) {
    before.set(stepper.y);
    beforeRate.set(stepper.dydt);
    const t0 = stepper.t;
    const h = stepper.advance();

    if (before[4] > 0 && stepper.y[4] <= 0) {
      const tau = findCrossing(f, before, beforeRate, h, (s) => s[4], ws);
      apexTime = t0 + tau;
      apex = vec3(ws.next[0], ws.next[1], ws.next[2]);
    }

    if (before[1] > height && stepper.y[1] <= height) {
      const tau = findCrossing(f, before, beforeRate, h, (s) => s[1] - height, ws);
      times.push(t0 + tau);
      states.push(...ws.next);
      rates.push(...ws.k7);
      landed = true;
    } else {
      times.push(stepper.t);
      states.push(...stepper.y);
      rates.push(...stepper.dydt);
    }
  }

  const trajectory = new Trajectory(times, states, rates);
  const end = trajectory.stateAt(trajectory.duration);
  const horizontalSpeed = Math.hypot(end[3], end[5]);

  return {
    trajectory,
    landed,
    flightTime: trajectory.duration,
    landingPosition: vec3(end[0], end[1], end[2]),
    landingVelocity: vec3(end[3], end[4], end[5]),
    landingSpin: vec3(end[6], end[7], end[8]),
    carry: Math.hypot(end[0], end[2]),
    offline: end[2],
    apexPosition: apex,
    apexTime,
    landingAngle: Math.atan2(-end[4], horizontalSpeed),
    landingSpeed: Math.hypot(end[3], end[4], end[5]),
    landingSpinRate: Math.hypot(end[6], end[7], end[8]),
    airDensity: ctx.density,
  };
}

// Illinois (modified regula falsi) search for the sub-step where g crosses zero, using exact integrator steps.
// On return ws.next holds the state at the crossing and ws.k7 its derivative.
function findCrossing(
  f: Rhs,
  y0: Float64Array,
  k1: Float64Array,
  h: number,
  g: (state: Float64Array) => number,
  ws: StepWorkspace,
): number {
  let a = 0;
  let ga = g(y0);
  let b = h;
  dormandPrinceStep(f, y0, k1, b, ws);
  let gb = g(ws.next);
  if (gb === 0) return b;

  let c = b;
  let side = 0;
  for (let i = 0; i < 100; i++) {
    c = (a * gb - b * ga) / (gb - ga);
    dormandPrinceStep(f, y0, k1, c, ws);
    const gc = g(ws.next);
    if (Math.abs(gc) < ROOT_TOLERANCE || b - a < 1e-14) return c;
    if (gc < 0) {
      b = c;
      gb = gc;
      if (side === -1) ga /= 2;
      side = -1;
    } else {
      a = c;
      ga = gc;
      if (side === 1) gb /= 2;
      side = 1;
    }
  }
  return c;
}

function assertValidLaunch(launch: LaunchConditions): void {
  for (const [key, value] of Object.entries(launch)) {
    if (!Number.isFinite(value)) throw new RangeError(`Launch ${key} must be a finite number, got ${value}`);
  }
  if (launch.ballSpeed <= 0) throw new RangeError(`Ball speed must be positive, got ${launch.ballSpeed}`);
  if (launch.spinRate < 0) throw new RangeError(`Spin rate cannot be negative, got ${launch.spinRate}`);
}
