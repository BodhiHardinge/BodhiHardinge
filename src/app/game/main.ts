import '../style.css';
import './game.css';
import { CourseView, type CameraMode } from '../course.ts';
import { GreenRead, SLOPE_BANDS } from '../green-read.ts';
import { atmosphereAt } from '../../physics/atmosphere.ts';
import type { ClubSpec } from '../../physics/club.ts';
import { contactFor, lieGeometry, type ContactReport } from '../../physics/contact.ts';
import type { Environment } from '../../physics/dynamics.ts';
import { simulateShot, SURFACES } from '../../physics/ground.ts';
import { fromFrame, holeInFrame, frameFacing, type Frame, type HoleLayout, type Point } from '../../physics/hole.ts';
import { spinLoft, strike } from '../../physics/impact.ts';
import { deliveryFor, planeOf, stockSetup, type Player, type Setup } from '../../physics/setup.ts';
import { Swing } from '../../physics/swing.ts';
import { FramedTerrain } from '../../physics/terrain.ts';
import { celsius, degrees, toDegrees, toRpm } from '../../physics/units.ts';
import { CALM } from '../../physics/wind.ts';
import { aimPoint, holeLayout, playingLength, teeFor, type CourseFileHole } from '../../game/course-file.ts';
import type { Course } from '../../game/course.ts';
import { clubsFor, driverSpin, withBall } from '../../game/equipment.ts';
import { Round, scoreName } from '../../game/round.ts';
import { combineFaults, naturalError, spreadFor } from '../../game/skill.ts';
import { applyFaults, faultsFrom, makePrompts, NO_FAULTS, PHASE_INFO, type Faults, type Judgement } from '../../game/timing.ts';
import { unitFor, type UnitSystem } from '../units.ts';
import { SwingAnalysis, type SwingRecord } from './analysis.ts';
import { COURSES, loadCourse, type LoadedCourse } from './course-loader.ts';
import { Lane } from './lane.ts';
import { compassName, loadSettings, saveSettings, SettingsDialog, teesFor } from './settings.ts';
import { slider, type Slider } from './slider.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

document.body.classList.add('game');
const settings = loadSettings();
// Test and sharing hooks: ?course=sun-city&hole=3&ball=412,880 starts there.
const params = new URLSearchParams(location.search);
if (params.get('course')) settings.course = params.get('course')!;

/** The weather for this round: the settings' fixed values, or a fresh random breeze. */
const weather = { speed: 0, bearing: 0, temperature: celsius(22), humidity: 0.6, altitude: 30 };
function applyWeather(reroll: boolean): void {
  const w = settings.weather;
  if (w.random) {
    if (reroll || weather.speed === 0) {
      weather.speed = 1 + Math.random() * 6;
      weather.bearing = Math.random() * 2 * Math.PI;
    }
  } else {
    weather.speed = w.speed;
    // Compass "from" (0 north, 90 east) to the engine's bearing (from +x east toward +z south).
    weather.bearing = degrees(w.from - 90);
  }
  weather.temperature = w.temperature;
}

type State = 'loading' | 'setup' | 'timing' | 'flight' | 'result';
let state: State = 'loading';
let camera: CameraMode = 'tee';
let showForces = false;
// The player's green read choice for this hole; null follows the setting (on near the green).
let greenOverride: boolean | null = null;
let greenHole = -1;

let course: LoadedCourse;
let round: Round;
let bag: ClubSpec[] = clubsFor(settings.bag);
// Each club remembers how you set up to it; aim carries over between clubs on the same shot.
const setups = new Map<string, Setup>();
let club: ClubSpec = bag[0];
let setup: Setup = stockSetup(club);

interface Prediction {
  readonly record: SwingRecord;
  readonly frame: Frame;
  readonly terrain: FramedTerrain;
}

interface Played {
  readonly actual: Prediction;
  readonly plan: Prediction;
  readonly judgements: readonly Judgement[];
  readonly lie: string;
  readonly from: Point;
}
let played: Played | null = null;
let lastFlags = { ob: false, water: false, pickedUp: false };

const player = (): Player => ({ driverSpeed: settings.driverSpeed, putterSpeed: settings.putterSpeed });
const units = (): UnitSystem => settings.units;
const dist = (m: number, places = 0) => `${unitFor('distance', units()).fromSI(m).toFixed(places)} ${unitFor('distance', units()).label}`;
const speed = (v: number) => `${unitFor('speed', units()).fromSI(v).toFixed(1)} ${unitFor('speed', units()).label}`;
const windSpeed = (v: number) => `${unitFor('wind', units()).fromSI(v).toFixed(0)} ${unitFor('wind', units()).label}`;
const angle = (rad: number, plus = '', minus = '') => {
  const d = toDegrees(rad);
  if (!plus) return `${d.toFixed(1)}°`;
  return Math.abs(d) < 0.05 ? '0.0°' : `${Math.abs(d).toFixed(1)}° ${d > 0 ? plus : minus}`;
};

function toast(message: string): void {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => (t.hidden = true), 5000));
}

// ---------------------------------------------------------------- The course and where the ball is

