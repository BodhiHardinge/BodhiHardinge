import { DEFAULT_HANDICAP, SCRATCH_SPREAD, SPREAD_LABELS, spreadFor, type Spread, type SpreadKey } from '../../game/skill.ts';
import { TIMING_PRESETS, type Difficulty, type TimingSettings, type Windows } from '../../game/timing.ts';
import { BALLS, DEFAULT_BAG, DRIVERS, IRON_SETS, PUTTERS, WEDGE_GRINDS, type Bag } from '../../game/equipment.ts';
import { clubFor } from '../../physics/club.ts';
import { degrees, mph, toDegrees, toMph } from '../../physics/units.ts';
import type { UnitSystem } from '../units.ts';
import { slider } from './slider.ts';

export type TeeChoice = 'auto' | 'back' | 'middle' | 'forward';

export interface GameSettings {
  difficulty: Difficulty;
  timing: TimingSettings;
  /** Playing handicap: higher varies more. Negative for plus handicaps. */
  handicap: number;
  /** Your own natural-error values; anything not set comes from handicap and difficulty. */
  spread: Partial<Spread>;
  /** Driver club speed at full effort, m/s. */
  driverSpeed: number;
  /** Putter head speed for a full-length stroke, m/s. */
  putterSpeed: number;
  bag: Bag;
  course: string;
  tees: TeeChoice;
  golfer: 'mocap' | 'simple';
  showPreview: boolean;
  units: UnitSystem;
}

const KEY = 'ballflight.game-settings.v2';

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  difficulty: 'medium',
  timing: TIMING_PRESETS.medium,
  handicap: DEFAULT_HANDICAP.medium,
  spread: {},
  driverSpeed: mph(100),
  putterSpeed: 4,
  bag: DEFAULT_BAG,
  course: 'torrey-south',
  tees: 'auto',
  golfer: 'mocap',
  showPreview: true,
  units: 'metric',
};

export function loadSettings(): GameSettings {
  const fresh = structuredClone(DEFAULT_GAME_SETTINGS);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const saved = JSON.parse(raw) as Partial<GameSettings>;
    const difficulty = saved.difficulty && saved.difficulty in TIMING_PRESETS ? saved.difficulty : fresh.difficulty;
    return { ...fresh, ...saved, difficulty, timing: { ...TIMING_PRESETS[difficulty], ...saved.timing }, bag: { ...DEFAULT_BAG, ...saved.bag } };
  } catch {
    return fresh;
  }
}

export function saveSettings(settings: GameSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private windows and blocked storage: settings last for this visit only.
  }
}

export function teesFor(s: GameSettings): Exclude<TeeChoice, 'auto'> {
  if (s.tees !== 'auto') return s.tees;
  return s.difficulty === 'easy' ? 'forward' : s.difficulty === 'medium' ? 'middle' : 'back';
}

const BANDS: readonly (keyof Windows)[] = ['perfect', 'great', 'good', 'poor'];
const DIFFICULTY_NOTES: Record<Difficulty, string> = {
  easy: 'Three arrows a swing, wide windows, slow arrows, forward tees, small natural error.',
  medium: 'Four arrows: tempo, path, face and strike. Middle tees.',
  hard: 'Five arrows including the takeaway, tight windows, back tees.',
  pro: 'Six fast arrows including the wrist set, with doubles on transition and strike: press both together.',
};

function select<T extends string>(label: string, value: T, options: readonly { id: T; name: string; note?: string }[], onChange: (v: T) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-stack';
  const span = document.createElement('span');
  span.textContent = label;
  const sel = document.createElement('select');
  for (const o of options) sel.add(new Option(o.name, o.id));
  sel.value = value;
  const note = document.createElement('small');
  note.className = 'hint';
  const show = () => (note.textContent = options.find((o) => o.id === sel.value)?.note ?? '');
  show();
  sel.addEventListener('change', () => {
    show();
    onChange(sel.value as T);
  });
  wrap.append(span, sel, note);
  return wrap;
}

function group(title: string, hint?: string): HTMLElement {
  const g = document.createElement('div');
  g.className = 'settings-group';
  g.innerHTML = `<h3 class="subhead">${title}</h3>${hint ? `<p class="hint">${hint}</p>` : ''}`;
  return g;
}

