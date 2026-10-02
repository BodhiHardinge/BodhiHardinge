import type { SettingKey, ShotSettings } from './state.ts';
import { DEGREES, PERCENT, RPM, unitFor, type DisplayUnit, type Measure, type UnitSystem } from './units.ts';

interface Range {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

interface ControlSpec {
  readonly key: SettingKey;
  readonly label: string;
  readonly hint?: string;
  readonly section: string;
  readonly unit: DisplayUnit | Measure;
  /** Slider travel only; typed values may go beyond it. */
  readonly range: Range | Record<UnitSystem, Range>;
  /** Physical bounds in SI that even typed values must respect. */
  readonly limit?: { readonly min?: number; readonly max?: number };
}

const DEG = Math.PI / 180;

const CONTROLS: readonly ControlSpec[] = [
  { key: 'ballSpeed', limit: { min: 0.5 }, label: 'Ball speed', section: 'Launch', unit: 'speed',
    range: { imperial: { min: 20, max: 200, step: 0.5 }, metric: { min: 9, max: 90, step: 0.5 } } },
  { key: 'launchAngle', limit: { min: -89 * DEG, max: 89 * DEG }, label: 'Launch angle', section: 'Launch', unit: DEGREES, range: { min: 0, max: 45, step: 0.1 } },
  { key: 'launchDirection', limit: { min: -89 * DEG, max: 89 * DEG }, label: 'Launch direction', hint: '+ right', section: 'Launch', unit: DEGREES,
    range: { min: -20, max: 20, step: 0.1 } },
  { key: 'spinRate', limit: { min: 0 }, label: 'Spin rate', section: 'Launch', unit: RPM, range: { min: 0, max: 12000, step: 50 } },
  { key: 'spinAxis', limit: { min: -89 * DEG, max: 89 * DEG }, label: 'Spin axis', hint: '+ curves right', section: 'Launch', unit: DEGREES,
    range: { min: -45, max: 45, step: 0.5 } },
  { key: 'windSpeed', limit: { min: 0 }, label: 'Wind speed', hint: 'at 10 m', section: 'Conditions', unit: 'speed',
    range: { imperial: { min: 0, max: 40, step: 0.5 }, metric: { min: 0, max: 18, step: 0.5 } } },
  { key: 'windDirection', label: 'Wind from', hint: '0 head, 90 right', section: 'Conditions', unit: DEGREES,
    range: { min: 0, max: 355, step: 5 } },
  { key: 'altitude', limit: { min: -430, max: 9000 }, label: 'Altitude', section: 'Conditions', unit: 'altitude',
    range: { imperial: { min: 0, max: 10000, step: 50 }, metric: { min: 0, max: 3000, step: 10 } } },
  { key: 'temperature', limit: { min: 213, max: 333 }, label: 'Temperature', section: 'Conditions', unit: 'temperature',
    range: { imperial: { min: 20, max: 110, step: 1 }, metric: { min: -5, max: 45, step: 1 } } },
  { key: 'humidity', limit: { min: 0, max: 1 }, label: 'Humidity', section: 'Conditions', unit: PERCENT, range: { min: 0, max: 100, step: 1 } },
  { key: 'pinDistance', limit: { min: 1 }, label: 'Pin distance', section: 'Hole', unit: 'distance',
    range: { imperial: { min: 30, max: 380, step: 1 }, metric: { min: 30, max: 350, step: 1 } } },
];

const decimals = (step: number) => (Number.isInteger(step) ? 0 : String(step).split('.')[1].length);
const clamp = (v: number, r: Range) => Math.min(r.max, Math.max(r.min, v));
const limitSI = (v: number, spec: ControlSpec) => Math.min(spec.limit?.max ?? Infinity, Math.max(spec.limit?.min ?? -Infinity, v));
const round = (v: number, r: Range) => Number(v.toFixed(decimals(r.step)));

interface BoundControl {
  readonly spec: ControlSpec;
  readonly range: HTMLInputElement;
  readonly number: HTMLInputElement;
}

/** The sidebar sliders. Values live in SI in `settings`; the inputs show them in the chosen units. */
export class ControlPanel {
  private readonly container: HTMLElement;
  private readonly settings: ShotSettings;
  private readonly onChange: (key: SettingKey) => void;
  private bound: BoundControl[] = [];
  private system: UnitSystem = 'imperial';

