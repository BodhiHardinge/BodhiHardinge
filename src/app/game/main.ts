import '../style.css';
import './game.css';
import { CourseView, type CameraMode } from '../course.ts';
import { atmosphereAt } from '../../physics/atmosphere.ts';
import { CLUBS, PUTTER, type ClubSpec, type Delivery } from '../../physics/club.ts';
import type { Environment } from '../../physics/dynamics.ts';
import { simulateShot, SURFACES, type Shot } from '../../physics/ground.ts';
import { frameFacing, fromFrame, holeInFrame, surfaceOn, type Frame, type HoleLayout } from '../../physics/hole.ts';
import { LIES, spinLoft, strike, type Lie } from '../../physics/impact.ts';
import type { LaunchConditions } from '../../physics/launch.ts';
import { deliveryFor, planeOf, stockSetup, type Player, type Setup } from '../../physics/setup.ts';
import { Swing } from '../../physics/swing.ts';
import { celsius, degrees, toDegrees, toRpm } from '../../physics/units.ts';
import { CALM } from '../../physics/wind.ts';
import { SUN_CITY } from '../../game/course.ts';
import { Round, scoreName } from '../../game/round.ts';
import { applyFaults, faultsFrom, makePrompts, NO_FAULTS, PHASE_INFO, type Faults, type Judgement } from '../../game/timing.ts';
import { unitFor, type UnitSystem } from '../units.ts';
import { Lane } from './lane.ts';
import { loadSettings, saveSettings, SettingsDialog } from './settings.ts';
import { slider, type Slider } from './slider.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const settings = loadSettings();
const round = new Round(SUN_CITY);

// Yanchep: near sea level, warm, with a breeze that changes each round.
const weather = (() => {
  const speed = 1 + Math.random() * 6;
  const bearing = Math.random() * 2 * Math.PI;
  return { speed, bearing, temperature: celsius(24), humidity: 0.55, altitude: 40 };
})();

type State = 'setup' | 'timing' | 'flight' | 'result';
let state: State = 'setup';
let camera: CameraMode = 'tee';
let showForces = false;

const bag: readonly ClubSpec[] = [...CLUBS, PUTTER];
// Each club remembers how you set up to it; aim always starts at the flag.
const setups = new Map<string, Setup>();
let club: ClubSpec = CLUBS[0];
let setup: Setup = stockSetup(club);

interface Played {
  readonly shot: Shot;
  readonly delivery: Delivery;
  readonly launch: LaunchConditions;
  readonly judgements: readonly Judgement[];
  readonly faults: Faults;
  readonly frame: Frame;
  readonly lie: string;
  readonly club: ClubSpec;
}
let played: Played | null = null;
let lastFlags = { ob: false, pickedUp: false };

const player = (): Player => ({ driverSpeed: settings.driverSpeed, putterSpeed: settings.putterSpeed });
const units = (): UnitSystem => settings.units;
const dist = (m: number, places = 0) => `${unitFor('distance', units()).fromSI(m).toFixed(places)} ${unitFor('distance', units()).label}`;
const speed = (v: number) => `${unitFor('speed', units()).fromSI(v).toFixed(1)} ${unitFor('speed', units()).label}`;
const angle = (rad: number, plus = '', minus = '') => {
  const d = toDegrees(rad);
  if (!plus) return `${d.toFixed(1)}°`;
  return Math.abs(d) < 0.05 ? '0.0°' : `${Math.abs(d).toFixed(1)}° ${d > 0 ? plus : minus}`;
};

// ---------------------------------------------------------------- Where the ball is

const hole = () => round.current.layout;
const frame = (): Frame => frameFacing(round.ball, hole().pin);
const localHole = (): HoleLayout => holeInFrame(hole(), frame());

function lieName(): string {
  if (round.strokes.length === 0 || (round.ball.x === 0 && round.ball.z === 0)) return 'Tee';
  return surfaceOn(hole(), round.ball.x, round.ball.z).name;
}

function lieEffect(name: string): Lie {
  return name === 'Rough' ? LIES.rough : name === 'Tee' ? LIES.tee : name === 'Green' ? LIES.green : LIES.fairway;
}

