import './style.css';
import { PGA_TOUR_AVERAGES, type ReferenceShot } from '../analysis/reference-data.ts';
import { simulateShot, SURFACES, type Shot, type SurfaceKey } from '../physics/ground.ts';
import { FlightChart } from './charts.ts';
import { ControlPanel } from './controls.ts';
import { CourseView, type CameraMode } from './course.ts';
import { Leaderboard } from './readout.ts';
import { DEFAULT_SETTINGS, LAUNCH_KEYS, settingsFromReference, toEnvironment, toLaunch, type ShotSettings } from './state.ts';
import { unitFor, type UnitSystem } from './units.ts';

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
let surface: SurfaceKey = 'fairway';
let reference: ReferenceShot | null = PGA_TOUR_AVERAGES[0];
let shot: Shot | null = null;
let replayNext = true;

const sideView = new FlightChart(element<HTMLCanvasElement>('#side-cv'), 'side');
const topView = new FlightChart(element<HTMLCanvasElement>('#top-cv'), 'top');
const board = new Leaderboard(element<HTMLTableElement>('#board'));
const boardSub = element('#board-sub');
const course = new CourseView(element<HTMLCanvasElement>('#course-cv'), element('.course'));
const presetSelect = element<HTMLSelectElement>('#preset');
const surfaceSelect = element<HTMLSelectElement>('#surface');
const unitButtons = document.querySelectorAll<HTMLButtonElement>('[data-units]');
const cameraButtons = document.querySelectorAll<HTMLButtonElement>('[data-camera]');
const phaseLabel = element('#course-phase');

course.onPhase = (phase) => {
  phaseLabel.textContent = phase;
};
course.onCameraChange = (mode) => showCamera(mode);

let frame = 0;
function scheduleUpdate(replay = false): void {
  replayNext ||= replay;
  if (frame === 0) frame = requestAnimationFrame(update);
}

// Simulating inside the animation frame coalesces a burst of slider events into one run.
function update(): void {
  frame = 0;
  shot = simulateShot(toLaunch(settings), toEnvironment(settings), { surface: SURFACES[surface] });
  const wind = { from: settings.windDirection, speed: settings.windSpeed };
  sideView.render(shot, system, wind);
  topView.render(shot, system, wind);
  board.show(shot, system, reference);
  const temperature = unitFor('temperature', system);
  boardSub.textContent = `${SURFACES[surface].name} · ${temperature.fromSI(settings.temperature).toFixed(0)}${temperature.label}`;
  course.setShot(shot, system);
  if (replayNext) course.replay();
  replayNext = false;
}

function redrawCharts(): void {
  if (!shot) return;
  const wind = { from: settings.windDirection, speed: settings.windSpeed };
  sideView.render(shot, system, wind);
  topView.render(shot, system, wind);
}

const panel = new ControlPanel(element('#params'), settings, (key) => {
  if (reference && LAUNCH_KEYS.includes(key)) {
    reference = null;
    presetSelect.value = '';
  }
  scheduleUpdate();
});

function showCamera(mode: CameraMode): void {
  for (const button of cameraButtons) button.setAttribute('aria-pressed', String(button.dataset.camera === mode));
}

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

presetSelect.append(new Option('Custom', ''), ...PGA_TOUR_AVERAGES.map((s, i) => new Option(s.club, String(i))));
presetSelect.value = '0';
presetSelect.addEventListener('change', () => {
  reference = presetSelect.value === '' ? null : PGA_TOUR_AVERAGES[Number(presetSelect.value)];
  if (reference) Object.assign(settings, settingsFromReference(reference, settings));
  panel.refresh();
  scheduleUpdate(true);
});

surfaceSelect.append(...Object.entries(SURFACES).map(([key, s]) => new Option(s.name, key)));
surfaceSelect.value = surface;
surfaceSelect.addEventListener('change', () => {
  surface = surfaceSelect.value as SurfaceKey;
  scheduleUpdate(true);
});

for (const button of unitButtons) {
  button.addEventListener('click', () => applyUnits(button.dataset.units === 'metric' ? 'metric' : 'imperial'));
}
for (const button of cameraButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.camera as CameraMode;
    showCamera(mode);
    course.setCamera(mode);
    if (mode === 'follow') course.replay();
  });
}
element('#replay').addEventListener('click', () => course.replay());

const resize = new ResizeObserver(redrawCharts);
resize.observe(element('#side-wrap'));
resize.observe(element('#top-wrap'));

applyUnits(system);
