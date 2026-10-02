import type { Environment } from '../physics/dynamics.ts';
import { simulateShot, type ShotOptions } from '../physics/ground.ts';
import type { HoleLayout } from '../physics/hole.ts';
import type { LaunchConditions } from '../physics/launch.ts';
import { nelderMead } from './nelder-mead.ts';

/**
 * Adjusts ball speed and start direction (keeping launch angle and spin) until the ball finishes in the cup.
 * Returns null when no small adjustment holes it.
 */
export function findHoleOut(
  launch: LaunchConditions,
  env: Environment,
  hole: HoleLayout,
  options: Omit<ShotOptions, 'hole'> = {},
): LaunchConditions | null {
  const tryLaunch = ([speed, direction]: number[]): LaunchConditions => ({ ...launch, ballSpeed: speed, launchDirection: direction });
  const miss = (x: number[]) => {
    if (x[0] <= 1) return 1e6;
    const shot = simulateShot(tryLaunch(x), env, { ...options, hole });
    return shot.holed ? 0 : Math.hypot(shot.restPosition.x - hole.pin.x, shot.restPosition.z - hole.pin.z);
  };
  let x = [launch.ballSpeed, launch.launchDirection];
  for (let round = 0; round < 4; round++) {
    const result = nelderMead(miss, x, { steps: [launch.ballSpeed * 0.03, 0.01], maxIterations: 300, tolerance: 1e-9 });
    x = result.x;
    if (result.value === 0) return tryLaunch(x);
  }
  return null;
}
