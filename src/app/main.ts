import './style.css';
import { findHoleOut } from '../analysis/aim.ts';
import { launchOf } from '../analysis/compare.ts';
import { PGA_TOUR_AVERAGES, type ReferenceShot } from '../analysis/reference-data.ts';
import type { ShotRecord } from '../analysis/shots.ts';
import { referenceLaunch } from '../analysis/validate.ts';
import { clubFor, estimateDelivery } from '../physics/club.ts';
import { simulateShot, SURFACES, type Shot, type ShotOptions, type SurfaceKey } from '../physics/ground.ts';
import { makeHole } from '../physics/hole.ts';
import { Swing } from '../physics/swing.ts';
import { yards } from '../physics/units.ts';
import { FlightChart } from './charts.ts';
import { ControlPanel } from './controls.ts';
import { CourseView, type CameraMode } from './course.ts';
import { bundledLibrary, landingSpots, measuredValues } from './data.ts';
import { LibraryPanel } from './library.ts';
import { Leaderboard, type BoardRow } from './readout.ts';
import {
  DEFAULT_SETTINGS, isStandardWeather, LAUNCH_KEYS, settingsFromReference, STANDARD_SETTINGS, toEnvironment, toLaunch, type ShotSettings,
} from './state.ts';
import { unitFor, type UnitSystem } from './units.ts';

const UNITS_KEY = 'ballflight.units';
const MAX_TRAILS = 40;

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
  | { kind: 'data'; shot: ShotRecord; typical: boolean }
  | { kind: 'custom' };

const normaliseClub = (name: string) =>
  name.toLowerCase().replace(/-/g, ' ').replace(/^pw$/, 'pitching wedge').replace(/^hybrid$/, '3 hybrid').trim();

/** The Tour average for a club name such as "7 Iron", if the Tour tables have one. */
function tourFor(club: string | null): ReferenceShot | null {
  if (!club) return null;
  return PGA_TOUR_AVERAGES.find((r) => normaliseClub(r.club) === normaliseClub(club)) ?? null;
}

const settings: ShotSettings = { ...DEFAULT_SETTINGS };
let system = savedUnits();
let surface: SurfaceKey | 'hole' = 'hole';
let source: Source = { kind: 'tour', shot: PGA_TOUR_AVERAGES[0] };
let hitNext = true;
let lastRender: () => void = () => {};

const sideView = new FlightChart(element<HTMLCanvasElement>('#side-cv'), 'side');
const topView = new FlightChart(element<HTMLCanvasElement>('#top-cv'), 'top');
const board = new Leaderboard(element<HTMLTableElement>('#board'));
const boardSub = element('#board-sub');
const course = new CourseView(element<HTMLCanvasElement>('#course-cv'), element('.course'), element('#pip-legend'));
const library = new LibraryPanel(element('#library'), element<HTMLDialogElement>('#shot-dialog'), bundledLibrary());
const presetSelect = element<HTMLSelectElement>('#preset');
const surfaceSelect = element<HTMLSelectElement>('#surface');
const unitButtons = document.querySelectorAll<HTMLButtonElement>('[data-units]');
const cameraButtons = document.querySelectorAll<HTMLButtonElement>('[data-camera]');
const layerButtons = {
  forces: element<HTMLButtonElement>('#layer-forces'),
  ghost: element<HTMLButtonElement>('#layer-ghost'),
  tour: element<HTMLButtonElement>('#layer-tour'),
  trails: element<HTMLButtonElement>('#layer-trails'),
};
const layerOn = (name: keyof typeof layerButtons) => layerButtons[name].getAttribute('aria-pressed') === 'true';
const phaseLabel = element('#course-phase');
const aceStatus = element('#ace-status');

course.onPhase = (phase) => {
  phaseLabel.textContent = phase;
};
course.onCameraChange = (mode) => showCamera(mode);

let frame = 0;
function scheduleUpdate(hit = false): void {
  hitNext ||= hit;
  if (frame === 0) frame = requestAnimationFrame(update);
}

function shotOptions(): ShotOptions {
  const hole = makeHole(settings.pinDistance);
  return { hole, ...(surface === 'hole' ? {} : { surface: SURFACES[surface] }) };
}

// Evenly spaced picks keep the trails representative without flying hundreds of shots.
function sample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)]);
}

