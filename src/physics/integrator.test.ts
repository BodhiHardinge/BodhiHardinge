import { describe, expect, it } from 'vitest';
import { AdaptiveStepper } from './integrator.ts';

const tol = { relative: 1e-10, absolute: 1e-12 };

function runUntil(stepper: AdaptiveStepper, end: number): void {
  while (stepper.t < end) {
    stepper.h = Math.min(stepper.h, end - stepper.t);
    stepper.advance();
  }
}

describe('Dormand-Prince integrator', () => {
  it('solves exponential decay to high accuracy', () => {
    const stepper = new AdaptiveStepper((y, d) => { d[0] = -y[0]; }, Float64Array.of(1), tol, 0.01, 1);
    runUntil(stepper, 5);
    expect(stepper.y[0]).toBeCloseTo(Math.exp(-5), 10);
  });

  it('keeps a harmonic oscillator on its orbit', () => {
    const stepper = new AdaptiveStepper(
      (y, d) => { d[0] = y[1]; d[1] = -y[0]; },
      Float64Array.of(1, 0),
      tol,
      0.01,
      1,
    );
    runUntil(stepper, 20 * Math.PI);
    expect(stepper.y[0]).toBeCloseTo(1, 7);
    expect(stepper.y[1]).toBeCloseTo(0, 7);
  });

  it('takes large steps when the motion is smooth', () => {
    const stepper = new AdaptiveStepper((y, d) => { d[0] = -y[0]; }, Float64Array.of(1), tol, 1e-4, 1);
    let steps = 0;
    while (stepper.t < 5) {
      stepper.advance();
      steps++;
    }
    expect(steps).toBeLessThan(200);
  });
});
