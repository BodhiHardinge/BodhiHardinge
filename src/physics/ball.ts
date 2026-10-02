export interface AeroModel {
  /** Drag coefficient of a fast ball with no spin, after the drag crisis. */
  readonly dragBase: number;
  /** Drag coefficient of a slow ball, before the drag crisis. */
  readonly dragSubcritical: number;
  /** Reynolds number at the middle of the drag crisis. */
  readonly criticalReynolds: number;
  /** How gradual the drag crisis is, in Reynolds number. */
  readonly crisisWidth: number;
  /** Drag added per unit of lift coefficient squared (induced drag). */
  readonly inducedDrag: number;
  /** Lift coefficient approached at very high spin ratio. */
  readonly liftMax: number;
  /** Spin ratio at which lift reaches half of liftMax. */
  readonly liftHalfSpin: number;
  /** Steepness of the lift curve around liftHalfSpin. */
  readonly liftExponent: number;
  /** Fraction of spin lost per metre of air travelled at sea-level density, 1/m. */
  readonly spinDecay: number;
}

export interface Ball {
  readonly name: string;
  /** kg */
  readonly mass: number;
  /** m */
  readonly diameter: number;
  readonly aero: AeroModel;
}

export const REFERENCE_DENSITY = 1.225;

// Dimples trip the boundary layer at high Reynolds number, halving drag; lift costs extra drag on top.
export function dragCoefficient(aero: AeroModel, reynolds: number, spinRatio: number): number {
  const subcritical = 1 / (1 + Math.exp((reynolds - aero.criticalReynolds) / aero.crisisWidth));
  const lift = liftCoefficient(aero, spinRatio);
  return aero.dragBase + (aero.dragSubcritical - aero.dragBase) * subcritical + aero.inducedDrag * lift * lift;
}

// Magnus lift rises with spin ratio along an S-curve and saturates at liftMax.
export function liftCoefficient(aero: AeroModel, spinRatio: number): number {
  const s = spinRatio ** aero.liftExponent;
  return (aero.liftMax * s) / (s + aero.liftHalfSpin ** aero.liftExponent);
}

// Rules of Golf mass and size. Lift and drag fitted by `npm run calibrate`; the rest is set by hand (see tests).
export const TOUR_BALL: Ball = {
  name: 'Tour ball',
  mass: 0.04593,
  diameter: 0.04267,
  aero: {
    dragBase: 0.2036,
    dragSubcritical: 0.5,
    // Wind-tunnel range. Fitting it to sea-level data alone put it too high and broke altitude behaviour.
    criticalReynolds: 60_000,
    crisisWidth: 8_000,
    inducedDrag: 1.181,
    liftMax: 0.3532,
    liftHalfSpin: 0.1094,
    liftExponent: 1.879,
    spinDecay: 7.5e-4,
  },
};