function environment(f: Frame): Environment {
  return {
    atmosphere: atmosphereAt(weather.altitude, weather.temperature, weather.humidity),
    wind: { ...CALM, speed: weather.speed, direction: weather.bearing - f.heading },
    landingHeight: 0,
  };
}

function predict(s: Setup, faults: Faults = NO_FAULTS) {
  const f = frame();
  const delivery = applyFaults(deliveryFor(s, player()), faults);
  const launch = strike(delivery, s.club, faults.contact, lieEffect(lieName()));
  const shot = simulateShot(launch, environment(f), { hole: localHole() });
  return { delivery, launch, shot, frame: f };
}

// ---------------------------------------------------------------- Club choice

const stockCarry = new Map<string, number>();
function carryOf(c: ClubSpec): number {
  const key = `${c.name}|${settings.driverSpeed}`;
  if (!stockCarry.has(key)) {
    const launch = strike(deliveryFor(stockSetup(c), player()), c);
    const calm: Environment = { atmosphere: atmosphereAt(0, celsius(24), 0.5), wind: CALM, landingHeight: 0 };
    stockCarry.set(key, simulateShot(launch, calm).flight.carry);
  }
  return stockCarry.get(key)!;
}

/**
 * Finds the effort that sends the ball `target` metres in total, bounce and roll included. Putts are measured on
 * open green with no cup in the way, so they can be aimed to die just past it.
 */
function effortFor(s: Setup, target: number, putt: boolean): number {
  const f = frame();
  let lo = 0.01;
  let hi = 1.3;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const delivery = deliveryFor({ ...s, effort: mid }, player());
    const launch = strike(delivery, s.club, undefined, lieEffect(lieName()));
    const shot = simulateShot(launch, environment(f), putt ? { surface: SURFACES.green } : { hole: localHole() });
    if (shot.holed) return Number(mid.toFixed(3));
    const reach = shot.total;
    if (reach > target) hi = mid;
    else lo = mid;
  }
  return Number(((lo + hi) / 2).toFixed(3));
}

function suggestClub(): { club: ClubSpec; effort?: number; reason: string } {
  const lie = lieName();
  const toPin = round.toPin;
  if (lie === 'Green') return { club: PUTTER, reason: 'On the green: putter' };
  const allowed = CLUBS.filter((c) => c.name !== 'Driver' || lie === 'Tee');
  const longest = allowed[0];
  if (toPin >= carryOf(longest)) return { club: longest, reason: `Out of range: your longest is ${longest.name}` };
  const wedge = allowed[allowed.length - 1];
  if (toPin < carryOf(wedge)) return { club: wedge, effort: undefined, reason: `Inside a full ${wedge.name}: ease off` };
  const best = allowed.reduce((a, b) => (Math.abs(carryOf(b) - toPin) < Math.abs(carryOf(a) - toPin) ? b : a));
  return { club: best, reason: `${best.name} carries about ${dist(carryOf(best))}` };
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
for (const c of bag) clubSelect.add(new Option(c.name, c.name));
clubSelect.addEventListener('change', () => {
  const next = bag.find((c) => c.name === clubSelect.value)!;
  chooseClub(next);
  if (next.head === 'putter') chooseClub(next, effortFor(setup, round.toPin + 0.4, true));
  refresh();
});

let sliders: Slider[] = [];
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
  sliders = [
    slider({
      label: putter ? 'Stroke' : 'Effort', hint: putter ? 'share of a full stroke' : '100 = full swing', unit: '%',
      min: putter ? 2 : 40, max: putter ? 100 : 110, step: putter ? 0.5 : 1, hardMin: 1, hardMax: 130,
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
        ]),
    deg('aim', 'Aim', '+ right of the flag', 15),
    deg('face', 'Face', '+ open to your aim', 10),
    ...(putter ? [] : [deg('path', 'Swing path', '+ in-to-out', 10), deg('plane', 'Swing plane', '+ more upright', 12)]),
  ];
  panel.append(...sliders.map((s) => s.element));
}

$('reset-setup').addEventListener('click', () => {
  setup = { ...stockSetup(club), effort: setup.effort };
  buildSetupPanel();
  refresh();
});

