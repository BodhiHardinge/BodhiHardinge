import { STATE_SIZE } from './launch.ts';
import { vec3, type Vec3 } from './vec3.ts';

/** The integrator's nodes, with smooth interpolation between them for rendering and playback. */
export class Trajectory {
  readonly times: Float64Array;
  readonly states: Float64Array;
  readonly rates: Float64Array;

  constructor(times: readonly number[], states: readonly number[], rates: readonly number[]) {
    this.times = Float64Array.from(times);
    this.states = Float64Array.from(states);
    this.rates = Float64Array.from(rates);
  }

  get nodeCount(): number {
    return this.times.length;
  }

  get duration(): number {
    return this.times[this.times.length - 1];
  }

  /** Full state at time t, by cubic Hermite interpolation (exact at the nodes, smooth between). */
  stateAt(t: number, out: Float64Array = new Float64Array(STATE_SIZE)): Float64Array {
    const last = this.times.length - 1;
    if (last === 0 || t <= 0) return copyNode(this.states, 0, out);
    if (t >= this.times[last]) return copyNode(this.states, last, out);

    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= t) lo = mid;
      else hi = mid;
    }

    const t0 = this.times[lo];
    const h = this.times[hi] - t0;
    const s = (t - t0) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = (s3 - 2 * s2 + s) * h;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = (s3 - s2) * h;
    const a = lo * STATE_SIZE;
    const b = hi * STATE_SIZE;
    for (let i = 0; i < STATE_SIZE; i++) {
      out[i] =
        h00 * this.states[a + i] + h10 * this.rates[a + i] + h01 * this.states[b + i] + h11 * this.rates[b + i];
    }
    return out;
  }

  positionAt(t: number): Vec3 {
    const s = this.stateAt(t);
    return vec3(s[0], s[1], s[2]);
  }
}

function copyNode(states: Float64Array, index: number, out: Float64Array): Float64Array {
  out.set(states.subarray(index * STATE_SIZE, index * STATE_SIZE + STATE_SIZE));
  return out;
}
