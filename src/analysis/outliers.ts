import { median } from './compare.ts';
import type { ShotRecord } from './shots.ts';

export interface OutlierOptions {
  /** How many robust standard deviations from the club's median counts as an outlier. 3 is a common choice. */
  readonly threshold: number;
  /** Treat shots whose spin the monitor only estimated as outliers. */
  readonly rejectEstimatedSpin: boolean;
}

export const DEFAULT_OUTLIER_OPTIONS: OutlierOptions = { threshold: 3, rejectEstimatedSpin: false };

export interface OutlierVerdict {
  readonly outlier: boolean;
  /** Plain reasons, e.g. "carry 3.8σ short". Empty for normal shots. */
  readonly reasons: string[];
}

const MEASURES: readonly [string, (s: ShotRecord) => number | undefined][] = [
  ['ball speed', (s) => s.ballSpeed],
  ['carry', (s) => s.carry],
  ['launch', (s) => s.launchAngle],
  ['spin', (s) => s.spinRate],
  ['smash', (s) => (s.clubSpeed ? s.ballSpeed / s.clubSpeed : undefined)],
];

/**
 * Flags unusual shots per club with a robust z-score: distance from the median in units of the median absolute
 * deviation (scaled by 1.4826 to match a standard deviation). Medians are not dragged around by the outliers
 * themselves, unlike a mean and standard deviation.
 */
export function findOutliers(shots: readonly ShotRecord[], options: OutlierOptions = DEFAULT_OUTLIER_OPTIONS): Map<ShotRecord, OutlierVerdict> {
  const verdicts = new Map<ShotRecord, OutlierVerdict>();
  const byClub = new Map<string, ShotRecord[]>();
  for (const shot of shots) byClub.set(shot.club, [...(byClub.get(shot.club) ?? []), shot]);

  for (const list of byClub.values()) {
    const stats = MEASURES.map(([name, pick]) => {
      const values = list.map(pick).filter((v): v is number => v !== undefined);
      const centre = median(values);
      const spread = 1.4826 * median(values.map((v) => Math.abs(v - centre)));
      return { name, pick, centre, spread };
    });
    for (const shot of list) {
      const reasons: string[] = [];
      if (options.rejectEstimatedSpin && !shot.spinMeasured) reasons.push('spin estimated');
      // Too few shots to judge, or every value identical: nothing can be called unusual.
      if (list.length >= 8) {
        for (const { name, pick, centre, spread } of stats) {
          const value = pick(shot);
          if (value === undefined || !(spread > 0)) continue;
          const z = (value - centre) / spread;
          if (Math.abs(z) > options.threshold) reasons.push(`${name} ${Math.abs(z).toFixed(1)}σ ${z < 0 ? 'low' : 'high'}`);
        }
      }
      verdicts.set(shot, { outlier: reasons.length > 0, reasons });
    }
  }
  return verdicts;
}
