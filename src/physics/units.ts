// The engine works in SI units only (m, s, kg, rad, K, Pa). Convert at the edges.

const MPH = 0.44704;
const KMH = 1 / 3.6;
const YARD = 0.9144;
const FOOT = 0.3048;
const INCH = 0.0254;
const RPM = (2 * Math.PI) / 60;
const DEGREE = Math.PI / 180;
const ZERO_CELSIUS = 273.15;

export const mph = (v: number): number => v * MPH;
export const toMph = (v: number): number => v / MPH;

export const kmh = (v: number): number => v * KMH;
export const toKmh = (v: number): number => v / KMH;

export const yards = (d: number): number => d * YARD;
export const toYards = (d: number): number => d / YARD;

export const feet = (d: number): number => d * FOOT;
export const toFeet = (d: number): number => d / FOOT;

export const inches = (d: number): number => d * INCH;
export const toInches = (d: number): number => d / INCH;

export const rpm = (r: number): number => r * RPM;
export const toRpm = (w: number): number => w / RPM;

export const degrees = (d: number): number => d * DEGREE;
export const toDegrees = (r: number): number => r / DEGREE;

export const celsius = (c: number): number => c + ZERO_CELSIUS;
export const toCelsius = (k: number): number => k - ZERO_CELSIUS;

export const fahrenheit = (f: number): number => ((f - 32) * 5) / 9 + ZERO_CELSIUS;
export const toFahrenheit = (k: number): number => ((k - ZERO_CELSIUS) * 9) / 5 + 32;

export const hectopascals = (p: number): number => p * 100;
export const toHectopascals = (p: number): number => p / 100;
