import type { Delivery } from '../physics/club.ts';
import { CLEAN_CONTACT, type Contact } from '../physics/impact.ts';
import { degrees } from '../physics/units.ts';

export type Arrow = 'up' | 'down' | 'left' | 'right';
export const ARROWS: readonly Arrow[] = ['left', 'up', 'down', 'right'];

/** The swing moments the player has to time. Each one controls part of the delivery. */
export type Phase = 'takeaway' | 'top' | 'transition' | 'release' | 'strike';

export const PHASE_INFO: Record<Phase, { label: string; controls: string }> = {
  takeaway: { label: 'Takeaway', controls: 'Plane: early snatches it steep and outside' },
  top: { label: 'Top', controls: 'Tempo: early rushes and loses speed' },
  transition: { label: 'Transition', controls: 'Path: early comes over the top' },
  release: { label: 'Release', controls: 'Face: early closes it, late leaves it open' },
  strike: { label: 'Strike', controls: 'Contact: early hits it fat, late hits it thin' },
};

export type Grade = 'perfect' | 'great' | 'good' | 'poor' | 'miss' | 'wrong';

export interface Windows {
  /** Half-widths of each timing band, s. A press outside `poor` is ignored. */
  readonly perfect: number;
  readonly great: number;
  readonly good: number;
  readonly poor: number;
}

export interface TimingSettings {
  readonly mode: 'simple' | 'advanced';
  readonly windows: Windows;
  /** How long an arrow takes to travel down the lane to the line, s. */
  readonly laneTime: number;
  /** Stretches (above 1) or quickens the gaps between prompts. */
  readonly tempo: number;
}

export const SIMPLE: TimingSettings = {
  mode: 'simple',
  windows: { perfect: 0.07, great: 0.12, good: 0.18, poor: 0.26 },
  laneTime: 1.6,
  tempo: 1,
};

export const ADVANCED: TimingSettings = {
  mode: 'advanced',
  windows: { perfect: 0.035, great: 0.07, good: 0.11, poor: 0.16 },
  laneTime: 1.1,
  tempo: 1,
};

export interface Prompt {
  readonly phase: Phase;
  readonly arrow: Arrow;
  /** When the arrow reaches the line, s after the swing starts. */
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

// Beat times in s. A full swing keeps the classic 3:1 backswing-to-downswing tempo.
const FULL: readonly (readonly [Phase, number])[] = [['takeaway', 0], ['top', 0.9], ['transition', 1.25], ['release', 1.6], ['strike', 1.9]];
const FULL_SIMPLE: readonly (readonly [Phase, number])[] = [['top', 0], ['release', 0.6], ['strike', 1.1]];
const PUTT: readonly (readonly [Phase, number])[] = [['takeaway', 0], ['top', 0.7], ['strike', 1.3]];
const PUTT_SIMPLE: readonly (readonly [Phase, number])[] = [['top', 0], ['strike', 0.7]];

/** A fresh random arrow for each swing moment, arriving at the line in tempo. */
export function makePrompts(settings: TimingSettings, putting: boolean, random: () => number): Prompt[] {
  const beats = putting ? (settings.mode === 'simple' ? PUTT_SIMPLE : PUTT) : settings.mode === 'simple' ? FULL_SIMPLE : FULL;
  return beats.map(([phase, beat]) => ({
    phase,
    arrow: ARROWS[Math.floor(random() * ARROWS.length)],
    time: settings.laneTime + beat * settings.tempo,
  }));
}

export interface Judgement {
  readonly prompt: Prompt;
  readonly pressed: Arrow | null;
  /** Press time minus target time, s; negative is early. Null when nothing was pressed. */
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

/**
 * Scores one prompt. Inside the perfect band there is no fault; beyond it the fault grows with how far off the
 * press was. A wrong arrow is a strong penalty, and a missed prompt nearly as bad, each in a random direction.
 */
export function judge(prompt: Prompt, press: { arrow: Arrow; time: number } | null, windows: Windows, random: () => number): Judgement {
  const randomSign = () => (random() < 0.5 ? -1 : 1);
  if (!press) return { prompt, pressed: null, offset: null, grade: 'miss', severity: randomSign() * MISS_SEVERITY };
  const offset = press.time - prompt.time;
  if (press.arrow !== prompt.arrow) return { prompt, pressed: press.arrow, offset, grade: 'wrong', severity: randomSign() * WRONG_SEVERITY };
  const grade = gradeOf(offset, windows);
  const late = Math.abs(offset);
  const severity = grade === 'perfect' ? 0 : Math.sign(offset) * (0.3 + (1.2 * (late - windows.perfect)) / (windows.poor - windows.perfect));
  return { prompt, pressed: press.arrow, offset, grade, severity };
}

/** A swing in progress: feed it key presses and the clock; it judges each prompt once. */
export class TimingRun {
  readonly prompts: readonly Prompt[];
  readonly judgements: (Judgement | null)[];
  private readonly settings: TimingSettings;
  private readonly random: () => number;

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
    const judgement = judge(prompt, { arrow, time }, this.settings.windows, this.random);
    this.judgements[i] = judgement;
    return judgement;
  }

  /** Marks prompts whose window has passed as missed. Returns the new judgements. */
  advance(time: number): Judgement[] {
    const missed: Judgement[] = [];
    for (let i = this.current; i !== -1 && time > this.prompts[i].time + this.settings.windows.poor; i = this.current) {
      const judgement = judge(this.prompts[i], null, this.settings.windows, this.random);
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
  readonly contact: Contact;
}

export const NO_FAULTS: Faults = { speedFactor: 1, attack: 0, path: 0, face: 0, loft: 0, contact: CLEAN_CONTACT };

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
  let turf = 0;
  let height = 0;
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
        turf += 0.012 * Math.max(0, -s);
        height -= 0.006 * Math.max(0, s);
        toe += 0.004 * Math.abs(s) * (random() < 0.5 ? -1 : 1);
        break;
    }
  }
  return { speedFactor, attack, path, face, loft, contact: { toe, height, turf } };
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
