import type { Delivery } from '../physics/club.ts';
import { CENTRED_STRIKE, type Strike } from '../physics/contact.ts';
import { degrees } from '../physics/units.ts';

export type Arrow = 'up' | 'down' | 'left' | 'right';
export const ARROWS: readonly Arrow[] = ['left', 'up', 'down', 'right'];

/** The swing moments the player has to time. Each one controls part of the delivery. */
export type Phase = 'takeaway' | 'set' | 'top' | 'transition' | 'release' | 'strike';

export const PHASE_INFO: Record<Phase, { label: string; controls: string }> = {
  takeaway: { label: 'Takeaway', controls: 'Plane: early snatches it steep and outside' },
  set: { label: 'Wrist set', controls: 'Lag: late sets less hinge, losing speed and adding loft' },
  top: { label: 'Top', controls: 'Tempo: early rushes and loses speed' },
  transition: { label: 'Transition', controls: 'Path: early comes over the top' },
  release: { label: 'Release', controls: 'Face: early closes it, late leaves it open' },
  strike: { label: 'Strike', controls: 'Low point: early hits it fat, late hits it thin' },
};

// Beat times in s. A full swing keeps the classic 3:1 backswing-to-downswing tempo.
const BEAT: Record<Phase, number> = { takeaway: 0, set: 0.45, top: 0.9, transition: 1.25, release: 1.6, strike: 1.9 };
const PUTT_BEAT: Partial<Record<Phase, number>> = { takeaway: 0, top: 0.7, strike: 1.3 };

export type Grade = 'perfect' | 'great' | 'good' | 'poor' | 'miss' | 'wrong';

export interface Windows {
  /** Half-widths of each timing band, s. A press outside `poor` is ignored. */
  readonly perfect: number;
  readonly great: number;
  readonly good: number;
  readonly poor: number;
}

export type Difficulty = 'easy' | 'medium' | 'hard' | 'pro';

export interface TimingSettings {
  readonly difficulty: Difficulty;
  readonly windows: Windows;
  /** How long an arrow takes to travel down the lane to the line, s. */
  readonly laneTime: number;
  /** Stretches (above 1) or quickens the gaps between prompts. */
  readonly tempo: number;
  /** Swing moments that get an arrow, in swing order. */
  readonly phases: readonly Phase[];
  /** Moments that need two arrows pressed together. */
  readonly doubles: readonly Phase[];
  readonly puttPhases: readonly Phase[];
}

export const TIMING_PRESETS: Record<Difficulty, TimingSettings> = {
  easy: {
    difficulty: 'easy', windows: { perfect: 0.09, great: 0.15, good: 0.22, poor: 0.32 }, laneTime: 2, tempo: 1.15,
    phases: ['top', 'release', 'strike'], doubles: [], puttPhases: ['strike'],
  },
  medium: {
    difficulty: 'medium', windows: { perfect: 0.06, great: 0.11, good: 0.17, poor: 0.25 }, laneTime: 1.6, tempo: 1,
    phases: ['top', 'transition', 'release', 'strike'], doubles: [], puttPhases: ['top', 'strike'],
  },
  hard: {
    difficulty: 'hard', windows: { perfect: 0.04, great: 0.08, good: 0.12, poor: 0.18 }, laneTime: 1.2, tempo: 1,
    phases: ['takeaway', 'top', 'transition', 'release', 'strike'], doubles: [], puttPhases: ['takeaway', 'top', 'strike'],
  },
  pro: {
    difficulty: 'pro', windows: { perfect: 0.03, great: 0.06, good: 0.09, poor: 0.13 }, laneTime: 0.9, tempo: 0.85,
    phases: ['takeaway', 'set', 'top', 'transition', 'release', 'strike'], doubles: ['transition', 'strike'],
    puttPhases: ['takeaway', 'top', 'strike'],
  },
};

/** Kept for older saved settings and tests. */
export const SIMPLE = TIMING_PRESETS.easy;
export const ADVANCED = TIMING_PRESETS.hard;

export interface Prompt {
  readonly phase: Phase;
  /** One arrow, or two to press together. */
  readonly arrows: readonly Arrow[];
  /** When the arrows reach the line, s after the swing starts. */
  readonly time: number;
}

