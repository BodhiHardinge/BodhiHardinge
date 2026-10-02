import './style.css';
import { PGA_TOUR_AVERAGES, type ReferenceShot } from '../analysis/reference-data.ts';
import { simulateFlight } from '../physics/flight.ts';
import { FlightChart } from './charts.ts';
import { ControlPanel } from './controls.ts';
import { Readout } from './readout.ts';
import { DEFAULT_SETTINGS, LAUNCH_KEYS, settingsFromReference, toEnvironment, toLaunch, type ShotSettings } from './state.ts';
import type { UnitSystem } from './units.ts';

const UNITS_KEY = 'ballflight.units';

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element ${selector}`);
  return found;
}

function savedUnits(): UnitSystem {
  try {
    return localStorage.getItem(UNITS_KEY) === 'metric' ? 'metric' : 'imperial';
  } catch {
    return 'imperial';
  }
}

const settings: ShotSettings = { ...DEFAULT_SETTINGS };
let system = savedUnits();
let reference: ReferenceShot | null = PGA_TOUR_AVERAGES[0];

const sideView = new FlightChart(element<HTMLCanvasElement>('#side-cv'), 'side');
const topView = new FlightChart(element<HTMLCanvasElement>('#top-cv'), 'top');
const readout = new Readout(element('#readout'));
const presetSelect = element<HTMLSelectElement>('#preset');
const unitButtons = document.querySelectorAll<HTMLButtonElement>('[data-units]');

let frame = 0;
function scheduleUpdate(): void {
  if (frame === 0) frame = requestAnimationFrame(update);
}

// Simulating inside the animation frame coalesces a burst of slider events into one run.
function update(): void {
  frame = 0;
  const result = simulateFlight(toLaunch(settings), toEnvironment(settings));
  const wind = { from: settings.windDirection, speed: settings.windSpeed };
  sideView.render(result, system, wind);
  topView.render(result, system, wind);
  readout.show(result, system, reference);
}

const panel = new ControlPanel(element('#params'), settings, (key) => {
  if (reference && LAUNCH_KEYS.includes(key)) {
    reference = null;
    presetSelect.value = '';
  }
  scheduleUpdate();
});

function applyUnits(next: UnitSystem): void {
  system = next;
  for (const button of unitButtons) button.setAttribute('aria-pressed', String(button.dataset.units === next));
  panel.setUnits(next);
  try {
    localStorage.setItem(UNITS_KEY, next);
  } catch {
    // Storage can be unavailable (private mode); the choice just won't persist.
  }
  scheduleUpdate();
}

const custom = new Option('Custom', '');
presetSelect.append(custom, ...PGA_TOUR_AVERAGES.map((shot, i) => new Option(shot.club, String(i))));
presetSelect.value = '0';
presetSelect.addEventListener('change', () => {
  reference = presetSelect.value === '' ? null : PGA_TOUR_AVERAGES[Number(presetSelect.value)];
  if (reference) Object.assign(settings, settingsFromReference(reference, settings));
  panel.refresh();
  scheduleUpdate();
});

for (const button of unitButtons) {
  button.addEventListener('click', () => applyUnits(button.dataset.units === 'metric' ? 'metric' : 'imperial'));
}

const resize = new ResizeObserver(scheduleUpdate);
resize.observe(element('#side-wrap'));
resize.observe(element('#top-wrap'));

applyUnits(system);
