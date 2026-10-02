import { describe, expect, it } from 'vitest';
import * as u from './units.ts';

describe('units', () => {
  it('converts golf units to SI', () => {
    expect(u.mph(100)).toBeCloseTo(44.704, 10);
    expect(u.yards(100)).toBeCloseTo(91.44, 10);
    expect(u.feet(10)).toBeCloseTo(3.048, 10);
    expect(u.rpm(60)).toBeCloseTo(2 * Math.PI, 10);
    expect(u.degrees(180)).toBeCloseTo(Math.PI, 12);
    expect(u.fahrenheit(212)).toBeCloseTo(373.15, 10);
    expect(u.kmh(36)).toBeCloseTo(10, 10);
  });

  it('round-trips every conversion', () => {
    const pairs: [(x: number) => number, (x: number) => number][] = [
      [u.mph, u.toMph], [u.kmh, u.toKmh], [u.yards, u.toYards], [u.feet, u.toFeet], [u.rpm, u.toRpm],
      [u.degrees, u.toDegrees], [u.celsius, u.toCelsius], [u.fahrenheit, u.toFahrenheit],
      [u.hectopascals, u.toHectopascals],
    ];
    for (const [to, from] of pairs) expect(from(to(123.456))).toBeCloseTo(123.456, 9);
  });
});