/** Seeded random numbers in [0, 1), so a swing can be replayed or tested (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fresh random arrows for each swing moment, arriving at the line in tempo. */
export function makePrompts(settings: TimingSettings, putting: boolean, random: () => number): Prompt[] {
  const phases = putting ? settings.puttPhases : settings.phases;
  const first = putting ? PUTT_BEAT[phases[0]] ?? 0 : BEAT[phases[0]];
  return phases.map((phase) => {
    const a = ARROWS[Math.floor(random() * ARROWS.length)];
    let arrows: Arrow[] = [a];
    if (!putting && settings.doubles.includes(phase)) {
      const others = ARROWS.filter((x) => x !== a);
      arrows = [a, others[Math.floor(random() * others.length)]];
    }
    const beat = (putting ? PUTT_BEAT[phase] ?? 0 : BEAT[phase]) - first;
    return { phase, arrows, time: settings.laneTime + beat * settings.tempo };
  });
}

export interface Judgement {
  readonly prompt: Prompt;
  /** Arrows pressed for this prompt, in order. */
  readonly pressed: readonly Arrow[];
  /** Press time minus target time, s, for the press furthest off; negative is early. Null when nothing was pressed. */
  readonly offset: number | null;
  readonly grade: Grade;
  /** Signed size of the fault: 0 is perfect, negative early, positive late. Up to 3 for a wrong key. */
  readonly severity: number;
}

const MISS_SEVERITY = 2;
const WRONG_SEVERITY = 3;

export function gradeOf(offset: number, windows: Windows): Grade {
  const late = Math.abs(offset);
  return late <= windows.perfect ? 'perfect' : late <= windows.great ? 'great' : late <= windows.good ? 'good' : 'poor';
}

export interface Press {
  readonly arrow: Arrow;
  readonly time: number;
}

/**
 * Scores one prompt from its presses. Inside the perfect band there is no fault; beyond it the fault grows with
 * how far off the worst press was. A wrong arrow is a strong penalty, and a missed or half-pressed prompt nearly as
 * bad, each in a random direction.
 */
export function judge(prompt: Prompt, presses: readonly Press[] | Press | null, windows: Windows, random: () => number): Judgement {
  const list = presses === null ? [] : Array.isArray(presses) ? presses : [presses as Press];
  const randomSign = () => (random() < 0.5 ? -1 : 1);
  const pressed = list.map((p) => p.arrow);
  const offsets = list.map((p) => p.time - prompt.time);
  const worst = offsets.reduce<number | null>((w, o) => (w === null || Math.abs(o) > Math.abs(w) ? o : w), null);
  if (list.some((p) => !prompt.arrows.includes(p.arrow)) || new Set(pressed).size < pressed.length) {
    return { prompt, pressed, offset: worst, grade: 'wrong', severity: randomSign() * WRONG_SEVERITY };
  }
  if (list.length < prompt.arrows.length || worst === null) {
    return { prompt, pressed, offset: worst, grade: 'miss', severity: randomSign() * MISS_SEVERITY };
  }
  const grade = gradeOf(worst, windows);
  const late = Math.abs(worst);
  const severity = grade === 'perfect' ? 0 : Math.sign(worst) * (0.3 + (1.2 * (late - windows.perfect)) / (windows.poor - windows.perfect));
  return { prompt, pressed, offset: worst, grade, severity };
}

/** A swing in progress: feed it key presses and the clock; it judges each prompt once. */
export class TimingRun {
  readonly prompts: readonly Prompt[];
  readonly judgements: (Judgement | null)[];
  private readonly settings: TimingSettings;
  private readonly random: () => number;
  private pending: Press[] = [];

  constructor(prompts: readonly Prompt[], settings: TimingSettings, random: () => number) {
    this.prompts = prompts;
    this.settings = settings;
    this.random = random;
    this.judgements = prompts.map(() => null);
  }

  /** The next prompt still waiting for a press, or -1. */
  get current(): number {
    return this.judgements.findIndex((j) => j === null);
  }

  get finished(): boolean {
    return this.current === -1;
  }