// Simulating inside the animation frame coalesces a burst of slider events into one run.
function update(): void {
  frame = 0;
  const options = shotOptions();
  const hole = options.hole!;
  const env = toEnvironment(settings);
  const launch = toLaunch(settings);
  const shot = simulateShot(launch, env, options);
  const ghost = isStandardWeather(settings) ? null : simulateShot(launch, toEnvironment({ ...settings, ...STANDARD_SETTINGS }), options);

  const clubName = source.kind === 'tour' ? source.shot.club : source.kind === 'data' ? source.shot.club : null;
  const tourReference = source.kind === 'tour' ? null : tourFor(clubName);
  const tour = tourReference ? simulateShot(referenceLaunch(tourReference), env, options) : null;

  const spec = clubFor(clubName, launch);
  const measured = source.kind === 'data' ? source.shot : {};
  const swing = new Swing(estimateDelivery(launch, spec, measured), spec);
  const selected = library.selectedShots();
  const dispersion = landingSpots(selected);
  const trails: Shot[] = layerOn('trails') ? sample(selected, MAX_TRAILS).map((s) => simulateShot(launchOf(s), env, options)) : [];

  const temperature = unitFor('temperature', system);
  const rows: BoardRow[] = [{ label: 'Your shot', tone: 'shot', shot }];
  if (tour && tourReference) rows.push({ label: `Tour ${tourReference.club}, same conditions`, tone: 'tour', shot: tour });
  if (ghost) rows.push({ label: `Calm, ${temperature.fromSI(STANDARD_SETTINGS.temperature).toFixed(0)}${temperature.label}, sea level`, tone: 'ghost', shot: ghost });
  if (source.kind === 'tour') {
    rows.push({
      label: 'Tour average (published)', tone: 'reference',
      values: { carry: yards(source.shot.carryYards), apex: yards(source.shot.apexYards), landAngle: (source.shot.landingAngleDeg * Math.PI) / 180 },
    });
  } else if (source.kind === 'data') {
    rows.push({ label: source.typical ? 'R10 typical' : 'R10 measured', tone: 'reference', values: measuredValues(source.shot) });
  }
  board.show(rows, system, hole);

  const distance = unitFor('distance', system);
  const surfaceName = surface === 'hole' ? 'The hole' : SURFACES[surface].name;
  const weather = ghost ? ` · Weather ${signed(distance.fromSI(shot.flight.carry - ghost.flight.carry))} ${distance.label} carry` : '';
  const versusTour = tour ? ` · ${signed(distance.fromSI(shot.flight.carry - tour.flight.carry))} ${distance.label} vs Tour` : '';
  boardSub.textContent = `${surfaceName} · ${temperature.fromSI(settings.temperature).toFixed(0)}${temperature.label}${weather}${versusTour}`;

  const wind = { from: settings.windDirection, speed: settings.windSpeed };
  lastRender = () => {
    const extras = {
      ghost: layerOn('ghost') ? ghost : null,
      tour: layerOn('tour') ? tour : null,
      trails,
      hole,
    };
    sideView.render(shot, system, wind, extras);
    topView.render(shot, system, wind, { ...extras, dispersion });
  };
  lastRender();

  course.setScene({ shot, ghost, tour, trails, hole, swing, club: spec, env, system, dispersion });
  if (hitNext) course.hit();
  hitNext = false;
}

function signed(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

const panel = new ControlPanel(element('#params'), settings, (key) => {
  if (source.kind !== 'custom' && LAUNCH_KEYS.includes(key)) {
    source = { kind: 'custom' };
    presetSelect.value = '';
    library.clearPlayback();
  }
  aceStatus.textContent = '';
  scheduleUpdate();
});

library.onSelectionChange = () => scheduleUpdate();
library.onPlay = (shot, typical) => {
  source = { kind: 'data', shot, typical };
  Object.assign(settings, launchOf(shot));
  const carries = library.keptShotsOf(shot.club).map((s) => s.carry).filter((c): c is number => c !== undefined).sort((a, b) => a - b);
  if (carries.length) settings.pinDistance = Math.round(carries[carries.length >> 1]);
  presetSelect.value = '';
  aceStatus.textContent = '';
  panel.refresh();
  scheduleUpdate(true);
};

function showCamera(mode: CameraMode): void {
  for (const button of cameraButtons) button.setAttribute('aria-pressed', String(button.dataset.camera === mode));
}

function applyUnits(next: UnitSystem): void {
  system = next;
  for (const button of unitButtons) button.setAttribute('aria-pressed', String(button.dataset.units === next));
  panel.setUnits(next);
  library.setUnits(next);
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
  if (presetSelect.value === '') {
    source = { kind: 'custom' };
  } else {
    const shot = PGA_TOUR_AVERAGES[Number(presetSelect.value)];
    source = { kind: 'tour', shot };
    Object.assign(settings, settingsFromReference(shot, settings));
    library.clearPlayback();
  }
  panel.refresh();
  scheduleUpdate(true);
});

surfaceSelect.append(new Option('The hole (by position)', 'hole'), ...Object.entries(SURFACES).filter(([, s]) => !('hazard' in s)).map(([key, s]) => new Option(`${s.name} everywhere`, key)));
surfaceSelect.value = surface;
surfaceSelect.addEventListener('change', () => {
  surface = surfaceSelect.value as SurfaceKey | 'hole';
  scheduleUpdate(true);
});

element('#find-ace').addEventListener('click', () => {
  aceStatus.textContent = 'Searching…';
  // Let the status paint before the search runs.
  setTimeout(() => {
    const ace = findHoleOut(toLaunch(settings), toEnvironment(settings), shotOptions().hole!, surface === 'hole' ? {} : { surface: SURFACES[surface] });
    if (!ace) {
      aceStatus.textContent = 'No small change holes this one. Move the pin closer to your carry and try again.';
      return;
    }
    const speed = unitFor('speed', system);
    const change = speed.fromSI(ace.ballSpeed - settings.ballSpeed);
    const turn = ((ace.launchDirection - settings.launchDirection) * 180) / Math.PI;
    Object.assign(settings, { ballSpeed: ace.ballSpeed, launchDirection: ace.launchDirection });
    panel.refresh();
    aceStatus.textContent = `Holed with ball speed ${signed(change)} ${speed.label} and start line ${signed(turn)}°.`;
    scheduleUpdate(true);
  }, 30);
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
for (const button of Object.values(layerButtons)) {
  button.addEventListener('click', () => {
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    course.setLayers(layerOn('forces'), layerOn('ghost'), layerOn('tour'), layerOn('trails'));
    if (button === layerButtons.trails) scheduleUpdate();
    else lastRender();
  });
}
element<HTMLSelectElement>('#speed').addEventListener('change', (event) => {
  course.setSpeed(Number((event.target as HTMLSelectElement).value));
});
element('#hit').addEventListener('click', () => course.hit());

const resize = new ResizeObserver(() => lastRender());
resize.observe(element('#side-wrap'));
resize.observe(element('#top-wrap'));

applyUnits(system);
