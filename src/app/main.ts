import './style.css';
import { launchOf } from '../analysis/compare.ts';
import { PGA_TOUR_AVERAGES, type ReferenceShot } from '../analysis/reference-data.ts';
import type { ShotRecord } from '../analysis/shots.ts';
import { clubFor, estimateDelivery } from '../physics/club.ts';
import { simulateShot, SURFACES, type SurfaceKey } from '../physics/ground.ts';
import { makeHole } from '../physics/hole.ts';
import { Swing } from '../physics/swing.ts';
import { yards } from '../physics/units.ts';
import { FlightChart } from './charts.ts';
import { ControlPanel } from './controls.ts';
import { CourseView, type CameraMode } from './course.ts';
import { bundledLibrary, clubsIn, landingSpots, measuredValues, readLibrary, typicalShot, type ShotLibrary } from './data.ts';
import { Leaderboard, type BoardRow } from './readout.ts';
import {
  DEFAULT_SETTINGS, isStandardWeather, LAUNCH_KEYS, settingsFromReference, STANDARD_SETTINGS, toEnvironment, toLaunch, type ShotSettings,
} from './state.ts';
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

/** Where the current launch numbers came from. */
type Source =
  | { kind: 'tour'; shot: ReferenceShot }
  | { kind: 'data'; club: string; shot: ShotRecord; typical: boolean }
  | { kind: 'custom' };

const settings: ShotSettings = { ...DEFAULT_SETTINGS };
let system = savedUnits();
let surface: SurfaceKey | 'hole' = 'hole';
let source: Source = { kind: 'tour', shot: PGA_TOUR_AVERAGES[0] };
let library: ShotLibrary | null = bundledLibrary();
let hitNext = true;

const sideView = new FlightChart(element<HTMLCanvasElement>('#side-cv'), 'side');
const topView = new FlightChart(element<HTMLCanvasElement>('#top-cv'), 'top');
const board = new Leaderboard(element<HTMLTableElement>('#board'));
const boardSub = element('#board-sub');
const course = new CourseView(element<HTMLCanvasElement>('#course-cv'), element('.course'), element('#pip-legend'));
const presetSelect = element<HTMLSelectElement>('#preset');
const surfaceSelect = element<HTMLSelectElement>('#surface');
const clubSelect = element<HTMLSelectElement>('#data-club');
const shotSelect = element<HTMLSelectElement>('#data-shot');
const libraryName = element('#library-name');
const libraryError = element('#library-error');
const unitButtons = document.querySelectorAll<HTMLButtonElement>('[data-units]');
const cameraButtons = document.querySelectorAll<HTMLButtonElement>('[data-camera]');
const forcesButton = element<HTMLButtonElement>('#layer-forces');
const ghostButton = element<HTMLButtonElement>('#layer-ghost');
const phaseLabel = element('#course-phase');

course.onPhase = (phase) => {
  phaseLabel.textContent = phase;
};
course.onCameraChange = (mode) => showCamera(mode);

let frame = 0;
function scheduleUpdate(hit = false): void {
  hitNext ||= hit;
  if (frame === 0) frame = requestAnimationFrame(update);
}

function dataShots(club: string): ShotRecord[] {
  return library ? library.shots.filter((s) => s.club === club) : [];
}

// Simulating inside the animation frame coalesces a burst of slider events into one run.
function update(): void {
  frame = 0;
  const hole = makeHole(settings.pinDistance);
  const options = { hole, ...(surface === 'hole' ? {} : { surface: SURFACES[surface] }) };
  const launch = toLaunch(settings);
  const shot = simulateShot(launch, toEnvironment(settings), options);
  const standard = isStandardWeather(settings);
  const ghost = standard ? null : simulateShot(launch, toEnvironment({ ...settings, ...STANDARD_SETTINGS }), options);

  const clubName = source.kind === 'tour' ? source.shot.club : source.kind === 'data' ? source.club : null;
  const spec = clubFor(clubName, launch);
  const measured = source.kind === 'data' ? source.shot : {};
  const swing = new Swing(estimateDelivery(launch, spec, measured), spec);
  const dispersion = source.kind === 'data' ? landingSpots(dataShots(source.club)) : [];

  const temperature = unitFor('temperature', system);
  const rows: BoardRow[] = [{ label: 'Your shot', tone: 'shot', shot }];
  if (ghost) {
    rows.push({ label: `Calm, ${temperature.fromSI(STANDARD_SETTINGS.temperature).toFixed(0)}${temperature.label}, sea level`, tone: 'ghost', shot: ghost });
  }
  if (source.kind === 'tour') {
    rows.push({
      label: 'Tour average', tone: 'reference',
      values: { carry: yards(source.shot.carryYards), apex: yards(source.shot.apexYards), landAngle: (source.shot.landingAngleDeg * Math.PI) / 180 },
    });
  } else if (source.kind === 'data') {
    rows.push({ label: source.typical ? 'R10 typical' : 'R10 measured', tone: 'reference', values: measuredValues(source.shot) });
  }
  board.show(rows, system, hole);

  const distance = unitFor('distance', system);
  const surfaceName = surface === 'hole' ? 'The hole' : SURFACES[surface].name;
  const weather = ghost ? ` · Weather ${signed(distance.fromSI(shot.flight.carry - ghost.flight.carry))} ${distance.label} carry` : '';
  boardSub.textContent = `${surfaceName} · ${temperature.fromSI(settings.temperature).toFixed(0)}${temperature.label}${weather}`;

  const wind = { from: settings.windDirection, speed: settings.windSpeed };
  lastRender = () => {
    const shownGhost = ghostButton.getAttribute('aria-pressed') === 'true' ? ghost : null;
    sideView.render(shot, system, wind, { ghost: shownGhost, hole });
    topView.render(shot, system, wind, { ghost: shownGhost, hole, dispersion });
  };
  lastRender();

  course.setScene({ shot, ghost, hole, swing, club: spec, env: toEnvironment(settings), system, dispersion });
  if (hitNext) course.hit();
  hitNext = false;
}

