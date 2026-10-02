export interface Atmosphere {
  /** Air temperature, K. */
  readonly temperature: number;
  /** Station (local, not sea-level corrected) pressure, Pa. */
  readonly pressure: number;
  /** Relative humidity, 0 to 1. */
  readonly relativeHumidity: number;
}

const R_DRY_AIR = 287.058;
const R_WATER_VAPOUR = 461.495;
const SEA_LEVEL_PRESSURE = 101_325;

export const STANDARD_ATMOSPHERE: Atmosphere = {
  temperature: 288.15,
  pressure: SEA_LEVEL_PRESSURE,
  relativeHumidity: 0,
};

/** Saturation vapour pressure over water (Buck 1981), Pa. */
export function saturationVapourPressure(temperature: number): number {
  const c = temperature - 273.15;
  return 611.21 * Math.exp((18.678 - c / 234.5) * (c / (257.14 + c)));
}

/** Moist air density from the ideal gas law for dry air plus water vapour, kg/m³. */
export function airDensity(air: Atmosphere): number {
  const vapour = air.relativeHumidity * saturationVapourPressure(air.temperature);
  const dry = air.pressure - vapour;
  return dry / (R_DRY_AIR * air.temperature) + vapour / (R_WATER_VAPOUR * air.temperature);
}

/** Dynamic viscosity from Sutherland's law, Pa·s. */
export function airViscosity(temperature: number): number {
  return (1.458e-6 * temperature ** 1.5) / (temperature + 110.4);
}

/** International Standard Atmosphere pressure at an altitude above sea level, Pa. */
export function pressureAtAltitude(altitude: number): number {
  return SEA_LEVEL_PRESSURE * (1 - 2.25577e-5 * altitude) ** 5.25588;
}

/** Local atmosphere from altitude, using standard pressure for that altitude. */
export function atmosphereAt(altitude: number, temperature: number, relativeHumidity: number): Atmosphere {
  return { temperature, pressure: pressureAtAltitude(altitude), relativeHumidity };
}
