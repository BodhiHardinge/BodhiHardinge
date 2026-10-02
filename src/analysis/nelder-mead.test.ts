import { describe, expect, it } from 'vitest';
import { nelderMead } from './nelder-mead.ts';

describe('Nelder-Mead', () => {
  it('finds the minimum of a quadratic bowl', () => {
    const result = nelderMead(([x, y]) => (x - 3) ** 2 + 2 * (y + 1) ** 2, [0, 0], { steps: [1, 1] });
    expect(result.x[0]).toBeCloseTo(3, 4);
    expect(result.x[1]).toBeCloseTo(-1, 4);
  });

  it('follows the curved valley of the Rosenbrock function', () => {
    const rosenbrock = ([x, y]: number[]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2;
    const result = nelderMead(rosenbrock, [-1.2, 1], { steps: [0.5, 0.5], maxIterations: 5000, tolerance: 1e-14 });
    expect(result.x[0]).toBeCloseTo(1, 3);
    expect(result.x[1]).toBeCloseTo(1, 3);
  });
});
