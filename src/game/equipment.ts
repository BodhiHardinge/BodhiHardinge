import { CLUBS, PUTTER, type ClubSpec } from '../physics/club.ts';
import type { LaunchConditions } from '../physics/launch.ts';
import { degrees } from '../physics/units.ts';

/**
 * Equipment choices. Names describe the category; the numbers are typical of the category, not any one model.
 * Lofts are static loft; forgiveness scales how much an off-centre strike costs (lower is kinder).
 */
export interface IronSet {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  /** Change to every iron's loft versus our standard set, deg. Negative is stronger (lower). */
  readonly loftChange: number;
  readonly forgiveness: number;
  readonly smashChange: number;
}

export const IRON_SETS: readonly IronSet[] = [
  { id: 'blade', name: 'Tour blades', note: 'Traditional lofts, small sweet spot, most feel', loftChange: 2, forgiveness: 1.6, smashChange: -0.01 },
  { id: 'players', name: 'Players cavity back', note: 'Standard modern lofts, some help on mishits', loftChange: 0, forgiveness: 1, smashChange: 0 },
  { id: 'gi', name: 'Game improvement', note: 'Stronger lofts, wide sole, forgiving', loftChange: -2, forgiveness: 0.65, smashChange: 0.01 },
  { id: 'sgi', name: 'Super game improvement', note: 'Strongest lofts, widest sole, most forgiving', loftChange: -3.5, forgiveness: 0.45, smashChange: 0.015 },
];

export interface DriverChoice {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly loft: number;
  readonly forgiveness: number;
  /** Spin relative to standard; low-spin heads have a forward centre of gravity. */
  readonly spin: number;
}

export const DRIVERS: readonly DriverChoice[] = [
  { id: 'low-spin', name: 'Low-spin 9°', note: 'Forward weight: less spin, less forgiving', loft: 9, forgiveness: 1.2, spin: 0.85 },
  { id: 'standard', name: 'Standard 10.5°', note: 'Balanced', loft: 10.5, forgiveness: 1, spin: 1 },
  { id: 'max', name: 'Max forgiveness 12°', note: 'High stability, a little more spin', loft: 12, forgiveness: 0.6, spin: 1.08 },
];

export interface WedgeGrind {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  /** Bounce on the sand and lob wedges, deg. */
  readonly bounce: number;
}

export const WEDGE_GRINDS: readonly WedgeGrind[] = [
  { id: 'low', name: 'Low bounce (6°)', note: 'Firm turf and tight lies; digs in soft sand', bounce: 6 },
  { id: 'mid', name: 'Mid bounce (10°)', note: 'All-round', bounce: 10 },
  { id: 'high', name: 'High bounce (14°)', note: 'Soft sand and lush turf; skids off firm ground', bounce: 14 },
];

export interface PutterChoice {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly forgiveness: number;
}

export const PUTTERS: readonly PutterChoice[] = [
  { id: 'blade', name: 'Blade putter', note: 'Toe hang, feel; twists on mishits', forgiveness: 1.4 },
  { id: 'mallet', name: 'Mallet putter', note: 'High stability, face stays square on mishits', forgiveness: 0.6 },
];

export interface BallChoice {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  /** Spin relative to a Tour urethane ball, for the driver and for wedges (interpolated by loft). */
  readonly driverSpin: number;
  readonly wedgeSpin: number;
  readonly speed: number;
}

export const BALLS: readonly BallChoice[] = [
  { id: 'tour', name: 'Tour urethane', note: 'Pro V1 class: the reference. Most greenside spin', driverSpin: 1, wedgeSpin: 1, speed: 1 },
  { id: 'tour-x', name: 'Tour firm urethane', note: 'Pro V1x class: a touch more speed and long-game spin', driverSpin: 1.06, wedgeSpin: 1.03, speed: 1.003 },
  { id: 'soft', name: 'Low compression', note: 'Soft feel; slower for fast swingers, less wedge spin', driverSpin: 0.93, wedgeSpin: 0.8, speed: 0.99 },
  { id: 'distance', name: 'Two-piece distance', note: 'Ionomer cover: low spin everywhere, runs out', driverSpin: 0.88, wedgeSpin: 0.6, speed: 1.004 },
];

export interface Bag {
  readonly irons: string;
  readonly driver: string;
  readonly wedges: string;
  readonly putter: string;
  readonly ball: string;
}

export const DEFAULT_BAG: Bag = { irons: 'players', driver: 'standard', wedges: 'mid', putter: 'mallet', ball: 'tour' };

const pick = <T extends { id: string }>(list: readonly T[], id: string): T => list.find((x) => x.id === id) ?? list[0];

/** The clubs this bag holds, with lofts, forgiveness and bounce set by the choices. */
export function clubsFor(bag: Bag): ClubSpec[] {
  const irons = pick(IRON_SETS, bag.irons);
  const driver = pick(DRIVERS, bag.driver);
  const grind = pick(WEDGE_GRINDS, bag.wedges);
  const putter = pick(PUTTERS, bag.putter);
  const clubs = CLUBS.map((c): ClubSpec => {
    if (c.head === 'driver') return { ...c, name: 'Driver', loft: degrees(driver.loft), forgiveness: driver.forgiveness };
    if (c.head !== 'iron') return c;
    const loftDeg = (c.loft * 180) / Math.PI;
    const wedge = loftDeg >= 50;
    return {
      ...c,
      loft: wedge ? c.loft : c.loft + degrees(irons.loftChange),
      forgiveness: wedge ? 1 : irons.forgiveness,
      smash: wedge ? c.smash : c.smash + irons.smashChange,
      bounce: loftDeg >= 54 ? degrees(grind.bounce) : c.bounce,
    };
  });
  return [...clubs, { ...PUTTER, forgiveness: putter.forgiveness }];
}

/** Applies the ball's spin and speed to a launch. */
export function withBall(launch: LaunchConditions, spec: ClubSpec, ballId: string, driverSpinScale = 1): LaunchConditions {
  const ball = pick(BALLS, ballId);
  const t = Math.min(1, Math.max(0, ((spec.loft * 180) / Math.PI - 10) / 46));
  const spin = ball.driverSpin + (ball.wedgeSpin - ball.driverSpin) * t;
  return { ...launch, ballSpeed: launch.ballSpeed * ball.speed, spinRate: launch.spinRate * spin * driverSpinScale };
}

export function driverSpin(bag: Bag): number {
  return pick(DRIVERS, bag.driver).spin;
}
