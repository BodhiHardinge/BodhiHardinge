export interface MinimizeResult {
  readonly x: number[];
  readonly value: number;
  readonly iterations: number;
}

export interface MinimizeOptions {
  /** Initial simplex size for each parameter. */
  readonly steps: readonly number[];
  readonly maxIterations?: number;
  /** Stop when the spread of values across the simplex falls below this. */
  readonly tolerance?: number;
}

/** Derivative-free minimiser (Nelder & Mead 1965): a triangle of guesses that rolls and shrinks downhill. */
export function nelderMead(f: (x: number[]) => number, x0: readonly number[], options: MinimizeOptions): MinimizeResult {
  const n = x0.length;
  const maxIterations = options.maxIterations ?? 2000;
  const tolerance = options.tolerance ?? 1e-10;

  let simplex = [Array.from(x0)];
  for (let i = 0; i < n; i++) {
    const p = Array.from(x0);
    p[i] += options.steps[i];
    simplex.push(p);
  }
  let values = simplex.map(f);

  const combine = (a: number[], b: number[], t: number) => a.map((ai, i) => ai + t * (b[i] - ai));

  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);
    if (values[n] - values[0] < tolerance) break;

    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;

    const worst = simplex[n];
    const reflected = combine(centroid, worst, -1);
    const fr = f(reflected);

    if (fr < values[0]) {
      const expanded = combine(centroid, worst, -2);
      const fe = f(expanded);
      [simplex[n], values[n]] = fe < fr ? [expanded, fe] : [reflected, fr];
    } else if (fr < values[n - 1]) {
      simplex[n] = reflected;
      values[n] = fr;
    } else {
      const contracted = fr < values[n] ? combine(centroid, reflected, 0.5) : combine(centroid, worst, 0.5);
      const fc = f(contracted);
      if (fc < Math.min(fr, values[n])) {
        simplex[n] = contracted;
        values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = combine(simplex[0], simplex[i], 0.5);
          values[i] = f(simplex[i]);
        }
      }
    }
  }

  const best = values.indexOf(Math.min(...values));
  return { x: simplex[best], value: values[best], iterations };
}
