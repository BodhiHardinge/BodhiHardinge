export interface SliderOptions {
  readonly label: string;
  readonly hint?: string;
  readonly unit: string;
  /** Slider travel, in display units. Typed values may go past it. */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Bounds that even typed values respect, in display units. */
  readonly hardMin?: number;
  readonly hardMax?: number;
  readonly value: number;
  readonly onInput: (value: number) => void;
}

export interface Slider {
  readonly element: HTMLElement;
  set(value: number): void;
}

let nextId = 0;
const decimals = (step: number) => (Number.isInteger(step) ? 0 : String(step).split('.')[1].length);

/** A labelled slider with a number box. The slider has a comfortable range; the box takes any sensible value. */
export function slider(o: SliderOptions): Slider {
  const id = `slider-${nextId++}`;
  const wrap = document.createElement('div');
  wrap.className = 'param';
  const labelRow = document.createElement('div');
  labelRow.className = 'param-label';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = o.label;
  labelRow.append(label);
  if (o.hint) {
    const hint = document.createElement('span');
    hint.className = 'param-hint';
    hint.textContent = o.hint;
    labelRow.append(hint);
  }
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(o.min);
  range.max = String(o.max);
  range.step = String(o.step);
  range.setAttribute('aria-label', o.label);
  const number = document.createElement('input');
  number.type = 'number';
  number.id = id;
  number.inputMode = 'decimal';
  number.step = String(o.step);
  number.title = `Slider runs ${o.min} to ${o.max}; type a value to go beyond it`;
  const unit = document.createElement('span');
  unit.className = 'param-unit';
  unit.textContent = o.unit;
  const row = document.createElement('div');
  row.className = 'param-row';
  row.append(range, number, unit);
  wrap.append(labelRow, row);

  const places = decimals(o.step);
  const show = (v: number) => {
    range.value = String(Math.min(o.max, Math.max(o.min, v)));
    number.value = v.toFixed(places);
    number.classList.toggle('beyond', v < o.min || v > o.max);
  };
  show(o.value);
  range.addEventListener('input', () => {
    const v = Number(range.value);
    show(v);
    o.onInput(v);
  });
  number.addEventListener('change', () => {
    const parsed = Number(number.value);
    const typed = number.value !== '' && Number.isFinite(parsed) ? parsed : Number(range.value);
    const v = Number(Math.min(o.hardMax ?? Infinity, Math.max(o.hardMin ?? -Infinity, typed)).toFixed(places));
    show(v);
    o.onInput(v);
  });
  return { element: wrap, set: show };
}