  /** Judges a key press against the next prompt. Presses well before its window are ignored. */
  press(arrow: Arrow, time: number): Judgement | null {
    this.advance(time);
    const i = this.current;
    if (i === -1) return null;
    const prompt = this.prompts[i];
    if (time < prompt.time - this.settings.windows.poor) return null;
    const presses = [...this.pending, { arrow, time }];
    const wrong = !prompt.arrows.includes(arrow) || this.pending.some((p) => p.arrow === arrow);
    if (!wrong && presses.length < prompt.arrows.length) {
      this.pending = presses;
      return null;
    }
    this.pending = [];
    const judgement = judge(prompt, presses, this.settings.windows, this.random);
    this.judgements[i] = judgement;
    return judgement;
  }

  /** Marks prompts whose window has passed as missed (or half pressed). Returns the new judgements. */
  advance(time: number): Judgement[] {
    const missed: Judgement[] = [];
    for (let i = this.current; i !== -1 && time > this.prompts[i].time + this.settings.windows.poor; i = this.current) {
      const judgement = judge(this.prompts[i], this.pending, this.settings.windows, this.random);
      this.pending = [];
      this.judgements[i] = judgement;
      missed.push(judgement);
    }
    return missed;
  }
}

/** What the timing did to the swing. */
export interface Faults {
  readonly speedFactor: number;
  readonly attack: number;
  readonly path: number;
  readonly face: number;
  readonly loft: number;
  /** Where the bottom of the swing and the strike point moved. */
  readonly strike: Strike;
}

export const NO_FAULTS: Faults = { speedFactor: 1, attack: 0, path: 0, face: 0, loft: 0, strike: CENTRED_STRIKE };

/**
 * Turns judgements into club delivery faults. Swinging harder than full amplifies every fault; easing off
 * dampens them.
 */
export function faultsFrom(judgements: readonly Judgement[], effort: number, putting: boolean, random: () => number): Faults {
  const amplify = putting ? 1 : Math.min(2, Math.max(0.6, 1 + 4 * (effort - 1)));
  let speedFactor = 1;
  let attack = 0;
  let path = 0;
  let face = 0;
  let loft = 0;
  let lowPointShift = 0;
  let depth = 0;
  let toe = 0;
  for (const j of judgements) {
    const s = j.severity * amplify;
    if (putting) {
      if (j.prompt.phase === 'takeaway') path += degrees(0.6) * s;
      if (j.prompt.phase === 'top') speedFactor *= 1 + 0.06 * s;
      if (j.prompt.phase === 'strike') {
        face += degrees(0.8) * s;
        toe += 0.003 * s;
      }
      continue;
    }
    switch (j.prompt.phase) {
      case 'takeaway':
        attack += degrees(1.2) * s;
        path += degrees(1.0) * s;
        break;
      case 'set':
        speedFactor *= Math.max(0.6, 1 - 0.03 * Math.max(0, s));
        loft += degrees(1.0) * s;
        break;
      case 'top':
        speedFactor *= Math.max(0.5, 1 - 0.05 * Math.abs(s));
        face += degrees(0.8) * Math.max(0, s);
        break;
      case 'transition':
        path += degrees(2.5) * s;
        attack += degrees(1.0) * s;
        break;
      case 'release':
        face += degrees(2.2) * s;
        loft -= degrees(1.5) * s;
        break;
      case 'strike':
        // Early: the arc bottoms out behind the ball (fat). Late: it is still rising past the ball (thin).
        lowPointShift += 0.04 * s;
        depth += 0.002 * Math.max(0, -s);
        toe += 0.004 * Math.abs(s) * (random() < 0.5 ? -1 : 1);
        break;
    }
  }
  return { speedFactor, attack, path, face, loft, strike: { lowPointShift, depth, toe } };
}

export function applyFaults(d: Delivery, f: Faults): Delivery {
  return {
    clubSpeed: d.clubSpeed * f.speedFactor,
    attackAngle: d.attackAngle + f.attack,
    clubPath: d.clubPath + f.path,
    faceAngle: d.faceAngle + f.face,
    dynamicLoft: Math.max(0, d.dynamicLoft + f.loft),
  };
}