function courseFrom(loaded: LoadedCourse): Course {
  const tees = teesFor(settings);
  return {
    name: loaded.entry.file.name,
    note: loaded.entry.file.note,
    holes: loaded.entry.file.holes.map((h) => {
      const tee = teeFor(h, tees);
      return { number: h.number, par: h.par, length: playingLength(h, tee), layout: holeLayout(h), tee };
    }),
  };
}

const fileHole = (): CourseFileHole => course.entry.file.holes[round.hole];
const hole = (): HoleLayout => round.current.layout;
const longest = () => bag.filter((c) => c.head !== 'putter' && (c.head !== 'driver' || round.onTee))[0];

// The target line: at the flag when it is in reach, otherwise at the next bend of the fairway. Aim is relative to it.
function frame(): Frame {
  const reach = lieName() === 'Green' ? Infinity : carryOf(longest()) + 25;
  return frameFacing(round.ball, aimPoint(fileHole(), round.ball, reach));
}
const localHole = (f = frame()): HoleLayout => holeInFrame(hole(), f);

function lieName(): string {
  if (round.onTee) return 'Tee';
  return course.terrain.surface(round.ball.x, round.ball.z).name;
}

function environment(f: Frame): Environment {
  return {
    atmosphere: atmosphereAt(weather.altitude, weather.temperature, weather.humidity),
    wind: { ...CALM, speed: weather.speed, direction: weather.bearing - f.heading },
    landingHeight: 0,
  };
}

/** What a swing from this setup does, with the given faults (none: the planned swing). */
function predict(s: Setup, faults: Faults = NO_FAULTS): Prediction {
  const f = frame();
  const terrain = new FramedTerrain(course.terrain, f);
  const lie = lieName();
  const teed = lie === 'Tee' && s.club.head !== 'putter';
  const plane = planeOf(s);
  const delivery = applyFaults(deliveryFor(s, player()), faults);
  const contact: ContactReport = contactFor(delivery, s.club, plane, lieGeometry(teed ? 'Tee' : lie === 'Tee' ? 'Fairway' : lie), teed, {
    lowPointShift: faults.strike.lowPointShift,
    depth: (s.depth ?? 0) + faults.strike.depth,
    toe: faults.strike.toe,
  });
  const raw = strike(delivery, s.club, contact.contact);
  const launch = withBall(raw, s.club, settings.bag.ball, s.club.head === 'driver' ? driverSpin(settings.bag) : 1);
  const shot = simulateShot(launch, environment(f), { terrain, hole: localHole(f) });
  const swing = new Swing(delivery, { ...s.club, plane });
  return { record: { club: s.club, plane, ballPosition: s.ballPosition, aim: s.aim, delivery, contact, launch, shot, lie, teed, swing }, frame: f, terrain };
}

// ---------------------------------------------------------------- Club choice

const stockCarry = new Map<string, number>();
function carryOf(c: ClubSpec): number {
  const key = `${c.name}|${c.loft}|${settings.driverSpeed}|${settings.bag.ball}`;
  if (!stockCarry.has(key)) {
    const launch = withBall(strike(deliveryFor(stockSetup(c), player()), c), c, settings.bag.ball);
    const calm: Environment = { atmosphere: atmosphereAt(0, celsius(22), 0.5), wind: CALM, landingHeight: 0 };
    stockCarry.set(key, simulateShot(launch, calm).flight.carry);
  }
  return stockCarry.get(key)!;
}

/**
 * Effort for a planned, perfectly timed swing with this setup. Putts are paced for `target` metres on a flat green:
 * read the slope yourself from the dotted line and the green read. Other shots take the effort that finishes nearest
 * the flag on the real ground, counting a bunker, rough or water as worse than a longer putt.
 */
function effortFor(s: Setup, target: number, putt: boolean): number {
  const f = frame();
  if (putt) {
    let lo = 0.01;
    let hi = 1.3;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      const shot = simulateShot(strike(deliveryFor({ ...s, effort: mid }, player()), s.club), environment(f), { surface: SURFACES.green });
      if (shot.total > target) hi = mid;
      else lo = mid;
    }
    return Number(((lo + hi) / 2).toFixed(3));
  }
  const pin = localHole(f).pin;
  const PENALTY: Record<string, number> = { Sand: 15, Water: 60, 'Native area': 60, 'Thick rough': 8, Rough: 4 };
  const miss = (effort: number) => {
    const p = predict({ ...s, effort });
    const shot = p.record.shot;
    if (shot.holed) return 0;
    const r = shot.restPosition;
    const where = shot.hazard === 'water' ? 'Water' : p.terrain.surface(r.x, r.z).name;
    return Math.hypot(r.x - pin.x, r.z - pin.z) + (PENALTY[where] ?? 0);
  };
  // A coarse scan finds the right neighbourhood (hazards make the curve lumpy), then a golden-section search refines it.
  let best = 1;
  let bestMiss = Infinity;
  for (let e = 0.3; e <= 1.1001; e += 0.08) {
    const m = miss(e);
    if (m < bestMiss) [best, bestMiss] = [e, m];
  }
  let lo = Math.max(0.25, best - 0.08);
  let hi = Math.min(1.15, best + 0.08);
  const g = (Math.sqrt(5) - 1) / 2;
  let a = hi - g * (hi - lo);
  let b = lo + g * (hi - lo);
  let ma = miss(a);
  let mb = miss(b);
  for (let i = 0; i < 10; i++) {
    if (ma < mb) {
      [hi, b, mb] = [b, a, ma];
      a = hi - g * (hi - lo);
      ma = miss(a);
    } else {
      [lo, a, ma] = [a, b, mb];
      b = lo + g * (hi - lo);
      mb = miss(b);
    }
  }
  return Number(((lo + hi) / 2).toFixed(3));
}

