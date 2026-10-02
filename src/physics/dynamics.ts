import { airDensity, airViscosity, type Atmosphere } from './atmosphere.ts';
import { dragCoefficient, liftCoefficient, REFERENCE_DENSITY, type AeroModel, type Ball } from './ball.ts';
import { windProfileFactor, type Wind } from './wind.ts';

export const STANDARD_GRAVITY = 9.80665;

export interface Environment {
  readonly atmosphere: Atmosphere;
  readonly wind: Wind;
  /** Height of the landing surface relative to the launch point, m. Positive = uphill. */
  readonly landingHeight: number;
}

/** Everything the equations of motion need, precomputed once per flight. */
export interface FlightContext {
  readonly aero: AeroModel;
  readonly density: number;
  readonly viscosity: number;
  readonly radius: number;
  readonly diameter: number;
  readonly area: number;
  readonly mass: number;
  readonly gravity: number;
  readonly wind: Wind;
  readonly windX: number;
  readonly windZ: number;
}

export function createContext(ball: Ball, env: Environment): FlightContext {
  const radius = ball.diameter / 2;
  return {
    aero: ball.aero,
    density: airDensity(env.atmosphere),
    viscosity: airViscosity(env.atmosphere.temperature),
    radius,
    diameter: ball.diameter,
    area: Math.PI * radius * radius,
    mass: ball.mass,
    gravity: STANDARD_GRAVITY,
    wind: env.wind,
    windX: -env.wind.speed * Math.cos(env.wind.direction),
    windZ: -env.wind.speed * Math.sin(env.wind.direction),
  };
}

/** Writes dy/dt for state y into out. Allocation-free so it can run every frame in a game loop. */
export function derivative(ctx: FlightContext, y: Float64Array, out: Float64Array): void {
  const vx = y[3];
  const vy = y[4];
  const vz = y[5];
  const ox = y[6];
  const oy = y[7];
  const oz = y[8];

  const profile = ctx.windX === 0 && ctx.windZ === 0 ? 0 : windProfileFactor(ctx.wind, y[1]);
  const rx = vx - profile * ctx.windX;
  const ry = vy;
  const rz = vz - profile * ctx.windZ;
  const airspeed = Math.sqrt(rx * rx + ry * ry + rz * rz);

  let ax = 0;
  let ay = -ctx.gravity;
  let az = 0;
  let spinLoss = 0;

  if (airspeed > 1e-9) {
    const ux = rx / airspeed;
    const uy = ry / airspeed;
    const uz = rz / airspeed;

    // Only spin perpendicular to the airflow makes Magnus lift.
    const along = ox * ux + oy * uy + oz * uz;
    const px = ox - along * ux;
    const py = oy - along * uy;
    const pz = oz - along * uz;
    const perpSpin = Math.sqrt(px * px + py * py + pz * pz);

    const spinRatio = (perpSpin * ctx.radius) / airspeed;
    const reynolds = (ctx.density * airspeed * ctx.diameter) / ctx.viscosity;
    const k = (0.5 * ctx.density * airspeed * airspeed * ctx.area) / ctx.mass;

    const drag = k * dragCoefficient(ctx.aero, reynolds, spinRatio);
    ax -= drag * ux;
    ay -= drag * uy;
    az -= drag * uz;

    if (perpSpin > 1e-9) {
      const lift = (k * liftCoefficient(ctx.aero, spinRatio)) / perpSpin;
      ax += lift * (oy * uz - oz * uy);
      ay += lift * (oz * ux - ox * uz);
      az += lift * (ox * uy - oy * ux);
    }

    spinLoss = ctx.aero.spinDecay * (ctx.density / REFERENCE_DENSITY) * airspeed;
  }

  out[0] = vx;
  out[1] = vy;
  out[2] = vz;
  out[3] = ax;
  out[4] = ay;
  out[5] = az;
  out[6] = -spinLoss * ox;
  out[7] = -spinLoss * oy;
  out[8] = -spinLoss * oz;
}
