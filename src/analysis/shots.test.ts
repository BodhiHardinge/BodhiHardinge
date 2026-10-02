import { describe, expect, it } from 'vitest';
import { degrees, mph, rpm, yards } from '../physics/units.ts';
import { compareCarry, summariseClubs } from './compare.ts';
import { compareClubs, importShots, parseCsv } from './shots.ts';

// Synthetic rows in the Awesome Golf export layout (header, units row, data).
const AWESOME_GOLF = [
  'Date,Club Type,Club Description,Altitude,Club Speed,Ball Speed,Carry Distance,Total Distance,Roll Distance,Smash,Vertical Launch,Peak Height,Descent Angle,Horizontal Launch,Carry Lateral Distance,Total Lateral Distance,Carry Curve Distance,Total Curve Distance,Attack Angle,Dynamic Loft,Spin Loft,Spin Rate,Spin Axis,Spin Reading,Low Point,Club Path,Face Path,Face Target,Shot Classification',
  ',,,[m],[mph],[mph],[m],[m],[m],,[deg],[m],[deg],[deg],[m],[m],[m],[m],[deg],[deg],[deg],[rpm],[deg],,[cm],[deg],[deg],[deg],',
  '2025-01-01 10:00:00,7 Iron,,0.00,85.00,110.00,140.00,150.00,10.00,1.29,20.00,26.00,46.00,2.00,5.00,6.00,1.00,1.20,-4.00,25.00,29.00,6500,5.00,Actual,,-2.00,4.00,2.00,Push Fade',
  '2025-01-01 10:01:00,Driver,"Test, with comma",0.00,105.00,150.00,220.00,245.00,25.00,1.43,14.00,30.00,38.00,-1.00,-8.00,-9.00,-2.00,-2.50,2.00,15.00,13.00,2800,-6.00,Estimate,,1.00,-5.00,-4.00,Draw',
  '2025-01-01 10:02:00,7 Iron,,0.00,,,,,,,,,,,,,,,,,,,,,,,,,',
].join('\n');

// Garmin Golf style: launch angle/direction names, backspin and sidespin, yards.
const GARMIN = [
  'Date,Club Name,Club Speed,Ball Speed,Launch Angle,Launch Direction,Backspin,Sidespin,Carry Distance,Apex Height',
  ',,[mph],[mph],[deg],[deg],[rpm],[rpm],[yds],[ft]',
  '2025-02-01 09:00:00,Pitching Wedge,78,90,30,0,8000,-400,110,80',
].join('\n');

describe('CSV parsing', () => {
  it('splits quoted fields containing commas and handles CRLF', () => {
    expect(parseCsv('a,"b, c",d\r\n1,2,3\r\n')).toEqual([['a', 'b, c', 'd'], ['1', '2', '3']]);
  });
});

describe('importing an Awesome Golf export', () => {
  const { shots, skipped } = importShots(AWESOME_GOLF);

  it('keeps rows with launch data and skips empty ones', () => {
    expect(shots).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it('converts every value to SI using the units row', () => {
    const iron = shots[0];
    expect(iron.club).toBe('7 Iron');
    expect(iron.ballSpeed).toBeCloseTo(mph(110), 9);
    expect(iron.launchAngle).toBeCloseTo(degrees(20), 9);
    expect(iron.spinRate).toBeCloseTo(rpm(6500), 9);
    expect(iron.spinAxis).toBeCloseTo(degrees(5), 9);
    expect(iron.carry).toBe(140);
    expect(iron.clubPath).toBeCloseTo(degrees(-2), 9);
    expect(iron.faceToPath).toBeCloseTo(degrees(4), 9);
    expect(iron.spinMeasured).toBe(true);
  });

  it('flags estimated spin', () => {
    expect(shots[1].spinMeasured).toBe(false);
  });
});

describe('importing a Garmin Golf export', () => {
  const [shot] = importShots(GARMIN).shots;

  it('builds total spin and axis from backspin and sidespin', () => {
    expect(shot.spinRate).toBeCloseTo(rpm(Math.hypot(8000, 400)), 6);
    expect(shot.spinAxis).toBeLessThan(0);
  });

  it('converts yards and feet', () => {
    expect(shot.carry).toBeCloseTo(yards(110), 9);
    expect(shot.apex).toBeCloseTo(24.384, 6);
  });
});

describe('club summaries', () => {
  it('orders clubs from driver to wedges', () => {
    expect(['Pitching Wedge', '7 Iron', 'Driver', '5 Wood'].sort(compareClubs)).toEqual(['Driver', '5 Wood', '7 Iron', 'Pitching Wedge']);
  });

  it('summarises and compares each club against the engine', () => {
    const { shots } = importShots(AWESOME_GOLF);
    const summary = summariseClubs(shots);
    expect(summary.map((s) => s.club)).toEqual(['Driver', '7 Iron']);
    const comparison = compareCarry(shots);
    expect(comparison).toHaveLength(1);
    expect(Math.abs(comparison[0].medianError)).toBeLessThan(0.15);
  });
});