function suggestClub(): { club: ClubSpec; reason: string } {
  const lie = lieName();
  const toPin = round.toPin;
  const putter = bag.find((c) => c.head === 'putter')!;
  if (lie === 'Green') return { club: putter, reason: 'On the green: the pace is set for a flat green. Read the slope from the arrows and the dotted line, then aim with the arrow keys.' };
  const allowed = bag.filter((c) => c.head !== 'putter' && (c.head !== 'driver' || lie === 'Tee'));
  const target = Math.min(toPin, carryOf(allowed[0]) + 25);
  if (lie === 'Sand' && toPin < 60) {
    const sw = allowed.find((c) => c.name === 'Sand Wedge') ?? allowed[allowed.length - 1];
    return { club: sw, reason: 'Greenside bunker: face open, swinging to enter the sand behind the ball (Strike +20 mm) to splash it out.' };
  }
  if (toPin >= carryOf(allowed[0]) + 25) return { club: allowed[0], reason: `Out of reach: your longest club is the ${allowed[0].name}.` };
  const wedge = allowed[allowed.length - 1];
  if (toPin < carryOf(wedge)) return { club: wedge, reason: `Inside a full ${wedge.name}: ease off.` };
  const best = allowed.reduce((a, b) => (Math.abs(carryOf(b) - target) < Math.abs(carryOf(a) - target) ? b : a));
  const hint = lie === 'Rough' || lie === 'Thick rough' ? ' From the rough expect less spin and more run; woods struggle here.' : '';
  return { club: best, reason: `${best.name} carries about ${dist(carryOf(best))}.${hint}` };
}

function chooseClub(next: ClubSpec, effort?: number): void {
  setups.set(club.name, setup);
  const aim = setup.aim;
  club = next;
  const remembered = setups.get(next.name);
  setup = { ...(remembered ?? stockSetup(next)), club: next, aim };
  if (effort !== undefined) setup = { ...setup, effort };
  clubSelect.value = next.name;
  buildSetupPanel();
}

// ---------------------------------------------------------------- Panels

const clubSelect = $<HTMLSelectElement>('club');
function fillClubs(): void {
  clubSelect.replaceChildren(...bag.map((c) => new Option(c.name, c.name)));
}
clubSelect.addEventListener('change', () => {
  const next = bag.find((c) => c.name === clubSelect.value)!;
  chooseClub(next);
  if (next.head === 'putter') chooseClub(next, effortFor(setup, round.toPin + 0.4, true));
  refresh();
});

let aimSlider: Slider | null = null;
function buildSetupPanel(): void {
  const panel = $('setup');
  panel.replaceChildren();
  const putter = club.head === 'putter';
  const deg = (key: 'shaftLean' | 'face' | 'path' | 'plane', label: string, hint: string, range: number) =>
    slider({
      label, hint, unit: '°', min: -range, max: range, step: 0.1, hardMin: -45, hardMax: 45,
      value: Number(toDegrees(setup[key]).toFixed(1)),
      onInput: (v) => { setup = { ...setup, [key]: degrees(v) }; refresh(); },
    });
  aimSlider = slider({
    label: 'Aim (feet)', hint: '← → keys · + right', unit: '°', min: -45, max: 45, step: 0.5, hardMin: -180, hardMax: 180,
    value: Number(toDegrees(setup.aim).toFixed(1)),
    onInput: (v) => { setup = { ...setup, aim: degrees(v) }; refresh(); },
  });
  const sliders = [
    aimSlider,
    slider({
      label: putter ? 'Stroke' : 'Effort', hint: putter ? 'share of a full stroke' : '100 = full swing', unit: '%',
      min: putter ? 2 : 30, max: putter ? 100 : 110, step: putter ? 0.5 : 1, hardMin: 1, hardMax: 130,
      value: Number((setup.effort * 100).toFixed(1)),
      onInput: (v) => { setup = { ...setup, effort: v / 100 }; refresh(); },
    }),
    ...(putter
      ? []
      : [
          slider({
            label: 'Ball position', hint: '+ toward the target', unit: 'cm', min: -10, max: 10, step: 0.5, hardMin: -30, hardMax: 30,
            value: Number((setup.ballPosition * 100).toFixed(1)),
            onInput: (v) => { setup = { ...setup, ballPosition: v / 100 }; refresh(); },
          }),
          deg('shaftLean', 'Shaft lean', '+ hands ahead, less loft', 10),
          slider({
            label: 'Strike', hint: '+ dig deeper, - pick it clean', unit: 'mm', min: -15, max: 30, step: 1, hardMin: -60, hardMax: 80,
            value: Math.round((setup.depth ?? 0) * 1000),
            onInput: (v) => { setup = { ...setup, depth: v / 1000 }; refresh(); },
          }),
        ]),
    deg('face', 'Face', '+ open to your aim', putter ? 10 : 20),
    ...(putter ? [] : [deg('path', 'Swing path', '+ in-to-out', 10), deg('plane', 'Swing plane', '+ more upright', 12)]),
  ];
  panel.append(...sliders.map((s) => s.element));
}

