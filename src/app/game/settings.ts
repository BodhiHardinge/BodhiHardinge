import { ADVANCED, SIMPLE, type TimingSettings, type Windows } from '../../game/timing.ts';
import { mph, toMph } from '../../physics/units.ts';
import type { UnitSystem } from '../units.ts';
import { slider } from './slider.ts';

export interface GameSettings {
  timing: TimingSettings;
  /** Driver club speed at full effort, m/s. */
  driverSpeed: number;
  /** Putter head speed for a full-length stroke, m/s. */
  putterSpeed: number;
  showPreview: boolean;
  units: UnitSystem;
}

const KEY = 'ballflight.game-settings';

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  timing: SIMPLE,
  driverSpeed: mph(100),
  putterSpeed: 4,
  showPreview: true,
  units: 'metric',
};

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_GAME_SETTINGS);
    const saved = JSON.parse(raw) as Partial<GameSettings>;
    return { ...structuredClone(DEFAULT_GAME_SETTINGS), ...saved, timing: { ...SIMPLE, ...saved.timing } };
  } catch {
    return structuredClone(DEFAULT_GAME_SETTINGS);
  }
}

export function saveSettings(settings: GameSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private windows and blocked storage: settings last for this visit only.
  }
}

const BANDS: readonly (keyof Windows)[] = ['perfect', 'great', 'good', 'poor'];

/** The settings dialog: difficulty, timing windows, arrow speed and the player's swing speed. */
export class SettingsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly settings: GameSettings;
  private readonly onChange: () => void;

  constructor(dialog: HTMLDialogElement, settings: GameSettings, onChange: () => void) {
    this.dialog = dialog;
    this.settings = settings;
    this.onChange = onChange;
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  open(): void {
    this.build();
    this.dialog.showModal();
  }

  private changed(): void {
    saveSettings(this.settings);
    this.onChange();
  }

  private build(): void {
    const s = this.settings;
    const d = this.dialog;
    d.replaceChildren();

    const head = document.createElement('div');
    head.className = 'dialog-head';
    head.innerHTML = '<div><h2>Settings</h2><p>Difficulty and timing apply from your next swing.</p></div>';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'wide-button';
    close.textContent = 'Done';
    close.addEventListener('click', () => d.close());
    head.append(close);

    const body = document.createElement('div');
    body.className = 'settings-body';

    const mode = document.createElement('div');
    mode.className = 'segmented mode-switch';
    mode.setAttribute('role', 'group');
    mode.setAttribute('aria-label', 'Difficulty');
    for (const [value, label] of [['simple', 'Simple'], ['advanced', 'Advanced']] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(s.timing.mode === value));
      b.addEventListener('click', () => {
        s.timing = structuredClone(value === 'simple' ? SIMPLE : ADVANCED);
        this.changed();
        this.build();
      });
      mode.append(b);
    }
    const modeNote = document.createElement('p');
    modeNote.className = 'hint';
    modeNote.textContent =
      s.timing.mode === 'simple'
        ? 'Simple: three arrows per swing (tempo, release, strike) with wide windows.'
        : 'Advanced: five arrows per swing (takeaway, top, transition, release, strike) with tight windows.';

    const timing = document.createElement('div');
    timing.className = 'settings-group';
    timing.innerHTML = '<h3 class="subhead">Timing windows</h3><p class="hint">Either side of the beat. Past the last band a press is ignored and the arrow counts as missed.</p>';
    BANDS.forEach((band) => {
      timing.append(
        slider({
          label: band[0].toUpperCase() + band.slice(1),
          unit: 'ms',
          min: 10,
          max: 400,
          step: 5,
          hardMin: 5,
          hardMax: 2000,
          value: Math.round(s.timing.windows[band] * 1000),
          onInput: (ms) => {
            const windows = { ...s.timing.windows, [band]: ms / 1000 };
            // Keep the bands nested: each at least as wide as the one inside it.
            for (let j = 1; j < BANDS.length; j++) windows[BANDS[j]] = Math.max(windows[BANDS[j]], windows[BANDS[j - 1]] + 0.005);
            for (let j = BANDS.length - 2; j >= 0; j--) windows[BANDS[j]] = Math.min(windows[BANDS[j]], windows[BANDS[j + 1]] - 0.005);
            s.timing = { ...s.timing, windows };
            this.changed();
          },
        }).element,
      );
    });
    timing.append(
      slider({
        label: 'Arrow travel time', hint: 'longer is easier', unit: 's', min: 0.5, max: 3, step: 0.1, hardMin: 0.2, hardMax: 10,
        value: s.timing.laneTime,
        onInput: (v) => { s.timing = { ...s.timing, laneTime: v }; this.changed(); },
      }).element,
      slider({
        label: 'Tempo', hint: 'gap between arrows', unit: 'x', min: 0.6, max: 2, step: 0.05, hardMin: 0.3, hardMax: 5,
        value: s.timing.tempo,
        onInput: (v) => { s.timing = { ...s.timing, tempo: v }; this.changed(); },
      }).element,
    );

    const player = document.createElement('div');
    player.className = 'settings-group';
    player.innerHTML = '<h3 class="subhead">Your swing</h3><p class="hint">Set this from your R10 driver club speed. Other clubs scale like the Tour averages.</p>';
    player.append(
      slider({
        label: 'Driver club speed', unit: 'mph', min: 60, max: 130, step: 1, hardMin: 20, hardMax: 160,
        value: Math.round(toMph(s.driverSpeed)),
        onInput: (v) => { s.driverSpeed = mph(v); this.changed(); },
      }).element,
      slider({
        label: 'Putter speed', hint: 'full-length stroke', unit: 'm/s', min: 2, max: 7, step: 0.1, hardMin: 0.5, hardMax: 12,
        value: s.putterSpeed,
        onInput: (v) => { s.putterSpeed = v; this.changed(); },
      }).element,
    );

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'text-button';
    reset.textContent = 'Reset everything to defaults';
    reset.addEventListener('click', () => {
      Object.assign(s, structuredClone(DEFAULT_GAME_SETTINGS), { units: s.units });
      this.changed();
      this.build();
    });

    body.append(mode, modeNote, timing, player, reset);
    d.append(head, body);
  }
}
