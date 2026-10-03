import { describe, expect, it } from 'vitest';
import { TIMING_PRESETS, ADVANCED, faultsFrom, judge, makePrompts, NO_FAULTS, seeded, SIMPLE, TimingRun, type Prompt } from './timing.ts';

const prompt: Prompt = { phase: 'strike', arrows: ['up'], time: 2 };

describe('timing', () => {
  it('lays out three prompts in simple mode and five in advanced, in order', () => {
    const simple = makePrompts(SIMPLE, false, seeded(1));
    const advanced = makePrompts(ADVANCED, false, seeded(1));
    expect(simple.map((p) => p.phase)).toEqual(['top', 'release', 'strike']);
    expect(advanced).toHaveLength(5);
    for (let i = 1; i < advanced.length; i++) expect(advanced[i].time).toBeGreaterThan(advanced[i - 1].time);
    expect(simple[0].time).toBe(SIMPLE.laneTime);
  });

  it('grades a press by how close it was, and signs early and late', () => {
    const w = TIMING_PRESETS.medium.windows;
    expect(judge(prompt, { arrow: 'up', time: 2.02 }, w, seeded(1))).toMatchObject({ grade: 'perfect', severity: 0 });
    const early = judge(prompt, { arrow: 'up', time: 2 - 0.15 }, w, seeded(1));
    expect(early.grade).toBe('good');
    expect(early.severity).toBeLessThan(0);
    const late = judge(prompt, { arrow: 'up', time: 2 + 0.25 }, w, seeded(1));
    expect(late.grade).toBe('poor');
    expect(late.severity).toBeGreaterThan(1.2);
  });

  it('punishes a wrong arrow harder than any timing error', () => {
    const wrong = judge(prompt, { arrow: 'down', time: 2 }, SIMPLE.windows, seeded(1));
    expect(wrong.grade).toBe('wrong');
    expect(Math.abs(wrong.severity)).toBeGreaterThan(2);
  });

  it('ignores presses far too early and marks passed prompts as missed', () => {
    const run = new TimingRun([prompt], SIMPLE, seeded(2));
    expect(run.press('up', 1)).toBeNull();
    expect(run.finished).toBe(false);
    run.advance(3);
    expect(run.finished).toBe(true);
    expect(run.judgements[0]?.grade).toBe('miss');
  });

  it('perfect timing leaves the swing untouched', () => {
    const run = new TimingRun(makePrompts(ADVANCED, false, seeded(3)), ADVANCED, seeded(3));
    for (const p of run.prompts) for (const a of p.arrows) run.press(a, p.time);
    const faults = faultsFrom(run.judgements.map((j) => j!), 1, false, seeded(3));
    expect(faults).toEqual(NO_FAULTS);
  });

  it('an early strike hits it fat, a late one thin; an early release closes the face', () => {
    const at = (phase: Prompt['phase'], offset: number) => {
      const p: Prompt = { phase, arrows: ['left'], time: 1 };
      return faultsFrom([judge(p, { arrow: 'left', time: 1 + offset }, SIMPLE.windows, seeded(4))], 1, false, seeded(4));
    };
    expect(at('strike', -0.2).strike.lowPointShift).toBeLessThan(0);
    expect(at('strike', 0.2).strike.lowPointShift).toBeGreaterThan(0);
    expect(at('release', -0.2).face).toBeLessThan(0);
    expect(at('release', 0.2).face).toBeGreaterThan(0);
  });

  it('Pro asks for two arrows at once on some beats, and both must be pressed', () => {
    const pro = TIMING_PRESETS.pro;
    const prompts = makePrompts(pro, false, seeded(5));
    expect(prompts).toHaveLength(6);
    const double = prompts.find((p) => p.arrows.length === 2)!;
    expect(double).toBeDefined();
    expect(double.arrows[0]).not.toBe(double.arrows[1]);
    const run = new TimingRun([double], pro, seeded(5));
    expect(run.press(double.arrows[0], double.time)).toBeNull();
    expect(run.press(double.arrows[1], double.time + 0.01)?.grade).toBe('perfect');
    const half = new TimingRun([double], pro, seeded(6));
    half.press(double.arrows[0], double.time);
    half.advance(double.time + 1);
    expect(half.judgements[0]?.grade).toBe('miss');
  });
});