/** Turns the feet: everything in the setup rotates with them. Wraps all the way round. */
function turnAim(by: number): void {
  let a = setup.aim + by;
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  setup = { ...setup, aim: a };
  aimSlider?.set(Number(toDegrees(a).toFixed(1)));
  refresh();
}

$('reset-setup').addEventListener('click', () => {
  setup = { ...stockSetup(club), effort: setup.effort, aim: setup.aim };
  buildSetupPanel();
  refresh();
});

const row = (label: string, value: string) => `<dt>${label}</dt><dd>${value}</dd>`;

function renderPredict(p: Prediction): void {
  const { delivery: d, launch: l, shot, contact } = p.record;
  const pin = localHole(p.frame).pin;
  const rest = shot.restPosition;
  const finish = shot.holed ? 'In the hole' : shot.hazard === 'water' ? 'In the water' : `${dist(Math.hypot(rest.x - pin.x, rest.z - pin.z), 1)} from the flag`;
  const putter = club.head === 'putter';
  const lands = shot.holed ? 'Green' : p.terrain.surface(rest.x, rest.z).name;
  $('predict').innerHTML = [
    '<div class="predict-group"><h3>Club</h3>',
    row('Club speed', speed(d.clubSpeed * contact.contact.speedFactor)),
    putter ? '' : row('Attack', angle(d.attackAngle, 'up', 'down')),
    row('Path', angle(d.clubPath, 'right', 'left')),
    row('Face', angle(d.faceAngle, 'right', 'left')),
    row('Dyn loft', angle(d.dynamicLoft)),
    putter ? '' : row('Spin loft', angle(spinLoft(d))),
    putter ? '' : row('Contact', contact.kind),
    putter ? '' : row('Low point', `${Math.abs(contact.lowPoint * 100).toFixed(1)} cm ${contact.lowPoint >= 0 ? 'ahead' : 'behind'}`),
    '</div><div class="predict-group"><h3>Ball</h3>',
    row('Ball speed', speed(l.ballSpeed)),
    row('Launch', angle(l.launchAngle)),
    row('Start line', angle(l.launchDirection, 'right', 'left')),
    row('Spin', `${toRpm(l.spinRate).toFixed(0)} rpm`),
    putter ? '' : row('Spin axis', angle(l.spinAxis, 'fade', 'draw')),
    '</div><div class="predict-group"><h3>Result</h3>',
    putter ? '' : row('Carry', dist(shot.flight.carry)),
    row('Total', dist(shot.total)),
    row('Finish', finish),
    row('Lands on', lands),
    '</div>',
  ].join('');
}

function windText(f: Frame): { text: string; rotate: number } {
  const from = toDegrees(weather.bearing - f.heading);
  const rel = ((from % 360) + 360) % 360;
  const along = Math.cos(degrees(rel));
  const across = Math.sin(degrees(rel));
  const parts: string[] = [];
  if (Math.abs(along) > 0.35) parts.push(along > 0 ? 'into' : 'helping');
  if (Math.abs(across) > 0.35) parts.push(across > 0 ? 'right to left' : 'left to right');
  // Compass for the record: bearing back to "from" degrees (0 north, 90 east).
  const compass = compassName(toDegrees(weather.bearing) + 90);
  return { text: `${windSpeed(weather.speed)} ${parts.join(', ')} (from the ${compass})`, rotate: rel + 180 };
}

