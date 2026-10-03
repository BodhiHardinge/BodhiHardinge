import '../style.css';
import './game.css';
import { CourseView, type CameraMode } from '../course.ts';
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
import { loadSettings, saveSettings, SettingsDialog, teesFor } from './settings.ts';
import { slider } from './slider.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

document.body.classList.add('game');
const settings = loadSettings();

// Weather changes each round: a breeze from anywhere, warm, near sea level.
const weather = { speed: 1 + Math.random() * 6, bearing: Math.random() * 2 * Math.PI, temperature: celsius(22), humidity: 0.6, altitude: 30 };

type State = 'loading' | 'setup' | 'timing' | 'flight' | 'result';
let state: State = 'loading';
let camera: CameraMode = 'tee';
let showForces = false;

let course: LoadedCourse;
let round: Round;
let bag: ClubSpec[] = clubsFor(settings.bag);
// Each club remembers how you set up to it; aim always starts at the target.
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
const angle = (rad: number, plus = '', minus = '') => {
  const d = toDegrees(rad);
  if (!plus) return `${d.toFixed(1)}°`;
  return Math.abs(d) < 0.05 ? '0.0°' : `${Math.abs(d).toFixed(1)}° ${d > 0 ? plus : minus}`;
};

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

// Aim along the hole: at the flag when it is in reach, otherwise at the next bend of the fairway.
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
  const plane = planeOf(s);
  const delivery = applyFaults(deliveryFor(s, player()), faults);
  const contact: ContactReport = contactFor(delivery, s.club, plane, lieGeometry(lie === 'Tee' && s.club.head === 'putter' ? 'Fairway' : lie), lie === 'Tee', {
    lowPointShift: faults.strike.lowPointShift,
    depth: (s.depth ?? 0) + faults.strike.depth,
    toe: faults.strike.toe,
  });
  const raw = strike(delivery, s.club, contact.contact);
  const launch = withBall(raw, s.club, settings.bag.ball, s.club.head === 'driver' ? driverSpin(settings.bag) : 1);
  const shot = simulateShot(launch, environment(f), { terrain, hole: localHole(f) });
  return { record: { club: s.club, plane, ballPosition: s.ballPosition, aim: s.aim, delivery, contact, launch, shot }, frame: f, terrain };
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
 * Effort that sends the ball `target` metres in total with this setup, lie and contact (a planned, perfectly timed
 * swing). Putts are measured on flat green: read the slope yourself from the dotted line.
 */
function effortFor(s: Setup, target: number, putt: boolean): number {
  const f = frame();
  let lo = 0.01;
  let hi = 1.3;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    const shot = putt
      ? simulateShot(strike(deliveryFor({ ...s, effort: mid }, player()), s.club), environment(f), { surface: SURFACES.green })
      : predict({ ...s, effort: mid }).record.shot;
    if (shot.holed) return Number(mid.toFixed(3));
    if (shot.total > target) hi = mid;
    else lo = mid;
  }
  return Number(((lo + hi) / 2).toFixed(3));
}

function suggestClub(): { club: ClubSpec; reason: string } {
  const lie = lieName();
  const toPin = round.toPin;
  const putter = bag.find((c) => c.head === 'putter')!;
  if (lie === 'Green') return { club: putter, reason: 'On the green: putter. The flat-green pace is set; the dotted line shows the real break.' };
  const allowed = bag.filter((c) => c.head !== 'putter' && (c.head !== 'driver' || lie === 'Tee'));
  const target = Math.min(toPin, carryOf(allowed[0]) + 25);
  if (lie === 'Sand' && toPin < 60) {
    const sw = allowed.find((c) => c.name === 'Sand Wedge') ?? allowed[allowed.length - 1];
    return { club: sw, reason: 'Greenside bunker: open the face, dig in behind the ball (Strike + 15 to 25 mm) and splash it out.' };
  }
  if (toPin >= carryOf(allowed[0]) + 25) return { club: allowed[0], reason: `Out of reach: your longest club is the ${allowed[0].name}` };
  const wedge = allowed[allowed.length - 1];
  if (toPin < carryOf(wedge)) return { club: wedge, reason: `Inside a full ${wedge.name}: ease off` };
  const best = allowed.reduce((a, b) => (Math.abs(carryOf(b) - target) < Math.abs(carryOf(a) - target) ? b : a));
  const hint = lie === 'Rough' || lie === 'Thick rough' ? ' From the rough expect less spin and more run; woods struggle here.' : '';
  return { club: best, reason: `${best.name} carries about ${dist(carryOf(best))}.${hint}` };
}

