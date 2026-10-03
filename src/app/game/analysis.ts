import type { ClubSpec, Delivery } from '../../physics/club.ts';
import type { ContactReport } from '../../physics/contact.ts';
import { clubGeometry } from '../../physics/contact.ts';
import type { Shot } from '../../physics/ground.ts';
import type { LaunchConditions } from '../../physics/launch.ts';
import { spinLoft } from '../../physics/impact.ts';
import type { Swing } from '../../physics/swing.ts';
import { toDegrees, toRpm } from '../../physics/units.ts';
import { lieAngle } from '../clubhead.ts';
import { unitFor, type UnitSystem } from '../units.ts';

/** Everything about one swing the analysis draws: planned (perfect timing, no error) or actual. */
export interface SwingRecord {
  readonly club: ClubSpec;
  readonly plane: number;
  /** Ball forward of the club's stock position, m. */
  readonly ballPosition: number;
  /** Where the body is aimed, rad, relative to the target line. */
  readonly aim: number;
  readonly delivery: Delivery;
  readonly contact: ContactReport;
  readonly launch: LaunchConditions;
  readonly shot: Shot;
  /** The surface the ball sits on: Tee, Fairway, Rough, Sand, Green and so on. */
  readonly lie: string;
  /** On a tee peg. */
  readonly teed: boolean;
  /** The swing itself, for the club's path through the air. */
  readonly swing: Swing;
}

type Pt = readonly [number, number];
type Records = readonly (readonly [SwingRecord, boolean])[];

const PLAN = '#8a958e';
const ACTUAL = '#c8102e';
const GREEN = '#006747';
const INK = '#1d2621';
const MUTED = '#5d6b63';
const STEEL = '#cfd4d8';
const BALL_RADIUS = 0.04267 / 2;

/** Prepares a canvas for crisp drawing at its CSS size; returns the context and size in CSS pixels. */
function sized(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 260;
  const h = canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px "Libre Franklin", Arial, sans-serif';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return { ctx, w, h };
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, colour: string, dashed: boolean, width = 2) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.setLineDash([]);
  const a = Math.atan2(y1 - y0, x1 - x0);
  const size = 4 + 2 * width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - size * Math.cos(a - 0.4), y1 - size * Math.sin(a - 0.4));
  ctx.lineTo(x1 - size * Math.cos(a + 0.4), y1 - size * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, colour = MUTED, align: CanvasTextAlign = 'left') {
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

function polygon(ctx: CanvasRenderingContext2D, pts: readonly Pt[], close = true) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
}

function polyline(ctx: CanvasRenderingContext2D, pts: readonly Pt[], colour: string, dashed: boolean, width: number) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [5, 4] : []);
  polygon(ctx, pts, false);
  ctx.stroke();
  ctx.restore();
}

/** A repeatable random sequence, so grass looks the same every redraw. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Planned lines are grey and dashed beside your swing; drawn on its own, the plan is solid. */
const ink = (planned: boolean, solo: boolean) => ({ colour: planned ? (solo ? '#4b5650' : PLAN) : ACTUAL, dashed: planned && !solo });

const putterStyle = (club: ClubSpec): 'blade' | 'mallet' => ((club.forgiveness ?? 0.6) > 1 ? 'blade' : 'mallet');

/**
 * Where a typical golfer stands for this club: toe line from the ball, feet apart centre to centre, and the ball
 * ahead of the middle of the stance (all m). The reach follows the shaft: length times the cosine of the lie angle,
 * plus the gap between the hands and the toes.
 */
function stance(club: ClubSpec): { reach: number; width: number; ball: number } {
  const loft = toDegrees(club.loft);
  const reach = club.length * Math.cos(lieAngle(club)) + (club.head === 'putter' ? 0.07 : 0.16);
  switch (club.head) {
    case 'driver':
      return { reach, width: 0.56, ball: 0.2 };
    case 'wood':
      return { reach, width: 0.52, ball: loft > 19 ? 0.08 : 0.14 };
    case 'putter':
      return { reach, width: 0.32, ball: 0.05 };
    default: {
      const t = Math.min(1, Math.max(0, (loft - 22) / 38));
      return { reach, width: 0.48 - 0.12 * t, ball: 0.07 * (1 - t) };
    }
  }
}

// ---------------------------------------------------------------- Club heads

/** A club head seen from above, in its own frame: u toward the toe, v toward the target, sweet spot at the origin. */
interface TopShape {
  readonly outline: readonly Pt[];
  readonly fill: string;
  readonly hosel: Pt;
  readonly marks: readonly (readonly Pt[])[];
  readonly markColour: string;
}

function topShape(club: ClubSpec): TopShape {
  if (club.head === 'driver' || club.head === 'wood') {
    const loft = toDegrees(club.loft);
    const k = club.head === 'driver' ? 1 : loft > 19 ? 0.68 : loft > 16 ? 0.76 : 0.82;
    const depth = club.head === 'driver' ? 1 : loft > 19 ? 0.62 : 0.85;
    const outline: Pt[] = [];
    for (let u = -0.05; u <= 0.062; u += 0.008) outline.push([u * k, 0.003 * (1 - (u / 0.06) ** 2) * k]);
    outline.push(
      [0.07 * k, -0.03 * k * depth], [0.062 * k, -0.075 * k * depth], [0.035 * k, -0.105 * k * depth], [0, -0.115 * k * depth],
      [-0.035 * k, -0.1 * k * depth], [-0.055 * k, -0.065 * k * depth], [-0.058 * k, -0.025 * k * depth],
    );
    return { outline, fill: '#2b2f33', hosel: [-0.052 * k, -0.012 * k], marks: [[[0, -0.006 * k], [0, -0.022 * k]]], markColour: '#e6e6e6' };
  }
  if (club.head === 'putter') {
    if (putterStyle(club) === 'blade') {
      return {
        outline: [[-0.05, 0], [0.05, 0], [0.052, -0.006], [0.05, -0.024], [-0.05, -0.024], [-0.052, -0.006]],
        fill: STEEL,
        hosel: [-0.038, 0.006],
        marks: [[[0, -0.004], [0, -0.02]], [[-0.04, -0.008], [0.04, -0.008]]],
        markColour: '#6f777c',
      };
    }
    return {
      outline: [[-0.048, 0], [0.048, 0], [0.051, -0.04], [0.036, -0.074], [0, -0.088], [-0.036, -0.074], [-0.051, -0.04]],
      fill: '#30353a',
      hosel: [-0.012, -0.012],
      marks: [[[0, -0.003], [0, -0.08]]],
      markColour: '#f2f2f2',
    };
  }
  // Iron: from above you see the lofted face (with grooves) between the leading edge and the top line.
  const loft = club.loft;
  const height = 0.046 + Math.max(0, toDegrees(loft) - 20) * 0.00025;
  const band = height * Math.sin(loft) + 0.006;
  const marks: Pt[][] = [];
  for (let v = -0.003; v > -band + 0.006; v -= 0.0035) marks.push([[-0.026, v], [0.032, v]]);
  return {
    outline: [[-0.036, 0], [0.038, 0], [0.044, -0.006], [0.045, -0.45 * band], [0.039, -band], [-0.02, -0.78 * band], [-0.034, -0.55 * band], [-0.04, -0.2 * band]],
    fill: STEEL,
    hosel: [-0.043, 0.003],
    marks,
    markColour: '#9aa2a7',
  };
}