function renderHud(): void {
  const h = round.current;
  const fh = fileHole();
  const total = round.total;
  const toPar = total.strokes === 0 || total.toPar === 0 ? 'E' : total.toPar > 0 ? `+${total.toPar}` : `${total.toPar}`;
  const f = frame();
  const wind = windText(f);
  const pin = hole().pin;
  const rise = course.terrain.height(pin.x, pin.z) - course.terrain.height(round.ball.x, round.ball.z);
  const target = Math.hypot(pin.x - round.ball.x, pin.z - round.ball.z) > 1 && Math.abs(f.heading - Math.atan2(pin.z - round.ball.z, pin.x - round.ball.x)) > 0.02 ? 'the bend' : 'the flag';
  const notes: string[] = [];
  if (fh.standInTee && round.onTee) notes.push('The map has no tee for this hole: this one is placed at the scorecard length.');
  if (fh.parFromMap) notes.push('Par from the hole on the map; the scorecard disagrees.');
  let greenRow = '';
  if (lieName() === 'Green' || lieName() === 'Fringe') {
    const slope = GreenRead.slopeAt((x, z) => course.terrain.height(x, z), round.ball.x, round.ball.z);
    // Which way it falls, relative to the line to the flag: + right.
    const c = Math.cos(f.heading);
    const s = Math.sin(f.heading);
    const across = -slope.dx * s + slope.dz * c;
    const along = slope.dx * c + slope.dz * s;
    const words = [Math.abs(along) > 0.35 ? (along > 0 ? 'downhill' : 'uphill') : '', Math.abs(across) > 0.35 ? (across > 0 ? 'breaks right' : 'breaks left') : ''].filter(Boolean).join(', ');
    greenRow = `<div class="hud-wind"><dt>Green at the ball</dt><dd>${slope.percent.toFixed(1)}% ${words || 'flat'}</dd></div>`;
  }
  $('hud').innerHTML = `
    <div class="hud-hole"><span class="hud-number">${h.number}</span><div><b>Par ${h.par}</b><span>${dist(h.length)} · ${course.entry.file.name}</span></div></div>
    <dl class="hud-stats">
      <div><dt>To the flag</dt><dd>${dist(round.toPin, round.toPin < 10 ? 1 : 0)}</dd></div>
      <div><dt>Plays</dt><dd>${Math.abs(rise) < 0.5 ? 'level' : `${dist(Math.abs(rise), 1)} ${rise > 0 ? 'up' : 'down'}`}</dd></div>
      <div><dt>Lie</dt><dd>${lieName()}</dd></div>
      <div><dt>Aim</dt><dd>${Math.abs(toDegrees(setup.aim)) < 0.05 ? `at ${target}` : `${angle(setup.aim, 'right', 'left')} of ${target}`}</dd></div>
      <div><dt>Stroke</dt><dd>${round.strokes.length + 1}</dd></div>
      <div><dt>Score</dt><dd>${toPar}</dd></div>
      <div class="hud-wind"><dt>Wind</dt><dd><i style="transform:rotate(${wind.rotate.toFixed(0)}deg)" aria-hidden="true">↑</i>${wind.text}</dd></div>
      ${greenRow}
    </dl>
    ${notes.map((n) => `<p class="hud-note">${n}</p>`).join('')}`;
  $('hole-title').textContent = `Hole ${h.number} · Par ${h.par}`;
}

function renderCard(): void {
  const holes = round.course.holes;
  const out = holes.slice(0, 9);
  const back = holes.slice(9, 18);
  const cell = (strokes: number | null, par: number) => {
    if (strokes === null) return '<td></td>';
    const d = strokes - par;
    const cls = d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 1 ? 'bogey' : d >= 2 ? 'double' : 'par';
    return `<td><span class="score ${cls}">${strokes}</span></td>`;
  };
  const sum = (list: readonly (number | null)[]) => list.reduce<number>((a, b) => a + (b ?? 0), 0);
  const parSum = (list: typeof holes) => list.reduce((a, h) => a + h.par, 0);
  const scores = round.scores;
  const len = unitFor('distance', units());
  const head = (h: (typeof holes)[number]) =>
    `<th class="${h.number - 1 === round.hole ? 'now' : ''}"><button type="button" class="hole-jump" data-hole="${h.number - 1}" title="Play hole ${h.number}">${h.number}</button></th>`;
  $('card').innerHTML = `
    <thead><tr><th>Hole</th>${out.map(head).join('')}<th>Out</th>${back.map(head).join('')}<th>In</th><th>Total</th></tr></thead>
    <tbody>
      <tr class="card-length"><th>${len.label === 'm' ? 'Metres' : 'Yards'}</th>${out.map((h) => `<td>${len.fromSI(h.length).toFixed(0)}</td>`).join('')}<td></td>${back
        .map((h) => `<td>${len.fromSI(h.length).toFixed(0)}</td>`)
        .join('')}<td></td><td></td></tr>
      <tr><th>Par</th>${out.map((h) => `<td>${h.par}</td>`).join('')}<td>${parSum(out)}</td>${back.map((h) => `<td>${h.par}</td>`).join('')}<td>${parSum(back)}</td><td>${parSum(holes)}</td></tr>
      <tr class="card-score"><th>You</th>${out.map((h, i) => cell(scores[i], h.par)).join('')}<td>${sum(scores.slice(0, 9)) || ''}</td>${back
        .map((h, i) => cell(scores[i + 9], h.par))
        .join('')}<td>${sum(scores.slice(9)) || ''}</td><td>${sum(scores) || ''}</td></tr>
    </tbody>`;
  $('card-sub').textContent = `${course.entry.quality}. Click a hole number to play it. Shapes © OpenStreetMap contributors; heights: ${course.entry.file.heightSource}.`;
}

$('card').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.hole-jump');
  if (!button || state === 'timing' || state === 'flight') return;
  const index = Number(button.dataset.hole);
  if (index === round.hole && !round.holed && round.strokes.length === 0) return;
  const unfinished = !round.holed && round.strokes.length > 0;
  if (unfinished && !confirm(`Leave hole ${round.hole + 1} unfinished and play hole ${index + 1}?`)) return;
  round.goToHole(index);
  $('result').hidden = true;
  newShot();
});

// ---------------------------------------------------------------- 3D view and analysis