function row(label: string, value: string): string {
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

function renderPredict(p: ReturnType<typeof predict>): void {
  const d = p.delivery;
  const l = p.launch;
  const pin = localHole().pin;
  const rest = p.shot.restPosition;
  const finish = p.shot.holed ? 'In the hole' : `${dist(Math.hypot(rest.x - pin.x, rest.z - pin.z), 1)} from the flag`;
  const putter = club.head === 'putter';
  $('predict').innerHTML = [
    '<div class="predict-group"><h3>Club</h3>',
    row('Club speed', speed(d.clubSpeed)),
    putter ? '' : row('Attack', angle(d.attackAngle, 'up', 'down')),
    row('Path', angle(d.clubPath, 'in-out', 'out-in')),
    row('Face', angle(d.faceAngle, 'open', 'closed')),
    row('Dyn loft', angle(d.dynamicLoft)),
    putter ? '' : row('Spin loft', angle(spinLoft(d))),
    putter ? '' : row('Plane', angle(planeOf(setup))),
    '</div><div class="predict-group"><h3>Ball</h3>',
    row('Ball speed', speed(l.ballSpeed)),
    row('Launch', angle(l.launchAngle)),
    row('Start line', angle(l.launchDirection, 'right', 'left')),
    row('Spin', `${toRpm(l.spinRate).toFixed(0)} rpm`),
    putter ? '' : row('Spin axis', angle(l.spinAxis, 'fade', 'draw')),
    '</div><div class="predict-group wide"><h3>Result</h3>',
    putter ? '' : row('Carry', dist(p.shot.flight.carry)),
    row('Total', dist(p.shot.total)),
    row('Finish', finish),
    row('Lands on', p.shot.holed ? 'Green' : surfaceOn(localHole(), rest.x, rest.z).name),
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
  const toPar = total.strokes === 0 ? 'E' : total.toPar === 0 ? 'E' : total.toPar > 0 ? `+${total.toPar}` : `${total.toPar}`;
  const wind = windText(frame());
  $('hud').innerHTML = `
    <div class="hud-hole"><span class="hud-number">${h.number}</span><div><b>Par ${h.par}</b><span>${dist(h.length)}</span></div></div>
    <dl class="hud-stats">
      <div><dt>To the flag</dt><dd>${dist(round.toPin)}</dd></div>
      <div><dt>Lie</dt><dd>${lieName()}</dd></div>
      <div><dt>Stroke</dt><dd>${round.strokes.length + 1}</dd></div>
      <div><dt>Score</dt><dd>${toPar}</dd></div>
      <div class="hud-wind"><dt>Wind</dt><dd><i style="transform:rotate(${wind.rotate.toFixed(0)}deg)" aria-hidden="true">↑</i>${wind.text}</dd></div>
    </dl>`;
  $('hole-title').textContent = `Hole ${h.number} · Par ${h.par}`;
}

function renderCard(): void {
  const holes = SUN_CITY.holes;
  const half = (from: number) => holes.slice(from, from + 9);
  const cell = (strokes: number | null, par: number) => {
    if (strokes === null) return '<td></td>';
    const d = strokes - par;
    const cls = d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 1 ? 'bogey' : d >= 2 ? 'double' : 'par';
    return `<td><span class="score ${cls}">${strokes}</span></td>`;
  };
  const sum = (list: readonly (number | null)[]) => list.reduce<number>((a, b) => a + (b ?? 0), 0);
  const out = half(0);
  const back = half(9);
  const scores = round.scores;
  const len = unitFor('distance', units());
  const table = $('card');
  table.innerHTML = `
    <thead><tr><th>Hole</th>${out.map((h) => `<th class="${h.number - 1 === round.hole ? 'now' : ''}">${h.number}</th>`).join('')}<th>Out</th>${back
      .map((h) => `<th class="${h.number - 1 === round.hole ? 'now' : ''}">${h.number}</th>`)
      .join('')}<th>In</th><th>Total</th></tr></thead>
    <tbody>
      <tr class="card-length"><th>${len.label === 'm' ? 'Metres' : 'Yards'}</th>${out.map((h) => `<td>${len.fromSI(h.length).toFixed(0)}</td>`).join('')}<td></td>${back
        .map((h) => `<td>${len.fromSI(h.length).toFixed(0)}</td>`)
        .join('')}<td></td><td></td></tr>
      <tr><th>Par</th>${out.map((h) => `<td>${h.par}</td>`).join('')}<td>36</td>${back.map((h) => `<td>${h.par}</td>`).join('')}<td>36</td><td>72</td></tr>
      <tr class="card-score"><th>You</th>${out.map((h, i) => cell(scores[i], h.par)).join('')}<td>${sum(scores.slice(0, 9)) || ''}</td>${back
        .map((h, i) => cell(scores[i + 9], h.par))
        .join('')}<td>${sum(scores.slice(9)) || ''}</td><td>${sum(scores) || ''}</td></tr>
    </tbody>`;
  $('card-sub').textContent = SUN_CITY.note;
}

// ---------------------------------------------------------------- 3D view

const view = new CourseView($<HTMLCanvasElement>('course-cv'), document.querySelector('.course') as HTMLElement, $('pip-legend'), {
  markers: false,
  holeFairway: true,
});
view.setLayers(false, false, false, false);
view.onPhase = (phase) => {
  $('course-phase').textContent = state === 'setup' ? 'Address' : phase;
};

function swingFor(delivery: Delivery, c: ClubSpec, s: Setup): Swing {
  return new Swing(delivery, { ...c, plane: planeOf(s) });
}

function showAddress(): void {
  const p = predict(setup);
  renderPredict(p);
  view.setScene({
    shot: p.shot,
    ghost: null,
    tour: null,
    trails: [],
    hole: hole(),
    swing: swingFor(p.delivery, club, setup),
    club,
    env: environment(p.frame),
    system: units(),
    dispersion: [],
    frame: p.frame,
    preview: settings.showPreview ? p.shot : null,
    atAddress: true,
  });
}

// Slider drags fire quickly; simulate at most once per frame.
let pending = 0;
function refresh(): void {
  if (state !== 'setup') return;
  if (pending) return;
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
  const faults = faultsFrom(judgements, setup.effort, putting, Math.random);
  const lie = lieName();
  const p = predict(setup, faults);
  played = { shot: p.shot, delivery: p.delivery, launch: p.launch, judgements, faults, frame: p.frame, lie, club };
  setState('flight');
  view.setScene({
    shot: p.shot,
    ghost: null,
    tour: null,
    trails: [],
    hole: hole(),
    swing: swingFor(p.delivery, club, setup),
    club,
    env: environment(p.frame),
    system: units(),
    dispersion: [],
    frame: p.frame,
    preview: settings.showPreview ? predict(setup).shot : null,
  });
  view.hit();
}

// Out of bounds: well wide of the hole's line, or long through the green.
function outOfBounds(x: number, z: number): boolean {
  const green = hole().green;
  const length = Math.hypot(green.x, green.z);
  const along = (x * green.x + z * green.z) / length;
  const across = Math.abs(-x * green.z + z * green.x) / length;
  return across > 62 || along > length + 55 || along < -20;
}

view.onFinish = () => {
  if (state !== 'flight' || !played) return;
  const { shot, frame: f } = played;
  const rest = fromFrame(f, shot.restPosition);
  const from = round.ball;
  const ob = !shot.holed && outOfBounds(rest.x, rest.z);
  round.record({ from, to: ob ? from : rest, club: played.club.name, lie: played.lie, holed: shot.holed });
  if (ob) round.record({ from, to: from, club: 'Penalty', lie: played.lie, holed: false });
  const limit = round.current.par * 2;
  const pickedUp = !round.holed && round.strokes.length >= limit;
  if (pickedUp) {
    round.holed = true;
    round.scores[round.hole] = limit;
  }
  renderResult(ob, pickedUp);
  renderCard();
  setState('result');
};

function faultText(j: Judgement): string {
  if (j.grade === 'perfect') return 'On the beat';
  if (j.grade === 'miss') return 'No press';
  if (j.grade === 'wrong') return `Pressed ${j.pressed}, wanted ${j.prompt.arrow}`;
  const ms = Math.round(Math.abs(j.offset ?? 0) * 1000);
  return `${ms} ms ${j.offset! < 0 ? 'early' : 'late'}`;
}

function renderResult(ob: boolean, pickedUp: boolean): void {
  if (!played) return;
  lastFlags = { ob, pickedUp };
  const { shot, delivery, launch, judgements } = played;
  const pin = holeInFrame(hole(), played.frame).pin;
  const rest = shot.restPosition;
  const left = Math.hypot(rest.x - pin.x, rest.z - pin.z);
  const h = round.current;
  let headline = shot.holed ? 'In the hole!' : ob ? 'Out of bounds' : `${dist(left, left < 10 ? 1 : 0)} to go`;
  let detail = ob ? 'Stroke and distance: one penalty stroke, play again from the same spot.' : `Finished on the ${lieName().toLowerCase()}.`;
  if (round.holed) {
    const strokes = round.scores[round.hole]!;
    headline = pickedUp ? 'Picked up' : scoreName(strokes, h.par);
    detail = pickedUp ? `Hole scored at double par (${strokes}).` : `${strokes} strokes on the par ${h.par}.`;
  }
  const result = $('result');
  result.innerHTML = `
    <div class="result-head"><h3>${headline}</h3><p>${detail}</p></div>
    <ul class="grades">${judgements
      .map((j) => `<li data-grade="${j.grade}"><b>${PHASE_INFO[j.prompt.phase].label}</b><span>${j.grade}</span><small>${faultText(j)}</small></li>`)
      .join('')}</ul>
    <dl class="result-stats">
      ${row('Club speed', speed(delivery.clubSpeed))}
      ${row('Face to path', angle(delivery.faceAngle - delivery.clubPath, 'open', 'closed'))}
      ${row('Ball speed', speed(launch.ballSpeed))}
      ${row('Launch', angle(launch.launchAngle))}
      ${row('Spin', `${toRpm(launch.spinRate).toFixed(0)} rpm`)}
      ${played.club.head === 'putter' ? '' : row('Carry', dist(shot.flight.carry))}
      ${row('Total', dist(shot.total))}
    </dl>
    <button type="button" class="swing-button" id="continue">${round.holed ? (round.hole === SUN_CITY.holes.length - 1 ? 'See your round' : 'Next hole') : 'Next shot'} <kbd>Space</kbd></button>`;
  result.hidden = false;
  $('continue').addEventListener('click', () => advance());
}

function advance(): void {
  if (state !== 'result') return;
  $('result').hidden = true;
  if (round.holed) {
    if (round.hole === SUN_CITY.holes.length - 1) {
      showRoundSummary();
      return;
    }
    round.nextHole();
  }
  newShot();
}

function showRoundSummary(): void {
  const t = round.total;
  const result = $('result');
  result.innerHTML = `<div class="result-head"><h3>Round complete</h3><p>${t.strokes} strokes, ${t.toPar === 0 ? 'level par' : t.toPar > 0 ? `${t.toPar} over par` : `${-t.toPar} under par`}.</p></div>
    <button type="button" class="swing-button" id="again">Play again</button>`;
  result.hidden = false;
  $('again').addEventListener('click', () => location.reload());
}

function newShot(): void {
  setState('setup');
  played = null;
  const s = suggestClub();
  chooseClub(s.club);
  const toPin = round.toPin;
  if (s.club.head === 'putter') chooseClub(s.club, effortFor(setup, toPin + 0.4, true));
  else if (toPin < carryOf(s.club)) chooseClub(s.club, effortFor({ ...setup, effort: 1 }, toPin, false));
  $('club-hint').textContent = s.reason;
  renderHud();
  renderCard();
  showAddress();
  setCamera(camera === 'follow' ? 'tee' : camera);
}

swingButton.addEventListener('click', () => startSwing());
window.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (event.code !== 'Space' || typing || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (state === 'setup') startSwing();
  else if (state === 'result') advance();
});

// ---------------------------------------------------------------- Settings and units

const dialog = new SettingsDialog($<HTMLDialogElement>('settings'), settings, () => {
  stockCarry.clear();
  if (state === 'setup') refresh();
});
$('open-settings').addEventListener('click', () => dialog.open());

function setUnits(system: UnitSystem): void {
  settings.units = system;
  saveSettings(settings);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-units]')) b.setAttribute('aria-pressed', String(b.dataset.units === system));
  renderHud();
  renderCard();
  if (state === 'setup') showAddress();
  else if (state === 'result') renderResult(lastFlags.ob, lastFlags.pickedUp);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-units]')) b.addEventListener('click', () => setUnits(b.dataset.units as UnitSystem));

previewButton.setAttribute('aria-pressed', String(settings.showPreview));
setUnits(settings.units);
newShot();