/** A club head seen side on from the toe, at address with the shaft upright: s toward the target, y up, leading edge at 0. */
interface SideShape {
  readonly body: readonly Pt[];
  readonly fill: string;
  /** Bottom and top of the hosel along the shaft, and its widths there. */
  readonly hosel: readonly [Pt, Pt];
  readonly hoselWidth: readonly [number, number];
  readonly faceTop: Pt;
}

function sideShape(club: ClubSpec): SideShape {
  const L0 = club.loft;
  const faceAt = (y: number) => -y * Math.tan(L0);
  if (club.head === 'driver' || club.head === 'wood') {
    const loft = toDegrees(L0);
    const H = club.head === 'driver' ? 0.06 : loft > 19 ? 0.035 : 0.038;
    const D = club.head === 'driver' ? 0.118 : loft > 19 ? 0.07 : loft > 16 ? 0.088 : 0.094;
    const ft = faceAt(H);
    const axis = -0.02 * (D / 0.118);
    return {
      body: [
        [0, 0], [ft, H], [ft - 0.09 * D, H * 1.06], [ft - 0.33 * D, H * 1.04], [-0.68 * D, H * 0.9], [-0.9 * D, H * 0.66], [-D, H * 0.4],
        [-D, H * 0.18], [-0.94 * D, H * 0.05], [-0.68 * D, -0.001], [-0.34 * D, -0.002], [-0.1 * D, -0.0015],
      ],
      fill: '#2b2f33',
      hosel: [[axis, H * 0.7], [axis, H * 0.7 + 0.032]],
      hoselWidth: [0.012, 0.0095],
      faceTop: [ft, H],
    };
  }
  if (club.head === 'putter') {
    const blade = putterStyle(club) === 'blade';
    const H = blade ? 0.022 : 0.025;
    const ft = faceAt(H);
    return blade
      ? {
          body: [[0, 0], [ft, H], [ft - 0.005, H], [ft - 0.006, 0.011], [-0.025, 0.0095], [-0.028, 0.004], [-0.025, -0.0005], [-0.005, -0.0008]],
          fill: STEEL,
          hosel: [[0.006, 0.016], [0.006, 0.058]],
          hoselWidth: [0.009, 0.0085],
          faceTop: [ft, H],
        }
      : {
          body: [[0, 0], [ft, H], [-0.03, H], [-0.065, 0.022], [-0.09, 0.012], [-0.09, 0.003], [-0.06, -0.0005], [-0.01, -0.0008]],
          fill: '#30353a',
          hosel: [[-0.012, 0.02], [-0.012, 0.055]],
          hoselWidth: [0.009, 0.0085],
          faceTop: [ft, H],
        };
  }
  // Iron: the face laid back at its loft (its height measured along the face), a thin top line, a back that bulges
  // into a muscle down to the sole, and a sole that hangs below the leading edge by its bounce.
  const geo = clubGeometry(club);
  const Hf = 0.046 + Math.max(0, toDegrees(L0) - 20) * 0.00025;
  const top: Pt = [-Hf * Math.sin(L0), Hf * Math.cos(L0)];
  const sw = geo.soleWidth;
  const drop = Math.tan(geo.bounce) * sw * 0.45;
  const backTop: Pt = [top[0] - 0.0065, top[1] - 0.0015];
  const trailing: Pt = [-sw, 0.003];
  const back: Pt[] = [0.25, 0.5, 0.75].map((f) => [
    backTop[0] + (trailing[0] - backTop[0]) * f - 0.006 * Math.sin(Math.PI * f),
    backTop[1] + (trailing[1] - backTop[1]) * f,
  ]);
  return {
    body: [[0, 0], top, backTop, ...back, trailing, [-0.55 * sw, -drop], [-0.2 * sw, -0.6 * drop]],
    fill: STEEL,
    hosel: [[0.003, 0.012], [0.003, 0.078]],
    hoselWidth: [0.013, 0.0095],
    faceTop: top,
  };
}

// ---------------------------------------------------------------- How each lie looks side on

interface LieLook {
  readonly grass: number;
  readonly back: string;
  readonly front: string;
  readonly soil: string;
  /** Blades per centimetre. */
  readonly density: number;
  /** Tall grass stands in front of the ball too. */
  readonly tall: boolean;
}

const LOOKS: Record<string, LieLook> = {
  Tee: { grass: 0.012, back: '#3f7f34', front: '#62a14a', soil: '#7c6a4f', density: 2.4, tall: false },
  Fairway: { grass: 0.012, back: '#3f7f34', front: '#62a14a', soil: '#7c6a4f', density: 2.4, tall: false },
  Fringe: { grass: 0.009, back: '#3d8237', front: '#5fa652', soil: '#7c6a4f', density: 2.6, tall: false },
  Green: { grass: 0.004, back: '#3d8a3a', front: '#58aa52', soil: '#7c6a4f', density: 3, tall: false },
  Rough: { grass: 0.05, back: '#2f6a2a', front: '#4f8f3e', soil: '#6f5e45', density: 1.6, tall: true },
  'Thick rough': { grass: 0.1, back: '#2a6126', front: '#4a8a39', soil: '#6f5e45', density: 1.5, tall: true },
  'Native area': { grass: 0.12, back: '#7d7b45', front: '#ab9f5c', soil: '#8a7553', density: 0.7, tall: true },
  Sand: { grass: 0, back: '#e3d3a5', front: '#e3d3a5', soil: '#e3d3a5', density: 0, tall: false },
};

function lieText(r: SwingRecord): string {
  const sit = r.contact.ballSit * 1000;
  if (r.teed) return `Teed up ${sit.toFixed(0)} mm`;
  const name = r.lie === 'Tee' ? 'Tee box' : r.lie;
  const look = LOOKS[r.lie] ?? LOOKS.Fairway;
  const grass = look.grass >= 0.03 ? `, grass ${(look.grass * 100).toFixed(0)} cm` : '';
  return `${name}: ball sits ${Math.abs(sit).toFixed(0)} mm ${sit >= 0 ? 'up' : 'down'}${grass}`;
}

// ---------------------------------------------------------------- The panel

/**
 * The swing analysis panel, laid out like a launch monitor's club screens. From above: the stance to scale, the club
 * head's path through the ball and a zoomed impact view of path and face. Side on at the ground: the lie, the club's
 * profile at impact with its loft, the attack angle, the leading edge's arc, the low point and any divot. The strike on
 * the face. Down the line: the golfer at address, the swing plane and the paths of the hands and club head.
 * The planned swing is grey and dashed; the swing you made is red and solid.
 */
