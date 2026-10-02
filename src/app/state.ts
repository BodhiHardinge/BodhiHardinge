import { atmosphereAt } from '../physics/atmosphere.ts';
import type { Environment } from '../physics/dynamics.ts';
import type { LaunchConditions } from '../physics/launch.ts';
import { celsius, degrees, mph, rpm, yards } from '../physics/units.ts';
import { CALM } from '../physics/wind.ts';
import type { ReferenceShot } from '../analysis/reference-data.ts';

/** Everything the user can set, in SI units. */
export interface ShotSettings {
  ballSpeed: number;
  launchAngle: number;
  launchDirection: number;
  spinRate: number;
  spinAxis: number;
  windSpeed: number;
  windDirection: number;
  altitude: number;
  temperature: number;
  humidity: number;
  /** Distance to the flag, m. */
  pinDistance: number;
}

export type SettingKey = keyof ShotSettings;

export const LAUNCH_KEYS: readonly SettingKey[] = ['ballSpeed', 'launchAngle', 'launchDirection', 'spinRate', 'spinAxis'];

export function settingsFromReference(shot: ReferenceShot, current: ShotSettings): ShotSettings {
  return {
    ...current,
    ballSpeed: mph(shot.ballSpeedMph),
    launchAngle: degrees(shot.launchAngleDeg),
    launchDirection: 0,
    spinRate: rpm(shot.spinRpm),
    spinAxis: 0,
    // Irons aim at a green they can reach; woods play a par 4 whose green is out of range.
    pinDistance: yards(shot.launchAngleDeg < 13 ? Math.min(380, shot.carryYards + 120) : Math.round(shot.carryYards / 5) * 5),
  };
}

export const DEFAULT_SETTINGS: ShotSettings = {
  ballSpeed: mph(167),
  launchAngle: degrees(10.9),
  launchDirection: 0,
  spinRate: rpm(2686),
  spinAxis: 0,
  windSpeed: 0,
  windDirection: 0,
  altitude: 0,
  temperature: celsius(25),
  humidity: 0.5,
  pinDistance: yards(380),
};

/** The conditions every shot is compared against: Tour conditions with no wind. */
export const STANDARD_SETTINGS: Pick<ShotSettings, 'windSpeed' | 'windDirection' | 'altitude' | 'temperature' | 'humidity'> = {
  windSpeed: 0,
  windDirection: 0,
  altitude: 0,
  temperature: celsius(25),
  humidity: 0.5,
};

export function isStandardWeather(s: ShotSettings): boolean {
  return (
    s.windSpeed < 0.05 &&
    Math.abs(s.altitude - STANDARD_SETTINGS.altitude) < 0.5 &&
    Math.abs(s.temperature - STANDARD_SETTINGS.temperature) < 0.05 &&
    Math.abs(s.humidity - STANDARD_SETTINGS.humidity) < 0.005
  );
}

export function toLaunch(s: ShotSettings): LaunchConditions {
  return {
    ballSpeed: s.ballSpeed,
    launchAngle: s.launchAngle,
    launchDirection: s.launchDirection,
    spinRate: s.spinRate,
    spinAxis: s.spinAxis,
  };
}

export function toEnvironment(s: ShotSettings): Environment {
  return {
    atmosphere: atmosphereAt(s.altitude, s.temperature, s.humidity),
    wind: { ...CALM, speed: s.windSpeed, direction: s.windDirection },
    landingHeight: 0,
  };
}
