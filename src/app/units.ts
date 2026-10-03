import * as u from '../physics/units.ts';

export type UnitSystem = 'imperial' | 'metric';

export interface DisplayUnit {
  readonly label: string;
  readonly fromSI: (si: number) => number;
  readonly toSI: (value: number) => number;
}

const unit = (label: string, fromSI: (si: number) => number, toSI: (v: number) => number): DisplayUnit => ({
  label,
  fromSI,
  toSI,
});

const identity = (x: number) => x;

export const DEGREES = unit('deg', u.toDegrees, u.degrees);
export const RPM = unit('rpm', u.toRpm, u.rpm);
export const PERCENT = unit('%', (x) => x * 100, (x) => x / 100);
export const SECONDS = unit('s', identity, identity);

// Club and ball speeds stay in mph in both systems, as launch monitors show them; wind follows the system.
const IMPERIAL = {
  speed: unit('mph', u.toMph, u.mph),
  wind: unit('mph', u.toMph, u.mph),
  distance: unit('yd', u.toYards, u.yards),
  height: unit('ft', u.toFeet, u.feet),
  altitude: unit('ft', u.toFeet, u.feet),
  temperature: unit('°F', u.toFahrenheit, u.fahrenheit),
};

const METRIC = {
  speed: unit('mph', u.toMph, u.mph),
  wind: unit('km/h', u.toKmh, u.kmh),
  distance: unit('m', identity, identity),
  height: unit('m', identity, identity),
  altitude: unit('m', identity, identity),
  temperature: unit('°C', u.toCelsius, u.celsius),
};

export type Measure = keyof typeof IMPERIAL;

export function unitFor(measure: Measure, system: UnitSystem): DisplayUnit {
  return (system === 'imperial' ? IMPERIAL : METRIC)[measure];
}
