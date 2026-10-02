import { describe, expect, it } from 'vitest';
import { airDensity, airViscosity, atmosphereAt, pressureAtAltitude, STANDARD_ATMOSPHERE } from './atmosphere.ts';
import { celsius } from './units.ts';
import { CALM, windProfileFactor } from './wind.ts';

describe('atmosphere', () => {
  it('gives the standard sea-level density for dry air at 15 °C', () => {
    expect(airDensity(STANDARD_ATMOSPHERE)).toBeCloseTo(1.225, 3);
  });

  it('gives the standard viscosity at 15 °C', () => {
    expect(airViscosity(288.15)).toBeCloseTo(1.789e-5, 8);
  });

  it('makes humid air lighter than dry air', () => {
    const dry = airDensity(atmosphereAt(0, celsius(30), 0));
    const humid = airDensity(atmosphereAt(0, celsius(30), 0.9));
    expect(humid).toBeLessThan(dry);
    expect(dry / humid - 1).toBeGreaterThan(0.01);
    expect(dry / humid - 1).toBeLessThan(0.03);
  });

  it('matches the standard atmosphere pressure at Denver altitude', () => {
    expect(pressureAtAltitude(1609)).toBeCloseTo(83_430, -2);
  });

  it('makes hot air thinner than cold air', () => {
    expect(airDensity(atmosphereAt(0, celsius(35), 0.5))).toBeLessThan(airDensity(atmosphereAt(0, celsius(5), 0.5)));
  });
});

describe('wind profile', () => {
  const wind = { ...CALM, speed: 5 };

  it('is full strength at the reference height', () => {
    expect(windProfileFactor(wind, wind.referenceHeight)).toBeCloseTo(1, 12);
  });

  it('is zero at ground roughness height and below', () => {
    expect(windProfileFactor(wind, wind.roughnessLength)).toBe(0);
    expect(windProfileFactor(wind, -1)).toBe(0);
  });

  it('grows with height', () => {
    expect(windProfileFactor(wind, 2)).toBeLessThan(windProfileFactor(wind, 10));
    expect(windProfileFactor(wind, 30)).toBeGreaterThan(1);
  });
});