let lastRender: () => void = () => {};

function signed(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

const panel = new ControlPanel(element('#params'), settings, (key) => {
  if (source.kind !== 'custom' && LAUNCH_KEYS.includes(key)) {
    source = { kind: 'custom' };
    presetSelect.value = '';
    clubSelect.value = '';
    fillShots();
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
  fillShots();
  scheduleUpdate();
}

function useDataShot(club: string, index: number): void {
  const shots = dataShots(club);
  if (shots.length === 0) return;
  const typical = index < 0;
  const shot = typical ? typicalShot(shots) : shots[index];
  source = { kind: 'data', club, shot, typical };
  Object.assign(settings, launchOf(shot));
  const carries = shots.map((s) => s.carry).filter((c): c is number => c !== undefined).sort((a, b) => a - b);
  if (carries.length) settings.pinDistance = Math.round(carries[carries.length >> 1]);
  presetSelect.value = '';
  panel.refresh();
  scheduleUpdate(true);
}

function fillLibrary(): void {
  libraryName.textContent = library ? library.name : 'No export loaded yet.';
  clubSelect.replaceChildren(new Option(library ? 'Choose a club' : 'None', ''));
  if (library) clubSelect.append(...clubsIn(library).map(({ club, count }) => new Option(`${club} (${count})`, club)));
  clubSelect.disabled = !library;
  fillShots();
}

function fillShots(): void {
  const club = clubSelect.value;
  const shots = club ? dataShots(club) : [];
  const distance = unitFor('distance', system);
  shotSelect.replaceChildren(new Option(shots.length ? 'Typical (median)' : 'Choose a club first', '-1'));
  shotSelect.append(
    ...shots.map((s, i) => new Option(`${s.date.slice(0, 10)} · ${s.carry !== undefined ? distance.fromSI(s.carry).toFixed(0) : '?'} ${distance.label}${s.classification ? ` · ${s.classification}` : ''}`, String(i))),
  );
  shotSelect.disabled = shots.length === 0;
  if (source.kind === 'data' && source.club === club && !source.typical) shotSelect.value = String(shots.indexOf(source.shot));
}

presetSelect.append(new Option('Custom', ''), ...PGA_TOUR_AVERAGES.map((s, i) => new Option(s.club, String(i))));
presetSelect.value = '0';
presetSelect.addEventListener('change', () => {
  if (presetSelect.value === '') {
    source = { kind: 'custom' };
  } else {
    const shot = PGA_TOUR_AVERAGES[Number(presetSelect.value)];
    source = { kind: 'tour', shot };
    Object.assign(settings, settingsFromReference(shot, settings));
    clubSelect.value = '';
    fillShots();
  }
  panel.refresh();
  scheduleUpdate(true);
});

surfaceSelect.append(new Option('The hole (by position)', 'hole'), ...Object.entries(SURFACES).map(([key, s]) => new Option(`${s.name} everywhere`, key)));
surfaceSelect.value = surface;
surfaceSelect.addEventListener('change', () => {
  surface = surfaceSelect.value as SurfaceKey | 'hole';
  scheduleUpdate(true);
});

clubSelect.addEventListener('change', () => {
  fillShots();
  if (clubSelect.value) useDataShot(clubSelect.value, -1);
});
shotSelect.addEventListener('change', () => {
  if (clubSelect.value) useDataShot(clubSelect.value, Number(shotSelect.value));
});
for (const [id, step] of [['#prev-shot', -1], ['#next-shot', 1]] as const) {
  element(id).addEventListener('click', () => {
    const club = clubSelect.value;
    const count = dataShots(club).length;
    if (!club || count === 0) return;
    const next = (Number(shotSelect.value) + step + count) % count;
    shotSelect.value = String(next);
    useDataShot(club, next);
  });
}
element<HTMLInputElement>('#data-file').addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    library = await readLibrary(file);
    libraryError.hidden = true;
    fillLibrary();
  } catch (error) {
    libraryError.textContent = error instanceof Error ? error.message : 'That file could not be read.';
    libraryError.hidden = false;
  }
});

for (const button of unitButtons) {
  button.addEventListener('click', () => applyUnits(button.dataset.units === 'metric' ? 'metric' : 'imperial'));
}
for (const button of cameraButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.camera as CameraMode;
    showCamera(mode);
    course.setCamera(mode);
  });
}
for (const button of [forcesButton, ghostButton]) {
  button.addEventListener('click', () => {
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    course.setLayers(forcesButton.getAttribute('aria-pressed') === 'true', ghostButton.getAttribute('aria-pressed') === 'true');
    lastRender();
  });
}
element<HTMLSelectElement>('#speed').addEventListener('change', (event) => {
  course.setSpeed(Number((event.target as HTMLSelectElement).value));
});
element('#hit').addEventListener('click', () => course.hit());

const resize = new ResizeObserver(() => lastRender());
resize.observe(element('#side-wrap'));
resize.observe(element('#top-wrap'));

fillLibrary();
applyUnits(system);