function chooseClub(next: ClubSpec, effort?: number): void {
  setups.set(club.name, setup);
  club = next;
  const remembered = setups.get(next.name);
  setup = { ...(remembered ?? stockSetup(next)), club: next, aim: 0 };
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

function buildSetupPanel(): void {
  const panel = $('setup');
  panel.replaceChildren();
  const putter = club.head === 'putter';
  const deg = (key: 'shaftLean' | 'aim' | 'face' | 'path' | 'plane', label: string, hint: string, range: number) =>
    slider({
      label, hint, unit: '°', min: -range, max: range, step: 0.1, hardMin: -45, hardMax: 45,
      value: Number(toDegrees(setup[key]).toFixed(1)),
      onInput: (v) => { setup = { ...setup, [key]: degrees(v) }; refresh(); },
    });
  const sliders = [
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
    deg('aim', 'Aim', '+ right of the target', 15),
    deg('face', 'Face', '+ open to your aim', putter ? 10 : 20),
    ...(putter ? [] : [deg('path', 'Swing path', '+ in-to-out', 10), deg('plane', 'Swing plane', '+ more upright', 12)]),
  ];
  panel.append(...sliders.map((s) => s.element));
}

$('reset-setup').addEventListener('click', () => {
  setup = { ...stockSetup(club), effort: setup.effort };
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
    row('Path', angle(d.clubPath, 'in-out', 'out-in')),
    row('Face', angle(d.faceAngle, 'open', 'closed')),
    row('Dyn loft', angle(d.dynamicLoft)),
    putter ? '' : row('Spin loft', angle(spinLoft(d))),
    putter ? '' : row('Contact', contact.kind),
    putter ? '' : row('Low point', `${(contact.lowPoint * 100).toFixed(1)} cm`),
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
  return { text: `${speed(weather.speed)} ${parts.join(', ')}`, rotate: rel + 180 };
}

function renderHud(): void {
  const h = round.current;
  const total = round.total;
  const toPar = total.strokes === 0 || total.toPar === 0 ? 'E' : total.toPar > 0 ? `+${total.toPar}` : `${total.toPar}`;
  const f = frame();
  const wind = windText(f);
  const pin = hole().pin;
  const rise = course.terrain.height(pin.x, pin.z) - course.terrain.height(round.ball.x, round.ball.z);
  const target = Math.hypot(pin.x - round.ball.x, pin.z - round.ball.z) > 1 && Math.abs(f.heading - Math.atan2(pin.z - round.ball.z, pin.x - round.ball.x)) > 0.02 ? 'the bend' : 'the flag';
  $('hud').innerHTML = `
    <div class="hud-hole"><span class="hud-number">${h.number}</span><div><b>Par ${h.par}</b><span>${dist(h.length)} · ${course.entry.file.name}</span></div></div>
    <dl class="hud-stats">
      <div><dt>To the flag</dt><dd>${dist(round.toPin)}</dd></div>
      <div><dt>Plays</dt><dd>${Math.abs(rise) < 1 ? 'level' : `${dist(Math.abs(rise))} ${rise > 0 ? 'uphill' : 'downhill'}`}</dd></div>
      <div><dt>Lie</dt><dd>${lieName()}</dd></div>
      <div><dt>Aiming at</dt><dd>${target}</dd></div>
      <div><dt>Stroke</dt><dd>${round.strokes.length + 1}</dd></div>
      <div><dt>Score</dt><dd>${toPar}</dd></div>
      <div class="hud-wind"><dt>Wind</dt><dd><i style="transform:rotate(${wind.rotate.toFixed(0)}deg)" aria-hidden="true">↑</i>${wind.text}</dd></div>
    </dl>`;
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
  const head = (h: (typeof holes)[number]) => `<th class="${h.number - 1 === round.hole ? 'now' : ''}">${h.number}</th>`;
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
  $('card-sub').textContent = `${course.entry.quality}. Shapes © OpenStreetMap contributors; heights: ${course.entry.file.heightSource}.`;
}

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

function swingFor(p: Prediction): Swing {
  return new Swing(p.record.delivery, { ...p.record.club, plane: p.record.plane });
}

function showScene(p: Prediction, preview: Prediction | null, atAddress: boolean): void {
  view.setScene({
    shot: p.record.shot,
    ghost: null,
    tour: null,
    trails: [],
    hole: hole(),
    swing: swingFor(p),
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

function showAddress(): void {
  const p = predict(setup);
  renderPredict(p);
  showScene(p, p, true);
  analysis.show(p.record, null, units());
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

for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
    for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    if (tab.dataset.tab === 'analysis' && played) analysis.show(played.plan.record, played.actual.record, units());
    else if (tab.dataset.tab === 'analysis' && state === 'setup') showAddress();
  });
}

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
  showScene(actual, plan, false);
  view.hit();
}

view.onFinish = () => {
  if (state !== 'flight' || !played) return;
  const shot = played.actual.record.shot;
  const local = shot.restPosition;
  const rest = fromFrame(played.actual.frame, local);
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
  renderResult(ob, water, pickedUp);
  renderCard();
  analysis.show(played.plan.record, played.actual.record, units());
  setState('result');
};

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
  let detail = ob || water ? 'One penalty stroke: play again from the same spot.' : `${contact.kind} strike. Finished on the ${lieName().toLowerCase()}.`;
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
    <p class="hint">Planned against actual, with the club's path, face, low point and strike: see Swing analysis below.</p>
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

function newShot(): void {
  setState('setup');
  played = null;
  const s = suggestClub();
  chooseClub(s.club);
  const toPin = round.toPin;
  // A greenside bunker shot: open the face and swing to enter the sand behind the ball.
  if (lieName() === 'Sand' && toPin < 60) setup = { ...setup, face: degrees(10), depth: 0.02 };
  if (s.club.head === 'putter') chooseClub(s.club, effortFor(setup, toPin + 0.4, true));
  else if (toPin < carryOf(s.club)) chooseClub(s.club, effortFor({ ...setup, effort: 1 }, toPin, false));
  $('club-hint').textContent = s.reason;
  renderHud();
  renderCard();
  showAddress();
  setCamera(camera === 'follow' ? 'tee' : camera);
}

swingButton.addEventListener('click', () => startSwing());
$<HTMLSelectElement>('speed').addEventListener('change', (e) => view.setSpeed(Number((e.target as HTMLSelectElement).value)));
$('skip').addEventListener('click', () => view.skip());
window.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (typing || document.querySelector('dialog[open]')) return;
  if (event.code === 'Enter' && state === 'flight' && !event.repeat) {
    view.skip();
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
  if (what === 'course') void startRound();
  else if (state === 'setup') refresh();
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
  const entry = COURSES.find((c) => c.id === settings.course) ?? COURSES[0];
  course = await loadCourse(entry);
  $('course-location').textContent = `${entry.file.name} · ${entry.file.location}`;
  view.setCourse({ width: course.width, depth: course.depth, heights: course.heights, codes: course.codes, height: (x, z) => course.terrain.height(x, z) });
  round = new Round(courseFrom(course));
  view.setGolfer(settings.golfer === 'mocap');
  newShot();
}

previewButton.setAttribute('aria-pressed', String(settings.showPreview));
fillClubs();
setUnits(settings.units);
void startRound();
