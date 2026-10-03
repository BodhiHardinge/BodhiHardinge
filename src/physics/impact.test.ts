import { describe, expect, it } from 'vitest';
import { PGA_TOUR_AVERAGES } from '../analysis/reference-data.ts';
import { clubFor, PUTTER, type Delivery } from './club.ts';
import { CLEAN_CONTACT, strike, tourDynamicLoft } from './impact.ts';
import { deliveryFor, stockSetup } from './setup.ts';
import { degrees, mph, toDegrees, toMph, toRpm } from './units.ts';

const NAMES: Record<string, string> = { Hybrid: '3 Hybrid', PW: 'Pitching Wedge' };

describe('strike model', () => {
  for (const row of PGA_TOUR_AVERAGES) {
    if (row.club === '3-iron') continue;
    const spec = clubFor(NAMES[row.club] ?? row.club);
    const stock: Delivery = {
      clubSpeed: mph(row.clubSpeedMph),
      attackAngle: degrees(row.attackAngleDeg),
      clubPath: 0,
      faceAngle: 0,
      dynamicLoft: tourDynamicLoft(spec),
    };
    it(`${row.club}: a stock Tour delivery gives the Tour launch`, () => {
      const launch = strike(stock, spec);
      // Our club table's smash factors are rounded slightly differently from the Tour table's.
      expect(launch.ballSpeed / stock.clubSpeed).toBeCloseTo(spec.smash, 6);
      expect(toDegrees(launch.launchAngle)).toBeCloseTo(row.launchAngleDeg, 0);
      expect(Math.abs(toRpm(launch.spinRate) / row.spinRpm - 1)).toBeLessThan(0.03);
      expect(launch.launchDirection).toBeCloseTo(0, 9);
      expect(launch.spinAxis).toBeCloseTo(0, 9);
    });
  }

  const seven = clubFor('7 Iron');
  const base: Delivery = { clubSpeed: mph(90), attackAngle: degrees(-4.3), clubPath: 0, faceAngle: 0, dynamicLoft: tourDynamicLoft(seven) };

  it('starts the ball mostly where the face points and curves it away from the path (D-plane)', () => {
    const fade = strike({ ...base, clubPath: degrees(-4), faceAngle: degrees(0) }, seven);
    expect(toDegrees(fade.launchDirection)).toBeLessThan(0);
    expect(toDegrees(fade.launchDirection)).toBeGreaterThan(-2);
    expect(fade.spinAxis).toBeGreaterThan(0);
    const draw = strike({ ...base, clubPath: degrees(4), faceAngle: degrees(1) }, seven);
    expect(draw.spinAxis).toBeLessThan(0);
    expect(draw.launchDirection).toBeGreaterThan(0);
  });

  it('adds spin and launch with loft, and lowers ball speed', () => {
    const lofted = strike({ ...base, dynamicLoft: base.dynamicLoft + degrees(5) }, seven);
    const stock = strike(base, seven);
    expect(lofted.launchAngle).toBeGreaterThan(stock.launchAngle);
    expect(lofted.spinRate).toBeGreaterThan(stock.spinRate);
    expect(lofted.ballSpeed).toBeLessThan(stock.ballSpeed);
  });

  it('punishes poor contact', () => {
    const stock = strike(base, seven);
    const fat = strike(base, seven, { ...CLEAN_CONTACT, speedFactor: 0.6 });
    expect(fat.ballSpeed).toBeLessThan(stock.ballSpeed * 0.7);
    const toe = strike(base, seven, { ...CLEAN_CONTACT, toe: 0.015 });
    expect(toe.ballSpeed).toBeLessThan(stock.ballSpeed);
    expect(toe.spinAxis).toBeLessThan(0);
    const splash = strike(base, seven, { ...CLEAN_CONTACT, cushion: 0.7 });
    expect(splash.spinRate).toBeLessThan(stock.spinRate * 0.6);
    expect(splash.ballSpeed).toBeLessThan(stock.ballSpeed * 0.65);
  });

  it('gives a putt almost no spin and a low launch', () => {
    const putt = strike({ clubSpeed: 2, attackAngle: degrees(2), clubPath: 0, faceAngle: 0, dynamicLoft: tourDynamicLoft(PUTTER) }, PUTTER);
    expect(toDegrees(putt.launchAngle)).toBeLessThan(4);
    expect(toRpm(putt.spinRate)).toBeLessThan(100);
    expect(putt.ballSpeed).toBeCloseTo(2.9, 1);
  });
});

describe('setup to delivery', () => {
  const player = { driverSpeed: mph(113), putterSpeed: 4 };
  const seven = clubFor('7 Iron');

  it('reproduces the stock delivery from the stock setup', () => {
    const d = deliveryFor(stockSetup(seven), player);
    expect(toMph(d.clubSpeed)).toBeCloseTo(90, 0);
    expect(d.attackAngle).toBeCloseTo(seven.attackAngle, 9);
    expect(d.clubPath).toBeCloseTo(0, 9);
    expect(d.faceAngle).toBeCloseTo(0, 9);
    expect(d.dynamicLoft).toBeCloseTo(tourDynamicLoft(seven), 9);
  });

  it('ball forward: shallower attack, path and face left, more loft', () => {
    const stock = deliveryFor(stockSetup(seven), player);
    const forward = deliveryFor({ ...stockSetup(seven), ballPosition: 0.05 }, player);
    expect(forward.attackAngle).toBeGreaterThan(stock.attackAngle);
    expect(forward.clubPath).toBeLessThan(0);
    expect(forward.faceAngle).toBeLessThan(0);
    expect(forward.dynamicLoft).toBeGreaterThan(stock.dynamicLoft);
    // About 1.5 deg of attack per 5 cm: the size golf instruction quotes.
    expect(toDegrees(forward.attackAngle - stock.attackAngle)).toBeGreaterThan(1);
    expect(toDegrees(forward.attackAngle - stock.attackAngle)).toBeLessThan(2.5);
  });

  it('shaft lean takes loft off; a flatter plane swings more from the inside with the ball back', () => {
    const stock = deliveryFor(stockSetup(seven), player);
    expect(deliveryFor({ ...stockSetup(seven), shaftLean: degrees(4) }, player).dynamicLoft).toBeCloseTo(stock.dynamicLoft - degrees(4), 9);
    const flatBack = deliveryFor({ ...stockSetup(seven), ballPosition: -0.05, plane: degrees(-8) }, player);
    const uprightBack = deliveryFor({ ...stockSetup(seven), ballPosition: -0.05, plane: degrees(8) }, player);
    expect(flatBack.clubPath).toBeGreaterThan(uprightBack.clubPath);
  });
});