const view = new CourseView($<HTMLCanvasElement>('course-cv'), document.querySelector('.course') as HTMLElement, $('pip-legend'), {
  markers: false,
  holeFairway: true,
});
view.setLayers(false, false, false, false);
view.onPhase = (phase) => {
  $('course-phase').textContent = state === 'setup' ? 'Address' : phase;
};
const analysis = new SwingAnalysis($('analysis'));

function showScene(p: Prediction, preview: Prediction | null, atAddress: boolean): void {
  view.setScene({
    shot: p.record.shot,
    ghost: null,
    tour: null,
    trails: [],
    hole: hole(),
    swing: p.record.swing,
    club,
    env: environment(p.frame),
    system: units(),
    dispersion: [],
    frame: p.frame,
    frameHeight: p.terrain.base,
    terrain: p.terrain,
    preview: settings.showPreview && preview ? preview.record.shot : null,
    atAddress,
  });
}

/** Contours and slope arrows on this hole's green when asked for, or automatically near the green. */
function greenReadWanted(): boolean {
  if (greenHole !== round.hole) {
    greenHole = round.hole;
    greenOverride = null;
  }
  const near = round.toPin < 45 || lieName() === 'Green';
  return greenOverride ?? (settings.autoGreenRead && near);
}
function updateGreenRead(): void {
  const on = state === 'setup' && greenReadWanted();
  view.setGreenRead(on ? fileHole().green : null);
  $('layer-green').setAttribute('aria-pressed', String(greenReadWanted()));
  $('green-key').hidden = !on;
}
function toggleGreenRead(): void {
  greenOverride = !greenReadWanted();
  updateGreenRead();
}

function showAddress(): void {
  const p = predict(setup);
  renderPredict(p);
  // Each display step is guarded: a drawing problem must never stop the round.
  try {
    showScene(p, p, true);
    view.setAim(club.head === 'putter' ? setup.aim : setup.aim, club.head === 'putter' ? Math.max(4, round.toPin + 3) : 60);
  } catch (error) {
    console.error(error);
    toast('The 3D view hit a problem drawing this shot; play continues.');
  }
  try {
    analysis.show(p.record, null, units());
  } catch (error) {
    console.error(error);
  }
  renderHud();
}

let pending = 0;
function refresh(): void {
  if (state !== 'setup' || pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    showAddress();
  });
}

function setCamera(mode: CameraMode): void {
  camera = mode;
  view.setCamera(mode);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-camera]')) b.setAttribute('aria-pressed', String(b.dataset.camera === mode));
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-camera]')) b.addEventListener('click', () => setCamera(b.dataset.camera as CameraMode));
view.onCameraChange = (mode) => {
  camera = mode;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-camera]')) b.setAttribute('aria-pressed', String(b.dataset.camera === mode));
};

const previewButton = $<HTMLButtonElement>('layer-preview');
previewButton.addEventListener('click', () => {
  settings.showPreview = !settings.showPreview;
  previewButton.setAttribute('aria-pressed', String(settings.showPreview));
  saveSettings(settings);
  view.setPreviewVisible(settings.showPreview);
  if (state === 'setup') showAddress();
});
const forcesButton = $<HTMLButtonElement>('layer-forces');
forcesButton.addEventListener('click', () => {
  showForces = !showForces;
  forcesButton.setAttribute('aria-pressed', String(showForces));
  view.setLayers(showForces, false, false, false);
});
$('layer-green').addEventListener('click', () => toggleGreenRead());
$('green-key').innerHTML = `<b>Green slope</b>${SLOPE_BANDS.map((b) => `<span><i style="background:${b.colour}"></i>${b.label}</span>`).join('')}<small>Arrows flow downhill · lines every 2.5 cm of height</small>`;