/** The settings dialog: difficulty, handicap and natural error, timing windows, your swing, bag and ball, course. */
export class SettingsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly settings: GameSettings;
  private readonly onChange: (what: 'course' | 'other') => void;
  private readonly courses: readonly { id: string; name: string; note: string }[];

  constructor(dialog: HTMLDialogElement, settings: GameSettings, courses: readonly { id: string; name: string; note: string }[], onChange: (what: 'course' | 'other') => void) {
    this.dialog = dialog;
    this.settings = settings;
    this.courses = courses;
    this.onChange = onChange;
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  open(): void {
    this.build();
    this.dialog.showModal();
  }

  private changed(what: 'course' | 'other' = 'other'): void {
    saveSettings(this.settings);
    this.onChange(what);
  }

  private build(): void {
    const s = this.settings;
    const d = this.dialog;
    d.replaceChildren();

    const head = document.createElement('div');
    head.className = 'dialog-head';
    head.innerHTML = '<div><h2>Settings</h2><p>Changes apply from your next swing.</p></div>';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'wide-button';
    close.textContent = 'Done';
    close.addEventListener('click', () => d.close());
    head.append(close);

    const body = document.createElement('div');
    body.className = 'settings-body';

    // Difficulty
    const diff = group('Difficulty');
    const mode = document.createElement('div');
    mode.className = 'segmented mode-switch four';
    mode.setAttribute('role', 'group');
    mode.setAttribute('aria-label', 'Difficulty');
    for (const level of ['easy', 'medium', 'hard', 'pro'] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = level[0].toUpperCase() + level.slice(1);
      b.setAttribute('aria-pressed', String(s.difficulty === level));
      b.addEventListener('click', () => {
        s.difficulty = level;
        s.timing = structuredClone(TIMING_PRESETS[level]);
        s.handicap = DEFAULT_HANDICAP[level];
        s.spread = {};
        this.changed();
        this.build();
      });
      mode.append(b);
    }
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = DIFFICULTY_NOTES[s.difficulty];
    diff.append(mode, note);

    // Skill and natural error
    const skill = group('Skill and natural error', 'Even perfect timing is never perfectly repeated. Your handicap sets how much each number varies from swing to swing (one standard deviation, mid iron, good lie). Long clubs and bad lies vary more. Type your own value to override any of them.');
    const errorSliders: { key: SpreadKey; set: (v: number) => void }[] = [];
    skill.append(
      slider({
        label: 'Handicap', hint: 'negative for plus', unit: '', min: -4, max: 36, step: 1, hardMin: -10, hardMax: 54, value: s.handicap,
        onInput: (v) => {
          s.handicap = v;
          s.spread = {};
          this.changed();
          for (const e of errorSliders) e.set(this.display(e.key));
        },
      }).element,
    );
    for (const key of Object.keys(SCRATCH_SPREAD) as SpreadKey[]) {
      const info = SPREAD_LABELS[key];
      const unit = info.unit === 'percent' ? '%' : info.unit === 'degrees' ? '°' : info.unit;
      const max = info.unit === 'percent' ? 8 : info.unit === 'degrees' ? 8 : info.unit === 'cm' ? 10 : 20;
      const sl = slider({
        label: info.label, unit, min: 0, max, step: 0.1, hardMin: 0, hardMax: max * 5, value: this.display(key),
        onInput: (v) => {
          s.spread = { ...s.spread, [key]: this.toSI(key, v) };
          this.changed();
        },
      });
      errorSliders.push({ key, set: (v) => sl.set(v) });
      skill.append(sl.element);
    }

    // Timing
    const timing = group('Timing windows', 'Either side of the beat. Past the last band a press is ignored and the arrow counts as missed.');
    for (const band of BANDS) {
      timing.append(
        slider({
          label: band[0].toUpperCase() + band.slice(1), unit: 'ms', min: 10, max: 400, step: 5, hardMin: 5, hardMax: 2000,
          value: Math.round(s.timing.windows[band] * 1000),
          onInput: (ms) => {
            const windows = { ...s.timing.windows, [band]: ms / 1000 };
            for (let j = 1; j < BANDS.length; j++) windows[BANDS[j]] = Math.max(windows[BANDS[j]], windows[BANDS[j - 1]] + 0.005);
            for (let j = BANDS.length - 2; j >= 0; j--) windows[BANDS[j]] = Math.min(windows[BANDS[j]], windows[BANDS[j + 1]] - 0.005);
            s.timing = { ...s.timing, windows };
            this.changed();
          },
        }).element,
      );
    }
    timing.append(
      slider({
        label: 'Arrow travel time', hint: 'longer is easier', unit: 's', min: 0.5, max: 3, step: 0.1, hardMin: 0.2, hardMax: 10, value: s.timing.laneTime,
        onInput: (v) => { s.timing = { ...s.timing, laneTime: v }; this.changed(); },
      }).element,
      slider({
        label: 'Tempo', hint: 'gap between arrows', unit: 'x', min: 0.6, max: 2, step: 0.05, hardMin: 0.3, hardMax: 5, value: s.timing.tempo,
        onInput: (v) => { s.timing = { ...s.timing, tempo: v }; this.changed(); },
      }).element,
    );

    // Swing speed
    const player = group('Your swing', 'Set this from your R10 driver club speed. Other clubs scale like the Tour averages.');
    player.append(
      slider({
        label: 'Driver club speed', unit: 'mph', min: 60, max: 130, step: 1, hardMin: 20, hardMax: 160, value: Math.round(toMph(s.driverSpeed)),
        onInput: (v) => { s.driverSpeed = mph(v); this.changed(); },
      }).element,
      slider({
        label: 'Putter speed', hint: 'full-length stroke', unit: 'm/s', min: 2, max: 7, step: 0.1, hardMin: 0.5, hardMax: 12, value: s.putterSpeed,
        onInput: (v) => { s.putterSpeed = v; this.changed(); },
      }).element,
    );

    // Bag
    const bag = group('Bag and ball', 'Categories, not brands: the numbers are typical of each kind of club.');
    const setBag = (k: keyof Bag) => (v: string) => { s.bag = { ...s.bag, [k]: v }; this.changed(); };
    bag.append(
      select('Driver', s.bag.driver, DRIVERS, setBag('driver')),
      select('Irons', s.bag.irons, IRON_SETS, setBag('irons')),
      select('Wedges', s.bag.wedges, WEDGE_GRINDS, setBag('wedges')),
      select('Putter', s.bag.putter, PUTTERS, setBag('putter')),
      select('Ball', s.bag.ball, BALLS, setBag('ball')),
    );

    // Course
    const course = group('Course');
    course.append(
      select('Course', s.course, this.courses, (v) => { s.course = v; this.changed('course'); }),
      select<TeeChoice>('Tees', s.tees, [
        { id: 'auto', name: 'Set by difficulty' }, { id: 'back', name: 'Back' }, { id: 'middle', name: 'Middle' }, { id: 'forward', name: 'Forward' },
      ], (v) => { s.tees = v; this.changed('course'); }),
      select<'mocap' | 'simple'>('Golfer', s.golfer, [
        { id: 'mocap', name: 'Motion capture', note: 'A real golfer recorded in the CMU motion capture lab, retimed to your swing' },
        { id: 'simple', name: 'Simple mannequin', note: 'The original two-lever model' },
      ], (v) => { s.golfer = v; this.changed(); }),
    );

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'text-button';
    reset.textContent = 'Reset everything to defaults';
    reset.addEventListener('click', () => {
      Object.assign(s, structuredClone(DEFAULT_GAME_SETTINGS), { units: s.units, course: s.course });
      this.changed();
      this.build();
    });

    body.append(diff, skill, timing, player, bag, course, reset);
    d.append(head, body);
  }

  private display(key: SpreadKey): number {
    const v = spreadFor(this.settings.handicap, this.settings.difficulty, clubFor('7 Iron'), 'Fairway', this.settings.spread)[key];
    const unit = SPREAD_LABELS[key].unit;
    const out = unit === 'percent' ? v * 100 : unit === 'degrees' ? toDegrees(v) : unit === 'cm' ? v * 100 : v * 1000;
    return Number(out.toFixed(1));
  }

  private toSI(key: SpreadKey, v: number): number {
    const unit = SPREAD_LABELS[key].unit;
    return unit === 'percent' ? v / 100 : unit === 'degrees' ? degrees(v) : unit === 'cm' ? v / 100 : v / 1000;
  }
}