  constructor(container: HTMLElement, settings: ShotSettings, onChange: (key: SettingKey) => void) {
    this.container = container;
    this.settings = settings;
    this.onChange = onChange;
  }

  setUnits(system: UnitSystem): void {
    this.system = system;
    this.build();
  }

  /** Re-reads every value from the settings, e.g. after a preset is applied. */
  refresh(): void {
    for (const b of this.bound) this.show(b);
  }

  private unitOf(spec: ControlSpec): DisplayUnit {
    return typeof spec.unit === 'string' ? unitFor(spec.unit, this.system) : spec.unit;
  }

  private rangeOf(spec: ControlSpec): Range {
    return 'step' in spec.range ? spec.range : spec.range[this.system];
  }

  // Shows the exact value to the field's precision; only the slider thumb snaps to its step.
  private show(b: BoundControl): void {
    const r = this.rangeOf(b.spec);
    const value = this.unitOf(b.spec).fromSI(this.settings[b.spec.key]);
    b.range.value = String(clamp(value, r));
    b.number.value = value.toFixed(decimals(r.step));
    b.number.classList.toggle('beyond', value < r.min || value > r.max);
  }

  private commit(b: BoundControl, displayValue: number): void {
    this.settings[b.spec.key] = limitSI(this.unitOf(b.spec).toSI(displayValue), b.spec);
    b.number.classList.toggle('beyond', displayValue < this.rangeOf(b.spec).min || displayValue > this.rangeOf(b.spec).max);
    this.onChange(b.spec.key);
  }

  private build(): void {
    this.container.replaceChildren();
    this.bound = [];
    let section = '';

    for (const spec of CONTROLS) {
      if (spec.section !== section) {
        section = spec.section;
        const head = document.createElement('h2');
        head.className = 'section-head';
        head.textContent = section;
        this.container.append(head);
      }

      const r = this.rangeOf(spec);
      const id = `setting-${spec.key}`;

      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = spec.label;
      const labelRow = document.createElement('div');
      labelRow.className = 'param-label';
      labelRow.append(label);
      if (spec.hint) {
        const hint = document.createElement('span');
        hint.className = 'param-hint';
        hint.textContent = spec.hint;
        labelRow.append(hint);
      }

      const range = document.createElement('input');
      range.type = 'range';
      range.id = `${id}-slider`;
      range.setAttribute('aria-label', spec.label);
      const number = document.createElement('input');
      number.type = 'number';
      number.id = id;
      number.inputMode = 'decimal';
      range.min = String(r.min);
      range.max = String(r.max);
      number.title = `Slider runs ${r.min} to ${r.max}; type any value to go beyond it`;
      range.step = String(r.step);
      number.step = String(10 ** -decimals(r.step));

      const unitLabel = document.createElement('span');
      unitLabel.className = 'param-unit';
      unitLabel.textContent = this.unitOf(spec).label;

      const row = document.createElement('div');
      row.className = 'param-row';
      row.append(range, number, unitLabel);

      const wrap = document.createElement('div');
      wrap.className = 'param';
      wrap.append(labelRow, row);
      this.container.append(wrap);

      const b: BoundControl = { spec, range, number };
      this.bound.push(b);
      this.show(b);

      range.addEventListener('input', () => {
        const v = Number(range.value);
        number.value = v.toFixed(decimals(r.step));
        this.commit(b, v);
      });
      // Typed values are applied when the field is committed, and may go past the slider's ends.
      number.addEventListener('change', () => {
        const parsed = Number(number.value);
        const typed = Number.isFinite(parsed) && number.value !== '' ? parsed : Number(range.value);
        const unit = this.unitOf(spec);
        const v = round(unit.fromSI(limitSI(unit.toSI(typed), spec)), r);
        number.value = v.toFixed(decimals(r.step));
        range.value = String(clamp(v, r));
        this.commit(b, v);
      });
    }
  }
}