function showTab(name: string): void {
  for (const t of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  if (name === 'analysis' && played) analysis.show(played.plan.record, played.actual.record, units());
  else if (name === 'analysis' && state === 'setup') showAddress();
}
for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) tab.addEventListener('click', () => showTab(tab.dataset.tab!));
$('open-card').addEventListener('click', () => {
  showTab('card');
  document.querySelector('.lower')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// ---------------------------------------------------------------- Swing, flight, result

const lane = new Lane($('lane'), $('lane-track'), $('lane-phase'), $('lane-call'));
const swingButton = $<HTMLButtonElement>('swing');

function setState(next: State): void {
  state = next;
  document.body.dataset.state = next;
  swingButton.disabled = next !== 'setup';
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('#controls input, #controls select, #reset-setup')) {
    input.disabled = next !== 'setup';
  }
}

function startSwing(): void {
  if (state !== 'setup' || round.holed) return;
  setState('timing');
  view.setAim(null);
  view.setGreenRead(null);
  $('result').hidden = true;
  const putting = club.head === 'putter';
  const prompts = makePrompts(settings.timing, putting, Math.random);
  lane.start(prompts, settings.timing, Math.random, (judgements) => finishSwing(judgements));
}

function finishSwing(judgements: Judgement[]): void {
  const putting = club.head === 'putter';
  const timing = faultsFrom(judgements, setup.effort, putting, Math.random);
  const spread = spreadFor(settings.handicap, settings.difficulty, club, lieName(), settings.spread);
  const faults = combineFaults(timing, naturalError(spread, Math.random));
  const lie = lieName();
  const plan = predict(setup);
  const actual = predict(setup, faults);
  played = { actual, plan, judgements, lie, from: round.ball };
  setState('flight');
  try {
    showScene(actual, plan, false);
    view.hit();
  } catch (error) {
    // If the 3D view cannot draw the shot, the shot still counts: finish it straight away.
    console.error(error);
    toast('The 3D view hit a problem drawing this shot; the result still counts.');
    completeShot();
  }
}

view.onFinish = () => completeShot();

function completeShot(): void {
  if (state !== 'flight' || !played) return;
  const shot = played.actual.record.shot;
  const rest = fromFrame(played.actual.frame, shot.restPosition);
  const from = played.from;
  const water = shot.hazard === 'water';
  const ob = !shot.holed && !water && course.terrain.surface(rest.x, rest.z).name === 'Native area';
  // Water and out of bounds: one penalty stroke, play again from the same spot.
  round.record({ from, to: ob || water ? from : rest, club: played.actual.record.club.name, lie: played.lie, holed: shot.holed });
  if (ob || water) round.record({ from, to: from, club: 'Penalty', lie: played.lie, holed: false });
  const limit = round.current.par * 2;
  const pickedUp = !round.holed && round.strokes.length >= limit;
  if (pickedUp) {
    round.holed = true;
    round.scores[round.hole] = limit;
  }
  setState('result');
  renderResult(ob, water, pickedUp);
  renderCard();
  try {
    analysis.show(played.plan.record, played.actual.record, units());
  } catch (error) {
    console.error(error);
  }
}

function faultText(j: Judgement): string {
  if (j.grade === 'perfect') return 'On the beat';
  if (j.grade === 'miss') return j.pressed.length ? 'Only one of two keys' : 'No press';
  if (j.grade === 'wrong') return `Pressed ${j.pressed.join(' + ')}, wanted ${j.prompt.arrows.join(' + ')}`;
  const ms = Math.round(Math.abs(j.offset ?? 0) * 1000);
  return `${ms} ms ${j.offset! < 0 ? 'early' : 'late'}`;
}

function renderResult(ob: boolean, water: boolean, pickedUp: boolean): void {
  if (!played) return;
  lastFlags = { ob, water, pickedUp };
  const { shot, delivery, launch, contact } = played.actual.record;
  const pin = holeInFrame(hole(), played.actual.frame).pin;
  const rest = shot.restPosition;
  const left = Math.hypot(rest.x - pin.x, rest.z - pin.z);
  const h = round.current;
  let headline = shot.holed ? 'In the hole!' : water ? 'In the water' : ob ? 'Out of bounds' : `${dist(left, left < 10 ? 1 : 0)} to go`;
  const putt = played.actual.record.club.head === 'putter';
  let detail = ob || water ? 'One penalty stroke: play again from the same spot.' : `${putt ? '' : `${contact.kind} strike. `}Finished on the ${lieName().toLowerCase()}.`;
  if (round.holed) {
    const strokes = round.scores[round.hole]!;
    headline = pickedUp ? 'Picked up' : scoreName(strokes, h.par);
    detail = pickedUp ? `Hole scored at double par (${strokes}).` : `${strokes} strokes on the par ${h.par}.`;
  }
  const last = round.hole === round.course.holes.length - 1;
  $('result').innerHTML = `
    <div class="result-head"><h3>${headline}</h3><p>${detail}</p></div>
    <ul class="grades">${played.judgements
      .map((j) => `<li data-grade="${j.grade}"><b>${PHASE_INFO[j.prompt.phase].label}</b><span>${j.grade}</span><small>${faultText(j)}</small></li>`)
      .join('')}</ul>
    <dl class="result-stats">
      ${row('Club speed', speed(delivery.clubSpeed * contact.contact.speedFactor))}
      ${row('Face to path', angle(delivery.faceAngle - delivery.clubPath, 'open', 'closed'))}
      ${row('Ball speed', speed(launch.ballSpeed))}
      ${row('Launch', angle(launch.launchAngle))}
      ${row('Spin', `${toRpm(launch.spinRate).toFixed(0)} rpm`)}
      ${played.actual.record.club.head === 'putter' ? '' : row('Carry', dist(shot.flight.carry))}
      ${row('Total', dist(shot.total))}
    </dl>
    <p class="hint">Planned against actual: see Swing analysis below.</p>
    <button type="button" class="swing-button" id="continue">${round.holed ? (last ? 'See your round' : 'Next hole') : 'Next shot'} <kbd>Space</kbd></button>`;
  $('result').hidden = false;
  $('continue').addEventListener('click', () => advance());
}

function advance(): void {
  if (state !== 'result') return;
  $('result').hidden = true;
  if (round.holed) {
    if (round.hole === round.course.holes.length - 1) {
      const t = round.total;
      $('result').innerHTML = `<div class="result-head"><h3>Round complete</h3><p>${t.strokes} strokes, ${t.toPar === 0 ? 'level par' : t.toPar > 0 ? `${t.toPar} over par` : `${-t.toPar} under par`}.</p></div>
        <button type="button" class="swing-button" id="again">Play again</button>`;
      $('result').hidden = false;
      $('again').addEventListener('click', () => location.reload());
      return;
    }
    round.nextHole();
  }
  newShot();
}

let focusedHole = -1;
function focusHole(): void {
  if (focusedHole === round.hole) return;
  focusedHole = round.hole;
  const h = fileHole();
  const pts = [...h.tees, ...h.path, h.pin, ...h.green];
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  view.focusCourse(Math.min(...xs) - 40, Math.min(...zs) - 40, Math.max(...xs) + 40, Math.max(...zs) + 40);
}

function newShot(): void {
  setState('setup');
  played = null;
  setup = { ...setup, aim: 0 };
  focusHole();
  const s = suggestClub();
  chooseClub(s.club);
  const toPin = round.toPin;
  // A greenside bunker shot: open the face and swing to enter the sand behind the ball.
  if (lieName() === 'Sand' && toPin < 60) setup = { ...setup, face: degrees(10), depth: 0.02 };
  if (s.club.head === 'putter') chooseClub(s.club, effortFor(setup, toPin + 0.4, true));
  else if (toPin < carryOf(s.club)) chooseClub(s.club, effortFor({ ...setup, effort: 1 }, toPin, false));
  $('club-hint').textContent = s.reason;
  renderCard();
  showAddress();
  updateGreenRead();
  setCamera(camera === 'follow' ? 'tee' : camera);
}

swingButton.addEventListener('click', () => startSwing());
$<HTMLSelectElement>('speed').addEventListener('change', (e) => view.setSpeed(Number((e.target as HTMLSelectElement).value)));
$('skip').addEventListener('click', () => view.skip());
const CAMERA_KEYS: Record<string, CameraMode> = { Digit1: 'tee', Digit2: 'swing', Digit3: 'follow', Digit4: 'landing', Digit5: 'green', Digit6: 'above' };
window.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (typing || document.querySelector('dialog[open]')) return;
  if (event.code === 'Enter' && state === 'flight' && !event.repeat) {
    view.skip();
    return;
  }
  if ((event.code === 'ArrowLeft' || event.code === 'ArrowRight') && state === 'setup') {
    event.preventDefault();
    const step = event.shiftKey ? 5 : event.altKey ? 0.1 : 0.5;
    turnAim(degrees(event.code === 'ArrowLeft' ? -step : step));
    return;
  }
  if (event.code === 'KeyG' && !event.repeat) {
    toggleGreenRead();
    return;
  }
  if (CAMERA_KEYS[event.code]) {
    setCamera(CAMERA_KEYS[event.code]);
    return;
  }
  if (event.code !== 'Space') return;
  event.preventDefault();
  if (state === 'setup') startSwing();
  else if (state === 'result') advance();
});

