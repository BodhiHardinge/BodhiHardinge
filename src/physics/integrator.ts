export type Rhs = (y: Float64Array, dydt: Float64Array) => void;

export interface Tolerance {
  readonly relative: number;
  readonly absolute: number;
}

export interface StepWorkspace {
  readonly k2: Float64Array;
  readonly k3: Float64Array;
  readonly k4: Float64Array;
  readonly k5: Float64Array;
  readonly k6: Float64Array;
  readonly k7: Float64Array;
  readonly stage: Float64Array;
  readonly next: Float64Array;
  readonly error: Float64Array;
}

export function createWorkspace(size: number): StepWorkspace {
  const make = () => new Float64Array(size);
  return {
    k2: make(), k3: make(), k4: make(), k5: make(), k6: make(), k7: make(),
    stage: make(), next: make(), error: make(),
  };
}

// Dormand-Prince 5(4) coefficients (Dormand & Prince 1980).
const A21 = 1 / 5;
const A31 = 3 / 40, A32 = 9 / 40;
const A41 = 44 / 45, A42 = -56 / 15, A43 = 32 / 9;
const A51 = 19372 / 6561, A52 = -25360 / 2187, A53 = 64448 / 6561, A54 = -212 / 729;
const A61 = 9017 / 3168, A62 = -355 / 33, A63 = 46732 / 5247, A64 = 49 / 176, A65 = -5103 / 18656;
const B1 = 35 / 384, B3 = 500 / 1113, B4 = 125 / 192, B5 = -2187 / 6784, B6 = 11 / 84;
const E1 = 71 / 57600, E3 = -71 / 16695, E4 = 71 / 1920, E5 = -17253 / 339200, E6 = 22 / 525, E7 = -1 / 40;

/** One step of size h from y, given k1 = f(y). Writes y(h) to ws.next, f(y(h)) to ws.k7, error to ws.error. */
export function dormandPrinceStep(f: Rhs, y: Float64Array, k1: Float64Array, h: number, ws: StepWorkspace): void {
  const { k2, k3, k4, k5, k6, k7, stage, next, error } = ws;
  const n = y.length;
  for (let i = 0; i < n; i++) stage[i] = y[i] + h * A21 * k1[i];
  f(stage, k2);
  for (let i = 0; i < n; i++) stage[i] = y[i] + h * (A31 * k1[i] + A32 * k2[i]);
  f(stage, k3);
  for (let i = 0; i < n; i++) stage[i] = y[i] + h * (A41 * k1[i] + A42 * k2[i] + A43 * k3[i]);
  f(stage, k4);
  for (let i = 0; i < n; i++) stage[i] = y[i] + h * (A51 * k1[i] + A52 * k2[i] + A53 * k3[i] + A54 * k4[i]);
  f(stage, k5);
  for (let i = 0; i < n; i++) {
    stage[i] = y[i] + h * (A61 * k1[i] + A62 * k2[i] + A63 * k3[i] + A64 * k4[i] + A65 * k5[i]);
  }
  f(stage, k6);
  for (let i = 0; i < n; i++) next[i] = y[i] + h * (B1 * k1[i] + B3 * k3[i] + B4 * k4[i] + B5 * k5[i] + B6 * k6[i]);
  f(next, k7);
  for (let i = 0; i < n; i++) {
    error[i] = h * (E1 * k1[i] + E3 * k3[i] + E4 * k4[i] + E5 * k5[i] + E6 * k6[i] + E7 * k7[i]);
  }
}

function errorNorm(y: Float64Array, ws: StepWorkspace, tol: Tolerance): number {
  let sum = 0;
  for (let i = 0; i < y.length; i++) {
    const scale = tol.absolute + tol.relative * Math.max(Math.abs(y[i]), Math.abs(ws.next[i]));
    const e = ws.error[i] / scale;
    sum += e * e;
  }
  return Math.sqrt(sum / y.length);
}

const SAFETY = 0.9;
const MIN_FACTOR = 0.2;
const MAX_FACTOR = 5;
const MIN_STEP = 1e-12;

/** Adaptive-step integrator: big steps where the motion is smooth, small ones where it changes fast. */
export class AdaptiveStepper {
  readonly y: Float64Array;
  readonly dydt: Float64Array;
  readonly workspace: StepWorkspace;
  t = 0;
  h: number;
  private readonly f: Rhs;
  private readonly tol: Tolerance;
  private readonly maxStep: number;

  constructor(f: Rhs, y0: Float64Array, tol: Tolerance, initialStep: number, maxStep: number) {
    this.f = f;
    this.tol = tol;
    this.maxStep = maxStep;
    this.h = initialStep;
    this.y = Float64Array.from(y0);
    this.dydt = new Float64Array(y0.length);
    this.workspace = createWorkspace(y0.length);
    f(this.y, this.dydt);
  }

  /** Takes one accepted step and returns its size. */
  advance(): number {
    let rejected = false;
    for (;;) {
      dormandPrinceStep(this.f, this.y, this.dydt, this.h, this.workspace);
      const err = errorNorm(this.y, this.workspace, this.tol);
      if (err <= 1) {
        const taken = this.h;
        this.t += taken;
        this.y.set(this.workspace.next);
        this.dydt.set(this.workspace.k7);
        let factor = err === 0 ? MAX_FACTOR : Math.min(MAX_FACTOR, SAFETY * err ** -0.2);
        if (rejected) factor = Math.min(factor, 1);
        this.h = Math.min(this.maxStep, taken * Math.max(MIN_FACTOR, factor));
        return taken;
      }
      rejected = true;
      this.h *= Math.max(MIN_FACTOR, SAFETY * err ** -0.2);
      if (this.h < MIN_STEP) throw new Error('Integrator step size underflow');
    }
  }
}
