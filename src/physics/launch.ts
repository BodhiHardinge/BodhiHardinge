export interface LaunchConditions {
  /** m/s */
  readonly ballSpeed: number;
  /** Vertical launch angle, rad. */
  readonly launchAngle: number;
  /** Horizontal launch angle, rad. Positive = right of the target line. */
  readonly launchDirection: number;
  /** Total spin, rad/s. */
  readonly spinRate: number;
  /** Spin axis tilt, rad. Positive = tilted right, so the ball curves right. */
  readonly spinAxis: number;
}

/** State vector layout: position 0-2, velocity 3-5, spin vector 6-8. */
export const STATE_SIZE = 9;

/** Total spin and axis from the backspin/sidespin split many launch monitors report. Positive sidespin curves right. */
export function spinFromComponents(backspin: number, sidespin: number): { spinRate: number; spinAxis: number } {
  return { spinRate: Math.hypot(backspin, sidespin), spinAxis: Math.atan2(sidespin, backspin) };
}

// The spin axis starts perpendicular to the launch direction (no rifle spin), tilted about the velocity.
export function launchState(launch: LaunchConditions): Float64Array {
  const { ballSpeed, spinRate } = launch;
  const cosT = Math.cos(launch.launchAngle);
  const sinT = Math.sin(launch.launchAngle);
  const cosP = Math.cos(launch.launchDirection);
  const sinP = Math.sin(launch.launchDirection);
  const cosA = Math.cos(launch.spinAxis);
  const sinA = Math.sin(launch.spinAxis);

  const vx = cosT * cosP;
  const vy = sinT;
  const vz = cosT * sinP;

  const rx = -sinP;
  const rz = cosP;

  const ux = -rz * vy;
  const uy = rz * vx - rx * vz;
  const uz = rx * vy;

  return Float64Array.of(
    0,
    0,
    0,
    ballSpeed * vx,
    ballSpeed * vy,
    ballSpeed * vz,
    spinRate * (cosA * rx - sinA * ux),
    spinRate * -sinA * uy,
    spinRate * (cosA * rz - sinA * uz),
  );
}