// ---------------------------------------------------------------- Settings, units, start

const dialog = new SettingsDialog($<HTMLDialogElement>('settings'), settings, COURSES.map((c) => ({ id: c.id, name: c.file.name, note: `${c.file.location}. ${c.quality}.` })), (what) => {
  stockCarry.clear();
  bag = clubsFor(settings.bag);
  fillClubs();
  club = bag.find((c) => c.name === club.name) ?? bag[0];
  setup = { ...setup, club };
  view.setGolfer(settings.golfer === 'mocap');
  if (what === 'weather') applyWeather(false);
  if (what === 'course') void startRound();
  else if (state === 'setup') {
    refresh();
    updateGreenRead();
  }
});
$('open-settings').addEventListener('click', () => dialog.open());

function setUnits(system: UnitSystem): void {
  settings.units = system;
  saveSettings(settings);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-units]')) b.setAttribute('aria-pressed', String(b.dataset.units === system));
  if (state === 'loading') return;
  renderHud();
  renderCard();
  if (state === 'setup') showAddress();
  else if (state === 'result') renderResult(lastFlags.ob, lastFlags.water, lastFlags.pickedUp);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-units]')) b.addEventListener('click', () => setUnits(b.dataset.units as UnitSystem));

async function startRound(): Promise<void> {
  setState('loading');
  $('course-phase').textContent = 'Loading the course';
  applyWeather(true);
  const entry = COURSES.find((c) => c.id === settings.course) ?? COURSES[0];
  course = await loadCourse(entry);
  $('course-location').textContent = `${entry.file.name} · ${entry.file.location}`;
  view.setCourse({
    width: course.width, depth: course.depth, codes: course.codes, codeScale: course.codeScale, features: entry.file.features,
    height: (x, z) => course.terrain.height(x, z),
  });
  focusedHole = -1;
  round = new Round(courseFrom(course));
  const startHole = Number(params.get('hole')) - 1;
  if (startHole > 0) round.goToHole(startHole);
  const ball = params.get('ball')?.split(',').map(Number);
  if (ball && ball.length === 2 && ball.every(Number.isFinite)) {
    round.record({ from: round.ball, to: { x: ball[0], z: ball[1] }, club: 'Placed', lie: 'Tee', holed: false });
  }
  view.setGolfer(settings.golfer === 'mocap');
  newShot();
}

previewButton.setAttribute('aria-pressed', String(settings.showPreview));
fillClubs();
setUnits(settings.units);
void startRound();