export class SwingAnalysis {
  private readonly root: HTMLElement;
  private readonly top: HTMLCanvasElement;
  private readonly side: HTMLCanvasElement;
  private readonly face: HTMLCanvasElement;
  private readonly plane: HTMLCanvasElement;
  private readonly table: HTMLElement;
  private readonly verdict: HTMLElement;
  private last: { plan: SwingRecord; actual: SwingRecord | null; system: UnitSystem } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <p class="analysis-verdict" id="analysis-verdict"></p>
      <div class="analysis-views">
        <figure><canvas data-view="top"></canvas><figcaption>From above, to scale</figcaption></figure>
        <figure><canvas data-view="side"></canvas><figcaption>Side on at the ball, to scale</figcaption></figure>
        <figure><canvas data-view="face"></canvas><figcaption>Strike on the face</figcaption></figure>
        <figure><canvas data-view="plane"></canvas><figcaption>Down the line</figcaption></figure>
      </div>
      <div class="analysis-legend"><span class="plan">Planned</span><span class="actual">Your swing</span></div>
      <div class="analysis-table"></div>`;
    const c = (v: string) => root.querySelector(`[data-view="${v}"]`) as HTMLCanvasElement;
    this.top = c('top');
    this.side = c('side');
    this.face = c('face');
    this.plane = c('plane');
    this.table = root.querySelector('.analysis-table') as HTMLElement;
    this.verdict = root.querySelector('.analysis-verdict') as HTMLElement;
    new ResizeObserver(() => this.redraw()).observe(root);
  }

  show(plan: SwingRecord, actual: SwingRecord | null, system: UnitSystem): void {
    this.last = { plan, actual, system };
    this.redraw();
  }

  private redraw(): void {
    if (!this.last || this.root.offsetParent === null) return;
    const { plan, actual, system } = this.last;
    const records: Records = [[plan, true], ...(actual ? [[actual, false] as const] : [])];
    // Each view draws on its own: a problem in one must not blank the others.
    for (const draw of [() => this.drawTop(records), () => this.drawSide(records), () => this.drawFace(records), () => this.drawPlane(records)]) {
      try {
        draw();
      } catch (error) {
        console.error(error);
      }
    }
    this.drawTable(plan, actual, system);
    const kind = (actual ?? plan).contact.kind;
    const putt = plan.club.head === 'putter';
    this.verdict.innerHTML = actual
      ? `${putt ? '' : `<b>${kind}</b> strike. `}${describe(actual)}`
      : `<b>Planned:</b> ${putt ? '' : `${kind.toLowerCase()} strike. `}${describe(plan)}`;
  }

  // From above: target up the canvas. The stance and the club's path to scale on the left; impact zoomed on the right.
  private drawTop(records: Records): void {
    const { ctx, w, h } = sized(this.top);
    const plan = records[0][0];
    const club = plan.club;
    const st = stance(club);
    const aim = plan.aim;
    const along: Pt = [Math.cos(aim), Math.sin(aim)];
    const golfer: Pt = [Math.sin(aim), -Math.cos(aim)];
    const centre = -(st.ball + plan.ballPosition);
    const footLength = 0.29;
    const feet = [
      { at: centre + st.width / 2, flare: (20 * Math.PI) / 180 },
      { at: centre - st.width / 2, flare: (-8 * Math.PI) / 180 },
    ].map(({ at, flare }) => {
      const toe: Pt = [along[0] * at + golfer[0] * st.reach, along[1] * at + golfer[1] * st.reach];
      const dir: Pt = [-golfer[0] * Math.cos(flare) + along[0] * Math.sin(flare), -golfer[1] * Math.cos(flare) + along[1] * Math.sin(flare)];
      return { toe, dir };
    });
    // The club head's path near the ball (world x forward, z right), from each swing.
    const arcs = records.map(([r]) => {
      const pts: Pt[] = [];
      const t0 = -r.swing.downswing;
      const t1 = 0.4;
      for (let i = 0; i <= 900; i++) {
        const p = r.swing.poseAt(t0 + ((t1 - t0) * i) / 900).head;
        if (Math.hypot(p.x, p.z) < 0.5) pts.push([p.x, p.z]);
      }
      return pts;
    });

    // Fit the to-scale plot to the left part of the canvas; the zoomed impact view takes the right.
    const R = Math.max(34, Math.min(62, 0.27 * w, 0.32 * h));
    const plotRight = w - 2 * R - 14;
    const xs: number[] = [0.75, -0.45];
    const zs: number[] = [0.12, -0.12];
    for (const f of feet) {
      for (const k of [0, 1]) {
        xs.push(f.toe[0] - k * footLength * f.dir[0]);
        zs.push(f.toe[1] - k * footLength * f.dir[1]);
      }
    }
    for (const arc of arcs) for (const [x, z] of arc) (xs.push(x), zs.push(z));
    const xMin = Math.min(...xs) - 0.06;
    const xMax = Math.max(...xs);
    const zMin = Math.min(...zs) - 0.06;
    const zMax = Math.max(...zs) + 0.04;
    const top = 34;
    const s = Math.min((plotRight - 8) / (zMax - zMin), (h - top - 8) / (xMax - xMin));
    const ox = 8 + (plotRight - 8 - (zMax - zMin) * s) / 2 - zMin * s;
    const oy = top + xMax * s;
    const P = (x: number, z: number): Pt => [ox + z * s, oy - x * s];

    // Target line and aim line.
    ctx.save();
    ctx.strokeStyle = '#cfd9cf';
    ctx.setLineDash([2, 4]);
    polygon(ctx, [P(xMin, 0), P(xMax + 0.1, 0)], false);
    ctx.stroke();
    ctx.restore();
    label(ctx, 'Target', P(xMax, 0)[0] + 4, top + 8);
    if (Math.abs(aim) > 0.002) {
      ctx.save();
      ctx.strokeStyle = '#d9b84a';
      ctx.setLineDash([4, 4]);
      polygon(ctx, [P(-0.4 * along[0], -0.4 * along[1]), P(0.8 * along[0], 0.8 * along[1])], false);
      ctx.stroke();
      ctx.restore();
    }

    // Feet, to scale: a shoe outline from heel to toe.
    for (const f of feet) {
      const heel: Pt = [f.toe[0] - footLength * f.dir[0], f.toe[1] - footLength * f.dir[1]];
      const across: Pt = [-f.dir[1], f.dir[0]];
      const outline: Pt[] = [];
      const half = (a: number) => (a < 0.15 ? 0.03 + a * 0.08 : a < 0.7 ? 0.042 + (a - 0.15) * 0.018 : 0.052 * Math.sqrt(Math.max(0, 1 - ((a - 0.7) / 0.3) ** 2)));
      for (let a = 0; a <= 1.0001; a += 0.05) outline.push([heel[0] + a * footLength * f.dir[0] + half(a) * across[0], heel[1] + a * footLength * f.dir[1] + half(a) * across[1]]);
      for (let a = 1; a >= -0.0001; a -= 0.05) outline.push([heel[0] + a * footLength * f.dir[0] - half(a) * across[0], heel[1] + a * footLength * f.dir[1] - half(a) * across[1]]);
      ctx.fillStyle = '#e4ece4';
      ctx.strokeStyle = '#b5c4b8';
      ctx.lineWidth = 1;
      polygon(ctx, outline.map(([x, z]) => P(x, z)));
      ctx.fill();
      ctx.stroke();
    }
    // Toe line, parallel to the aim.
    const toeA = feet[1].toe;
    const toeB = feet[0].toe;
    ctx.save();
    ctx.strokeStyle = '#b5c4b8';
    ctx.setLineDash([2, 3]);
    polygon(ctx, [P(toeA[0] - 0.1 * along[0], toeA[1] - 0.1 * along[1]), P(toeB[0] + 0.1 * along[0], toeB[1] + 0.1 * along[1])], false);
    ctx.stroke();
    ctx.restore();

    // The club head's path and the ball's start line, true angles.
    records.forEach(([r, planned], i) => {
      const { colour, dashed } = ink(planned, records.length === 1);
      const start = r.launch.launchDirection;
      ctx.save();
      ctx.strokeStyle = planned ? '#b8c2bb' : '#f08a98';
      ctx.lineWidth = 1.25;
      polygon(ctx, [P(0, 0), P(xMax + 0.1, (xMax + 0.1) * Math.tan(start))], false);
      ctx.stroke();
      ctx.restore();
      const arc = arcs[i].map(([x, z]) => P(x, z));
      polyline(ctx, arc, colour, dashed, planned ? 1.5 : 2);
      if (arc.length > 4) {
        const [a, b] = [arc[arc.length - 4], arc[arc.length - 1]];
        arrow(ctx, a[0], a[1], b[0], b[1], colour, false, 1);
      }
    });
    const [bx, by] = P(0, 0);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(bx, by, Math.max(2.5, BALL_RADIUS * s), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Zoomed impact, turned so your aim points up: club head from above, path arrow and face. Their angles from the
    // aim are drawn three times larger so single degrees show.
    const icx = w - R - 6;
    const icy = Math.min(h - R - 18, Math.max(top + R + 4, by));
    ctx.save();
    ctx.strokeStyle = '#d6ddd7';
    ctx.setLineDash([2, 3]);
    polygon(ctx, [[bx + 5, by], [icx - R, icy]], false);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(icx, icy, R, 0, Math.PI * 2);
    ctx.fillStyle = '#f6f8f5';
    ctx.fill();
    ctx.strokeStyle = '#cfd9cf';
    ctx.stroke();
    ctx.clip();
    const big = club.head === 'driver' || club.head === 'wood' || (club.head === 'putter' && putterStyle(club) === 'mallet');
    const zoom = R / (big ? 0.135 : 0.085);
    const ballY = icy + (big ? -0.1 : 0.05) * R;
    // Inset coordinates: x along the aim, z to its right.
    const Z = (x: number, z: number): Pt => [icx + z * zoom, ballY - x * zoom];
    const k = 3;
    const solo = records.length === 1;
    ctx.strokeStyle = '#cfd9cf';
    ctx.setLineDash([2, 4]);
    polygon(ctx, [Z(-0.2, 0), Z(0.2, 0)], false);
    ctx.stroke();
    if (Math.abs(aim) > 0.002) {
      // The target line, at its true angle from the aim.
      ctx.strokeStyle = '#9db7a3';
      polygon(ctx, [Z(0, 0), Z(0.2 * Math.cos(-aim), 0.2 * Math.sin(-aim))], false);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const shape = topShape(club);
    // Planned last, as an outline over the swing you made.
    for (const [r, planned] of [...records].reverse()) {
      const filled = !planned || solo;
      const edge = planned ? (solo ? '#4b5650' : PLAN) : ACTUAL;
      const face = (r.delivery.faceAngle - aim) * k;
      const n: Pt = [Math.cos(face), Math.sin(face)];
      const u: Pt = [-Math.sin(face), Math.cos(face)];
      const toe = r.contact.contact.toe;
      const c: Pt = [-BALL_RADIUS * n[0] - toe * u[0], -BALL_RADIUS * n[1] - toe * u[1]];
      const W = ([a, b]: Pt): Pt => Z(c[0] + a * u[0] + b * n[0], c[1] + a * u[1] + b * n[1]);
      const hosel = W(shape.hosel);
      // Shaft, heading off toward the hands.
      ctx.strokeStyle = filled ? '#555c61' : PLAN;
      ctx.lineWidth = 3;
      ctx.setLineDash(filled ? [] : [4, 3]);
      polygon(ctx, [hosel, W([shape.hosel[0] - 0.3, shape.hosel[1]])], false);
      ctx.stroke();
      polygon(ctx, shape.outline.map(W));
      if (filled) {
        ctx.fillStyle = shape.fill;
        ctx.fill();
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.strokeStyle = shape.markColour;
        ctx.lineWidth = 1;
        for (const m of shape.marks) {
          polygon(ctx, m.map(W), false);
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = PLAN;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = filled ? '#a3abb0' : 'rgba(138,149,142,0.25)';
      ctx.beginPath();
      ctx.arc(hosel[0], hosel[1], 0.007 * zoom, 0, Math.PI * 2);
      ctx.fill();
      // Face line, extended so its angle reads.
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 2]);
      polygon(ctx, [W([-0.09, 0]), W([0.09, 0])], false);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const [r, planned] of records) {
      const p = (r.delivery.clubPath - aim) * k;
      const behind = (0.85 * R) / zoom;
      const ahead = (0.7 * R) / zoom;
      const a = Z(-behind * Math.cos(p), -behind * Math.sin(p));
      const b = Z(ahead * Math.cos(p), ahead * Math.sin(p));
      arrow(ctx, a[0], a[1], b[0], b[1], planned ? (solo ? '#4b5650' : PLAN) : ACTUAL, planned && !solo, 1.5);
    }
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(...Z(0, 0), BALL_RADIUS * zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    label(ctx, Math.abs(aim) > 0.002 ? 'Impact, aim up, angles x3' : 'Impact, angles x3', w - 4, icy + R + 12, MUTED, 'right');

    const a = records[records.length - 1][0];
    const path = toDegrees(a.delivery.clubPath);
    const face = toDegrees(a.delivery.faceAngle);
    const f2p = face - path;
    const side = (d: number, plus: string, minus: string) => (Math.abs(d) < 0.05 ? 'square' : `${Math.abs(d).toFixed(1)}° ${d > 0 ? plus : minus}`);
    label(ctx, `Path ${side(path, 'in-to-out', 'out-to-in')} · Face ${side(face, 'open', 'closed')}`, 6, 13, INK);
    label(ctx, `Face to path ${side(f2p, 'open', 'closed')}${Math.abs(aim) > 0.002 ? ` · Feet aim ${Math.abs(toDegrees(aim)).toFixed(1)}° ${aim > 0 ? 'right' : 'left'}` : ''}`, 6, 26);
  }

  // Side on at the ground, true scale: target to the right. The lie, the ball, the club at impact, its arc and divot.
  private drawSide(records: Records): void {
    const { ctx, w, h } = sized(this.side);
    const plan = records[0][0];
    const club = plan.club;
    const putt = club.head === 'putter';
    const sand = plan.lie === 'Sand';
    const look = sand ? LOOKS.Sand : plan.teed ? LOOKS.Tee : (LOOKS[plan.lie] ?? LOOKS.Fairway);
    const shape = sideShape(club);
    const depthBehind = -Math.min(...shape.body.map((p) => p[0]));

    // Horizontal window: the club head behind the ball, the low point and any divot. Kept to 36 cm so the ball and
    // club stay big enough to read; a low point beyond the edge gets a marker there.
    const headBack = BALL_RADIUS + depthBehind;
    let x0 = -(headBack + 0.04);
    let x1 = 0.12;
    for (const [r] of records) {
      x0 = Math.min(x0, r.contact.lowPoint - 0.03, (r.contact.divot?.from ?? 0) - 0.02);
      x1 = Math.max(x1, r.contact.lowPoint + 0.03, (r.contact.divot?.to ?? 0) + 0.02);
    }
    if (x1 - x0 > 0.36) {
      x0 = Math.max(x0, -(headBack + 0.06));
      x1 = Math.max(x0 + 0.24, Math.min(x1, x0 + 0.36));
    }
    const top = 36;
    const sc = w / (x1 - x0);
    const gy = h - Math.max(18, 0.03 * sc);
    const X = (x: number) => (x - x0) * sc;
    const Y = (y: number) => gy - y * sc;
    const S = ([x, y]: Pt): Pt => [X(x), Y(y)];

    // Ground: soil or sand, with grass on top.
    ctx.fillStyle = look.soil;
    ctx.fillRect(0, gy, w, h - gy);
    const rand = seeded(7);
    if (sand) {
      for (let i = 0; i < (w * (h - gy)) / 9; i++) {
        ctx.fillStyle = rand() > 0.5 ? '#cdb985' : '#f3e7c4';
        ctx.fillRect(rand() * w, gy + rand() * (h - gy), 1.2, 1.2);
      }
    } else {
      ctx.fillStyle = 'rgba(40,30,20,0.25)';
      ctx.fillRect(0, gy, w, Math.max(2, 0.004 * sc));
    }
    // Divots: earth or sand the club throws out.
    for (const [r, planned] of records) {
      const c = r.contact;
      if (!c.divot) continue;
      const edge = (x: number) => c.lowPointHeight + ((x - c.lowPoint) ** 2) / (2 * c.arcRadius);
      const pts: Pt[] = [[X(c.divot.from), gy]];
      for (let x = c.divot.from; x <= c.divot.to; x += 0.002) pts.push([X(x), Y(Math.min(0, edge(x)))]);
      pts.push([X(c.divot.to), gy]);
      polygon(ctx, pts);
      // The ground thrown out leaves a hole: drawn as open air.
      ctx.fillStyle = planned ? 'rgba(255,253,248,0.45)' : '#fffdf8';
      ctx.fill();
      ctx.strokeStyle = planned ? PLAN : ACTUAL;
      ctx.lineWidth = 1;
      ctx.setLineDash(planned ? [2, 2] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const blades = (count: number, colour: string, from: number, to: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = colour;
      ctx.lineWidth = look.grass > 0.03 ? 1.4 : 1;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const x = from + rand() * (to - from);
        const tall = look.grass * (0.55 + 0.45 * rand());
        const lean = (rand() - 0.35) * look.grass * 0.45;
        ctx.moveTo(X(x), gy);
        ctx.quadraticCurveTo(X(x + lean * 0.3), Y(tall * 0.6), X(x + lean), Y(tall));
      }
      ctx.stroke();
      ctx.restore();
    };
    if (look.grass > 0) {
      ctx.fillStyle = look.back;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(0, Y(look.grass * 0.45), w, gy - Y(look.grass * 0.45));
      ctx.globalAlpha = 1;
      blades(Math.round(look.density * (x1 - x0) * 100), look.back, x0, x1, 1);
    }

    // Tee peg.
    const sit = plan.contact.ballSit;
    if (plan.teed) {
      const peg = 0.0025;
      ctx.fillStyle = '#f2e6c9';
      ctx.strokeStyle = '#a8946a';
      ctx.lineWidth = 1;
      polygon(ctx, [S([-peg, Math.min(0, sit - 0.006)]), S([-peg, sit - 0.006]), S([-0.0055, sit]), S([0.0055, sit]), S([peg, sit - 0.006]), S([peg, Math.min(0, sit - 0.006)])]);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 0.35;
      polygon(ctx, [S([-peg, 0]), S([-peg, -0.035]), S([0, -0.04]), S([peg, -0.035]), S([peg, 0])]);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Leading edge arcs and low points.
    for (const [r, planned] of records) {
      const c = r.contact;
      const pts: Pt[] = [];
      for (let x = x0; x <= x1; x += 0.002) pts.push([X(x), Y(c.lowPointHeight + ((x - c.lowPoint) ** 2) / (2 * c.arcRadius))]);
      const { colour, dashed } = ink(planned, records.length === 1);
      polyline(ctx, pts, colour, dashed, planned ? 1.25 : 1.5);
      const ly = Y(c.lowPointHeight);
      ctx.fillStyle = colour;
      if (c.lowPoint > x1 || c.lowPoint < x0) {
        // Off the edge: an arrowhead at the edge pointing to it.
        const lx = c.lowPoint > x1 ? w - 3 : 3;
        const dir = c.lowPoint > x1 ? 1 : -1;
        polygon(ctx, [[lx, gy + 6], [lx - dir * 7, gy + 1], [lx - dir * 7, gy + 11]]);
      } else {
        const lx = X(c.lowPoint);
        polygon(ctx, [[lx, ly + 2], [lx - 4, ly + 9], [lx + 4, ly + 9]]);
      }
      ctx.fill();
    }

    // Club heads at impact: the face tangent to the ball at the dynamic loft, leading edge at its height.
    const ballY = sit + BALL_RADIUS;
    const solo = records.length === 1;
    const clubs = [...records].reverse().map(([r, planned]) => {
      const L = r.delivery.dynamicLoft;
      const P: Pt = [-BALL_RADIUS * Math.cos(L), ballY - BALL_RADIUS * Math.sin(L)];
      const d = (P[1] - r.contact.edgeAtBall) / Math.max(0.2, Math.cos(L));
      const E: Pt = [P[0] + d * Math.sin(L), r.contact.edgeAtBall];
      const phi = club.loft - L;
      const place = ([x, y]: Pt): Pt => S([E[0] + x * Math.cos(phi) + y * Math.sin(phi), E[1] - x * Math.sin(phi) + y * Math.cos(phi)]);
      return { planned, filled: !planned || solo, edge: planned ? (solo ? '#4b5650' : PLAN) : ACTUAL, place };
    });
    // Shaft and hosel first: seen from the toe they rise from the heel, behind the ball.
    for (const { filled, place } of clubs) {
      const [hb, ht] = shape.hosel;
      const shaftTop = place([ht[0], ht[1] + 2]);
      const base = place(ht);
      const t = Math.max(0, Math.min(1, (base[1] - top) / Math.max(1, base[1] - shaftTop[1])));
      ctx.strokeStyle = filled ? '#4b5257' : PLAN;
      ctx.lineWidth = 2;
      ctx.setLineDash(filled ? [] : [4, 3]);
      polygon(ctx, [base, [base[0] + (shaftTop[0] - base[0]) * t, base[1] + (shaftTop[1] - base[1]) * t]], false);
      ctx.stroke();
      const [wb, wt] = shape.hoselWidth;
      polygon(ctx, [place([hb[0] - wb / 2, hb[1]]), place([ht[0] - wt / 2, ht[1]]), place([ht[0] + wt / 2, ht[1]]), place([hb[0] + wb / 2, hb[1]])]);
      if (filled) {
        ctx.fillStyle = shape.fill === STEEL ? '#a9b0b4' : '#3a3f44';
        ctx.fill();
      } else {
        ctx.strokeStyle = PLAN;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Ball.
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#6d7570';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(X(0), Y(ballY), BALL_RADIUS * sc, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // The heads, nearer than the ball at the toe.
    for (const { filled, edge, place } of clubs) {
      polygon(ctx, shape.body.map(place));
      if (filled) {
        const g = ctx.createLinearGradient(...place([0, 0]), ...place(shape.faceTop));
        g.addColorStop(0, shape.fill === STEEL ? '#e7eaec' : '#4a5055');
        g.addColorStop(1, shape.fill);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // The face itself, picked out.
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        polygon(ctx, [place([0, 0]), place(shape.faceTop)], false);
        ctx.stroke();
      } else {
        ctx.strokeStyle = PLAN;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Attack angle: the direction the club travels through the strike, drawn just above the ball.
    const arrowY = ballY + BALL_RADIUS + 0.018;
    for (const [r, planned] of records) {
      const A = r.delivery.attackAngle;
      const from: Pt = [-0.085 * Math.cos(A), arrowY - 0.085 * Math.sin(A)];
      const to: Pt = [0.01 * Math.cos(A), arrowY + 0.01 * Math.sin(A)];
      arrow(ctx, ...S(from), ...S(to), planned ? (solo ? '#4b5650' : PLAN) : ACTUAL, planned && !solo, 1.25);
    }

    // Tall grass stands in front of the ball and club as well.
    if (look.tall) blades(Math.round(look.density * (x1 - x0) * 40), look.front, x0, x1, 0.85);
    else if (look.grass > 0) blades(Math.round(look.density * (x1 - x0) * 60), look.front, x0, x1, 0.9);

    const a = records[records.length - 1][0];
    const attack = toDegrees(a.delivery.attackAngle);
    label(ctx, `Attack ${Math.abs(attack).toFixed(1)}° ${attack >= 0 ? 'up' : 'down'} · Loft at impact ${toDegrees(a.delivery.dynamicLoft).toFixed(1)}°`, 6, 13, INK);
    const lp = a.contact.lowPoint * 100;
    const deep = Math.max(0, -a.contact.lowPointHeight) * 1000;
    const where = `${Math.abs(lp).toFixed(1)} cm ${lp >= 0 ? 'ahead of' : 'behind'} the ball`;
    label(ctx, putt ? `Low point ${where}: rising through the ball` : `Low point ${where}${deep >= 0.5 ? `, ${deep.toFixed(0)} mm deep` : ''}`, 6, 26);
    ctx.font = '600 10px "Libre Franklin", Arial, sans-serif';
    label(ctx, lieText(plan), 6, h - 5, sand ? INK : '#fffdf8');
  }

  // The clubface with the sweet spot and strike points.
  private drawFace(records: Records): void {
    const { ctx, w, h } = sized(this.face);
    const spec = records[0][0].club;
    const geo = clubGeometry(spec);
    const scale = Math.min(w / 0.13, h / 0.075) * 0.8;
    const cx = w / 2;
    const base = h * 0.8;
    const putter = spec.head === 'putter';
    const faceW = spec.head === 'driver' ? 0.11 : spec.head === 'wood' ? 0.09 : putter ? 0.1 : 0.075;
    const faceH = spec.head === 'driver' ? 0.058 : spec.head === 'wood' ? 0.04 : putter ? (putterStyle(spec) === 'blade' ? 0.022 : 0.025) : 0.048;
    ctx.fillStyle = spec.head === 'driver' || spec.head === 'wood' ? '#3a3f44' : '#d9dcdc';
    ctx.strokeStyle = '#7d8585';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (spec.head === 'driver' || spec.head === 'wood') {
      ctx.ellipse(cx, base - (faceH * scale) / 2, (faceW * scale) / 2, (faceH * scale) / 2, 0, 0, Math.PI * 2);
    } else if (putter) {
      ctx.roundRect(cx - (faceW * scale) / 2, base - faceH * scale, faceW * scale, faceH * scale, 4);
    } else {
      ctx.moveTo(cx - (faceW * scale) / 2, base);
      ctx.lineTo(cx + (faceW * scale) / 2, base);
      ctx.lineTo(cx + (faceW * scale) / 2, base - faceH * scale * 0.85);
      ctx.quadraticCurveTo(cx + (faceW * scale) / 2, base - faceH * scale, cx + (faceW * scale) / 4, base - faceH * scale);
      ctx.lineTo(cx - (faceW * scale) / 2, base - faceH * scale * 0.55);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
    if (spec.head === 'driver' || spec.head === 'wood') {
      // The hitting area: a lighter insert.
      ctx.fillStyle = '#8f979c';
      ctx.beginPath();
      ctx.ellipse(cx, base - (faceH * scale) / 2, (faceW * scale) * 0.38, (faceH * scale) * 0.36, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = '#b4baba';
      ctx.lineWidth = 1;
      for (let y = 0.004; y < faceH * (putter ? 0.9 : 0.8); y += putter ? 0.003 : 0.0036) {
        ctx.beginPath();
        ctx.moveTo(cx - faceW * scale * 0.38, base - y * scale);
        ctx.lineTo(cx + faceW * scale * 0.38, base - y * scale);
        ctx.stroke();
      }
    }
    // Hosel on the heel side (left for a right-hander seen from the front, toe to the right).
    ctx.fillStyle = '#9aa1a1';
    ctx.fillRect(cx - (faceW * scale) / 2 - 8, base - faceH * scale - 22, 6, faceH * scale + 6);
    label(ctx, 'Heel', cx - (faceW * scale) / 2 - 2, h - 4, MUTED, 'center');
    label(ctx, 'Toe', cx + (faceW * scale) / 2, h - 4, MUTED, 'center');
    const sy = base - geo.sweetSpot * scale;
    ctx.strokeStyle = spec.head === 'driver' || spec.head === 'wood' ? '#f4d35e' : GREEN;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 6, sy);
    ctx.lineTo(cx + 6, sy);
    ctx.moveTo(cx, sy - 6);
    ctx.lineTo(cx, sy + 6);
    ctx.stroke();
    for (const [r, planned] of records) {
      const c = r.contact.contact;
      ctx.fillStyle = planned ? 'rgba(200,206,202,0.9)' : ACTUAL;
      ctx.strokeStyle = planned ? PLAN : '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx + c.toe * scale, sy - c.height * scale, planned ? 5 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const a = records[records.length - 1][0].contact.contact;
    const toe = a.toe * 1000;
    const high = a.height * 1000;
    const across = Math.abs(toe) < 0.5 ? 'centred' : `${Math.abs(toe).toFixed(0)} mm toward the ${toe > 0 ? 'toe' : 'heel'}`;
    const up = Math.abs(high) < 0.5 ? 'at the sweet spot height' : `${Math.abs(high).toFixed(0)} mm ${high > 0 ? 'high' : 'low'}`;
    label(ctx, `${across}, ${up}`, 6, 13, INK);
  }

  // Down the line, as a camera behind the ball sees it: the golfer at address, the swing plane, the hands and club head.
  private drawPlane(records: Records): void {
    const { ctx, w, h } = sized(this.plane);
    const plan = records[0][0];
    const club = plan.club;
    const st = stance(club);
    const aim = plan.aim;
    const turn = (x: number, y: number, z: number): [number, number, number] => [x * Math.cos(aim) - z * Math.sin(aim), y, x * Math.sin(aim) + z * Math.cos(aim)];
    // Camera behind the ball on the target line, about hand height, looking toward the target.
    const C = [-3.6, 1.15, -0.3];
    const T = [0, 0.8, -0.3];
    const f = norm([T[0] - C[0], T[1] - C[1], T[2] - C[2]]);
    const right = norm(cross(f, [0, 1, 0]));
    const up = cross(right, f);
    const project = (p: readonly number[]): Pt => {
      const d = [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
      const depth = Math.max(0.3, dot(d, f));
      return [dot(d, right) / depth, -dot(d, up) / depth];
    };

    // The golfer at address, in proportion to the club: feet on the toe line, spine tilted, arms hanging to the hands.
    const R = st.reach;
    const c = -(st.ball + plan.ballPosition);
    const hands = plan.swing.poseAt(plan.swing.start).hands;
    const handsAt: [number, number, number] = [hands.x, hands.y, hands.z];
    const joint = {
      leadToe: turn(c + st.width / 2 + 0.06, 0, -R),
      leadHeel: turn(c + st.width / 2 - 0.02, 0, -R - 0.27),
      trailToe: turn(c - st.width / 2 - 0.03, 0, -R),
      trailHeel: turn(c - st.width / 2, 0, -R - 0.27),
      leadAnkle: turn(c + st.width / 2, 0.09, -R - 0.2),
      trailAnkle: turn(c - st.width / 2, 0.09, -R - 0.2),
      leadKnee: turn(c + st.width * 0.42, 0.5, -R - 0.06),
      trailKnee: turn(c - st.width * 0.42, 0.5, -R - 0.06),
      leadHip: turn(c + 0.16, 0.93, -R - 0.28),
      trailHip: turn(c - 0.16, 0.93, -R - 0.28),
      leadShoulder: turn(c + 0.19, 1.42, -R + 0.02),
      trailShoulder: turn(c - 0.19, 1.36, -R + 0.04),
      head: turn(c + 0.02, 1.56, -R + 0.14),
    };
    const paths = records.map(([r]) => {
      const sw = r.swing;
      const head: Pt[] = [];
      const hand: Pt[] = [];
      const phase: number[] = [];
      for (let i = 0; i <= 260; i++) {
        const t = sw.backswingStart + ((sw.end - sw.backswingStart) * i) / 260;
        const pose = sw.poseAt(t);
        head.push(project([pose.head.x, pose.head.y, pose.head.z]));
        hand.push(project([pose.hands.x, pose.hands.y, pose.hands.z]));
        phase.push(t < -sw.downswing ? 0 : t <= 0 ? 1 : 2);
      }
      const hub = sw.poseAt(0).hub;
      return { head, hand, phase, plane: [project([0, 0, 0]), project([hub.x * 1.15, hub.y * 1.15, hub.z * 1.15])] as Pt[] };
    });

    const all: Pt[] = [...Object.values(joint).map(project), project([0, 0, 0]), project(handsAt), project([4, 0, 0])];
    for (const p of paths) all.push(...p.head, ...p.hand, ...p.plane);
    const top = 34;
    const minX = Math.min(...all.map((p) => p[0]));
    const maxX = Math.max(...all.map((p) => p[0]));
    const minY = Math.min(...all.map((p) => p[1]));
    const maxY = Math.max(...all.map((p) => p[1]));
    const k = Math.min((w - 12) / (maxX - minX), (h - top - 8) / (maxY - minY));
    const ox = 6 + (w - 12 - (maxX - minX) * k) / 2 - minX * k;
    const oy = top + (h - top - 8 - (maxY - minY) * k) / 2 - minY * k;
    const V = ([x, y]: Pt): Pt => [ox + x * k, oy + y * k];
    const at = (p: readonly number[]) => V(project(p));

    // Ground: the target line running away from the camera.
    const horizon = at([60, 0, -0.3])[1];
    const g = ctx.createLinearGradient(0, horizon, 0, h);
    g.addColorStop(0, '#eef3ec');
    g.addColorStop(1, '#dde8da');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, w, h - horizon);
    ctx.save();
    ctx.strokeStyle = '#c4d2c4';
    ctx.setLineDash([3, 4]);
    polygon(ctx, [at([0, 0, 0]), at([30, 0, 0])], false);
    ctx.stroke();
    ctx.restore();

    // Golfer.
    ctx.strokeStyle = '#c3ccc5';
    ctx.lineCap = 'round';
    const limb = (a: readonly number[], b: readonly number[], width: number) => {
      ctx.lineWidth = width;
      polygon(ctx, [at(a), at(b)], false);
      ctx.stroke();
    };
    // Pixels per metre at the golfer's distance from the camera.
    const m = k / Math.abs(C[0]);
    limb(joint.trailHeel, joint.trailToe, 0.07 * m);
    limb(joint.leadHeel, joint.leadToe, 0.07 * m);
    limb(joint.trailAnkle, joint.trailKnee, 0.09 * m);
    limb(joint.trailKnee, joint.trailHip, 0.13 * m);
    limb(joint.leadAnkle, joint.leadKnee, 0.09 * m);
    limb(joint.leadKnee, joint.leadHip, 0.13 * m);
    const mid = (a: readonly number[], b: readonly number[]) => a.map((v, i) => (v + b[i]) / 2);
    limb(mid(joint.leadHip, joint.trailHip), mid(joint.leadShoulder, joint.trailShoulder), 0.26 * m);
    limb(joint.trailShoulder, handsAt, 0.07 * m);
    limb(joint.leadShoulder, handsAt, 0.07 * m);
    ctx.fillStyle = '#c3ccc5';
    ctx.beginPath();
    ctx.arc(...at(joint.head), Math.max(3, 0.11 * m), 0, Math.PI * 2);
    ctx.fill();
    // Club at address.
    ctx.strokeStyle = '#7f878c';
    ctx.lineWidth = 1.5;
    polygon(ctx, [at(handsAt), at([0, 0, 0])], false);
    ctx.stroke();

    // Swing plane lines and the paths: backswing faint, downswing bold, follow-through lighter.
    records.forEach(([, planned], i) => {
      const { colour, dashed } = ink(planned, records.length === 1);
      const p = paths[i];
      const [b, e] = p.plane.map(V);
      polyline(ctx, [b, e], planned ? '#b8c2bb' : '#f08a98', true, 1);
      for (const [line, width] of [[p.head, planned ? 1.5 : 2], [p.hand, 1]] as const) {
        for (const segment of [0, 2, 1]) {
          // Each part runs on into the first point of the next, so the line is unbroken.
          const pts = line.filter((_, j) => p.phase[j] === segment || p.phase[j - 1] === segment).map(V);
          ctx.save();
          ctx.globalAlpha = segment === 1 ? 1 : segment === 0 ? 0.35 : 0.55;
          polyline(ctx, pts, colour, dashed, segment === 1 ? width : width * 0.75);
          ctx.restore();
        }
      }
    });
    const [bx, by] = at([0, 0, 0]);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(bx, by, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const a = records[records.length - 1][0];
    const yaw = toDegrees(a.swing.yaw);
    label(ctx, `Swing plane ${toDegrees(a.plane).toFixed(0)}° · aims ${Math.abs(yaw) < 0.05 ? 'at the target' : `${Math.abs(yaw).toFixed(1)}° ${yaw > 0 ? 'right' : 'left'}`}`, 6, 13, INK);
    label(ctx, 'Club head and hands; downswing bold', 6, 26);
  }

  private drawTable(plan: SwingRecord, actual: SwingRecord | null, system: UnitSystem): void {
    const dist = unitFor('distance', system);
    const speed = unitFor('speed', system);
    const putt = plan.club.head === 'putter';
    type Row = [string, (r: SwingRecord) => number, (v: number) => string, number, boolean?];
    const rows: Row[] = [
      ['Club speed', (r) => speed.fromSI(r.delivery.clubSpeed * r.contact.contact.speedFactor), (v) => `${v.toFixed(1)} ${speed.label}`, 3],
      ['Attack angle (+ up)', (r) => toDegrees(r.delivery.attackAngle), deg, 2],
      ['Club path (+ in-to-out)', (r) => toDegrees(r.delivery.clubPath), deg, 3],
      ['Face angle (+ open)', (r) => toDegrees(r.delivery.faceAngle), deg, 3],
      ['Face to path', (r) => toDegrees(r.delivery.faceAngle - r.delivery.clubPath), deg, 3],
      ['Dynamic loft', (r) => toDegrees(r.delivery.dynamicLoft), deg, 3],
      ['Spin loft', (r) => toDegrees(spinLoft(r.delivery)), deg, 3, true],
      ['Low point (+ ahead)', (r) => r.contact.lowPoint * 100, (v) => `${v.toFixed(1)} cm`, 4],
      ['Strike height', (r) => r.contact.contact.height * 1000, (v) => `${v.toFixed(0)} mm`, 8],
      ['Strike toe', (r) => r.contact.contact.toe * 1000, (v) => `${v.toFixed(0)} mm`, 8],
      ['Ball speed', (r) => speed.fromSI(r.launch.ballSpeed), (v) => `${v.toFixed(1)} ${speed.label}`, 5],
      ['Smash factor', (r) => r.launch.ballSpeed / r.delivery.clubSpeed, (v) => v.toFixed(2), 0.1],
      ['Launch angle', (r) => toDegrees(r.launch.launchAngle), deg, 3],
      ['Launch direction', (r) => toDegrees(r.launch.launchDirection), deg, 3],
      ['Spin rate', (r) => toRpm(r.launch.spinRate), (v) => `${v.toFixed(0)} rpm`, 800],
      ['Spin axis', (r) => toDegrees(r.launch.spinAxis), deg, 6, true],
      ['Backspin', (r) => toRpm(r.launch.spinRate * Math.cos(r.launch.spinAxis)), (v) => `${v.toFixed(0)} rpm`, 800, true],
      ['Sidespin', (r) => toRpm(r.launch.spinRate * Math.sin(r.launch.spinAxis)), (v) => `${v.toFixed(0)} rpm`, 600, true],
      ['Carry', (r) => dist.fromSI(r.shot.flight.carry), (v) => `${v.toFixed(1)} ${dist.label}`, 15, true],
      ['Total', (r) => dist.fromSI(r.shot.total), (v) => `${v.toFixed(1)} ${dist.label}`, 15],
      ['Offline', (r) => dist.fromSI(r.shot.restPosition.z), (v) => `${v.toFixed(1)} ${dist.label}`, 10],
      ['Apex', (r) => dist.fromSI(r.shot.flight.apexPosition.y), (v) => `${v.toFixed(1)} ${dist.label}`, 6, true],
      ['Landing angle', (r) => toDegrees(r.shot.flight.landingAngle), deg, 6, true],
    ];
    // No "-0": a value that rounds to zero shows without a sign.
    const unsigned = (text: string) => text.replace(/^-(0(?:\.0+)?)(?![\d.])/, '$1');
    const html = rows
      .filter(([, , , , fullSwingOnly]) => !(putt && fullSwingOnly))
      .map(([name, get, format, range]) => {
        const fmt = (v: number) => unsigned(format(v));
        const p = get(plan);
        if (!actual) return `<tr><th>${name}</th><td>${fmt(p)}</td><td></td><td></td></tr>`;
        const a = get(actual);
        const d = a - p;
        const pct = Math.max(-50, Math.min(50, (d / range) * 25));
        return `<tr><th>${name}</th><td>${fmt(p)}</td><td>${fmt(a)}</td><td class="delta"><span class="bar" style="${pct < 0 ? `right:50%;width:${-pct}%` : `left:50%;width:${pct}%`}"></span><em>${d >= 0 ? '+' : ''}${fmt(d)}</em></td></tr>`;
      })
      .join('');
    this.table.innerHTML = `<table><thead><tr><th></th><th>Planned</th><th>${actual ? 'Your swing' : ''}</th><th>${actual ? 'Difference' : ''}</th></tr></thead><tbody>${html}</tbody></table>`;
  }
}

const deg = (v: number) => `${v.toFixed(1)}°`;
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: readonly number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function describe(r: SwingRecord): string {
  const d = r.delivery;
  const start = toDegrees(r.launch.launchDirection);
  const startText = Math.abs(start) < 0.5 ? 'starts on line' : `starts ${Math.abs(start).toFixed(1)}° ${start > 0 ? 'right' : 'left'}`;
  if (r.club.head === 'putter') {
    const face = toDegrees(d.faceAngle);
    return `Face ${Math.abs(face) < 0.05 ? 'square' : `${Math.abs(face).toFixed(1)}° ${face > 0 ? 'open' : 'closed'}`} at impact: the putt ${startText}. On a putt the face sets about 90% of the start line.`;
  }
  const f2p = toDegrees(d.faceAngle - d.clubPath);
  const shape = Math.abs(f2p) < 1 ? 'straight' : f2p > 0 ? (f2p > 4 ? 'slice' : 'fade') : f2p < -4 ? 'hook' : 'draw';
  return `Face ${Math.abs(f2p).toFixed(1)}° ${f2p >= 0 ? 'open' : 'closed'} to the path: a ${shape} that ${startText}.`;
}
