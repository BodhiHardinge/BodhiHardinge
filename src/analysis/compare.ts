import { TOUR_BALL, type Ball } from '../physics/ball.ts';
import type { Environment } from '../physics/dynamics.ts';
import { simulateFlight } from '../physics/flight.ts';
import type { LaunchConditions } from '../physics/launch.ts';
import { TOUR_CONDITIONS } from './reference-data.ts';
import { compareClubs, type ShotRecord } from './shots.ts';

export function launchOf(shot: ShotRecord): LaunchConditions {
  return {
    ballSpeed: shot.ballSpeed,
    launchAngle: shot.launchAngle,
    launchDirection: shot.launchDirection,
    spinRate: shot.spinRate,
    spinAxis: shot.spinAxis,
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

export interface ClubSummary {
  readonly club: string;
  readonly count: number;
  /** A typical shot: the median of every launch value. */
  readonly typical: LaunchConditions;
  readonly medianCarry: number;
  readonly medianTotal: number;
  readonly carrySpread: number;
  readonly lateralSpread: number;
}

const values = (shots: readonly ShotRecord[], pick: (s: ShotRecord) => number | undefined) =>
  shots.map(pick).filter((v): v is number => v !== undefined);

export function summariseClubs(shots: readonly ShotRecord[]): ClubSummary[] {
  const byClub = new Map<string, ShotRecord[]>();
  for (const shot of shots) byClub.set(shot.club, [...(byClub.get(shot.club) ?? []), shot]);
  return [...byClub.entries()]
    .sort(([a], [b]) => compareClubs(a, b))
    .map(([club, list]) => ({
      club,
      count: list.length,
      typical: {
        ballSpeed: median(values(list, (s) => s.ballSpeed)),
        launchAngle: median(values(list, (s) => s.launchAngle)),
        launchDirection: median(values(list, (s) => s.launchDirection)),
        spinRate: median(values(list, (s) => s.spinRate)),
        spinAxis: median(values(list, (s) => s.spinAxis)),
      },
      medianCarry: median(values(list, (s) => s.carry)),
      medianTotal: median(values(list, (s) => s.total)),
      carrySpread: standardDeviation(values(list, (s) => s.carry)),
      lateralSpread: standardDeviation(values(list, (s) => s.carryLateral)),
    }));
}

export interface CarryComparison {
  readonly club: string;
  readonly count: number;
  /** Median of (engine carry / monitor carry - 1). */
  readonly medianError: number;
  /** Median absolute fractional difference. */
  readonly medianAbsoluteError: number;
}

/** Re-flies every shot through the engine and compares carry with what the monitor reported. */
export function compareCarry(
  shots: readonly ShotRecord[],
  env: Environment = TOUR_CONDITIONS,
  ball: Ball = TOUR_BALL,
): CarryComparison[] {
  const errors = new Map<string, number[]>();
  for (const shot of shots) {
    if (!shot.carry || shot.carry < 5 || !shot.spinMeasured) continue;
    const carry = simulateFlight(launchOf(shot), env, { ball }).carry;
    errors.set(shot.club, [...(errors.get(shot.club) ?? []), carry / shot.carry - 1]);
  }
  return [...errors.entries()]
    .sort(([a], [b]) => compareClubs(a, b))
    .map(([club, list]) => ({
      club,
      count: list.length,
      medianError: median(list),
      medianAbsoluteError: median(list.map(Math.abs)),
    }));
}
