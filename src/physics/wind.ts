export interface Wind {
  /** Wind speed at referenceHeight, m/s. */
  readonly speed: number;
  /** Direction the wind blows FROM, rad. 0 = from the target (headwind), +π/2 = from the right. */
  readonly direction: number;
  /** Height the speed was measured at, m. Weather forecasts use 10 m. */
  readonly referenceHeight: number;
  /** Aerodynamic roughness of the ground, m. About 0.03 for open grassland. */
  readonly roughnessLength: number;
}

export const CALM: Wind = { speed: 0, direction: 0, referenceHeight: 10, roughnessLength: 0.03 };

/** Log-law wind profile: fraction of the reference speed felt at a height. Zero at and below the roughness length. */
export function windProfileFactor(wind: Wind, height: number): number {
  if (height <= wind.roughnessLength) return 0;
  return Math.log(height / wind.roughnessLength) / Math.log(wind.referenceHeight / wind.roughnessLength);
}
