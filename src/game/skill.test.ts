import { describe, expect, it } from 'vitest';
import { clubFor } from '../physics/club.ts';
import { naturalError, spreadFor } from './skill.ts';
import { seeded } from './timing.ts';

describe('natural error', () => {
  const seven = clubFor('7 Iron');
  it('grows with handicap and difficulty, and with the driver', () => {
    expect(spreadFor(20, 'medium', seven, 'Fairway').face).toBeGreaterThan(spreadFor(2, 'medium', seven, 'Fairway').face * 1.8);
    expect(spreadFor(10, 'pro', seven, 'Fairway').path).toBeGreaterThan(spreadFor(10, 'easy', seven, 'Fairway').path);
    expect(spreadFor(10, 'medium', clubFor('Driver'), 'Tee').face).toBeGreaterThan(spreadFor(10, 'medium', seven, 'Fairway').face);
    expect(spreadFor(10, 'medium', seven, 'Sand').lowPoint).toBeGreaterThan(spreadFor(10, 'medium', seven, 'Fairway').lowPoint);
  });

  it('respects overrides and samples with the right size', () => {
    expect(spreadFor(10, 'medium', seven, 'Fairway', { face: 0 }).face).toBe(0);
    const spread = spreadFor(10, 'medium', seven, 'Fairway');
    const rnd = seeded(9);
    const faces = Array.from({ length: 4000 }, () => naturalError(spread, rnd).face);
    const sd = Math.sqrt(faces.reduce((s, f) => s + f * f, 0) / faces.length);
    expect(sd / spread.face).toBeGreaterThan(0.95);
    expect(sd / spread.face).toBeLessThan(1.05);
  });
});
