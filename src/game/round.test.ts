import { describe, expect, it } from 'vitest';
import { SUN_CITY } from './course.ts';
import { Round, scoreName } from './round.ts';
import { surfaceOn } from '../physics/hole.ts';

describe('round', () => {
  it('has 18 holes adding to par 72', () => {
    expect(SUN_CITY.holes).toHaveLength(18);
    expect(SUN_CITY.holes.reduce((s, h) => s + h.par, 0)).toBe(72);
  });

  it('par 3s play from the tee straight to an apron, with no fairway near the tee', () => {
    const third = SUN_CITY.holes[2].layout;
    expect(surfaceOn(third, 60, 0).name).toBe('Rough');
    expect(surfaceOn(third, third.pin.x, third.pin.z).name).toBe('Green');
  });

  it('counts strokes and scores holes', () => {
    const round = new Round(SUN_CITY);
    round.record({ from: { x: 0, z: 0 }, to: { x: 250, z: 3 }, club: 'Driver', lie: 'Tee', holed: false });
    expect(round.toPin).toBeCloseTo(Math.hypot(377 - 250, -3 - 3), 6);
    round.record({ from: round.ball, to: round.current.layout.pin, club: 'PW', lie: 'Fairway', holed: true });
    expect(round.scores[0]).toBe(2);
    expect(round.total.toPar).toBe(-2);
    round.nextHole();
    expect(round.hole).toBe(1);
    expect(round.ball).toEqual({ x: 0, z: 0 });
    expect(scoreName(2, 4)).toBe('Eagle');
    expect(scoreName(1, 3)).toBe('Hole in one');
  });
});
