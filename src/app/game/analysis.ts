import type { ClubSpec, Delivery } from '../../physics/club.ts';
import type { ContactReport } from '../../physics/contact.ts';
import { clubGeometry } from '../../physics/contact.ts';
import type { Shot } from '../../physics/ground.ts';
import type { LaunchConditions } from '../../physics/launch.ts';
import { spinLoft } from '../../physics/impact.ts';
import { toDegrees, toRpm } from '../../physics/units.ts';
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
}

const PLAN = '#8a958e';
const ACTUAL = '#c8102e';
const GREEN = '#006747';
const INK = '#1d2621';
const MUTED = '#5d6b63';

/** Prepares a canvas for crisp drawing at its CSS size; returns the context and size in CSS pixels. */
function sized(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 260;
  const h = canvas.clientHeight || 180;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px "Libre Franklin", Arial, sans-serif';
  ctx.lineCap = 'round';
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
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 8 * Math.cos(a - 0.4), y1 - 8 * Math.sin(a - 0.4));
  ctx.lineTo(x1 - 8 * Math.cos(a + 0.4), y1 - 8 * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, colour = MUTED, align: CanvasTextAlign = 'left') {
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

/**
 * The swing analysis panel: overhead (aim, ball position, path, face, start line), face-on at the ground (the
 * club's arc, low point, divot, attack angle, loft), the strike on the face, and down the line (swing plane).
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
        <figure><canvas data-view="top"></canvas><figcaption>From above</figcaption></figure>
        <figure><canvas data-view="side"></canvas><figcaption>At the ground, face-on</figcaption></figure>
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
    const records: [SwingRecord, boolean][] = [[plan, true], ...(actual ? [[actual, false] as [SwingRecord, boolean]] : [])];
    this.drawTop(records);
    this.drawSide(records);
    this.drawFace(records);
    this.drawPlane(records);
    this.drawTable(plan, actual, system);
    const kind = (actual ?? plan).contact.kind;
    this.verdict.innerHTML = actual
      ? `<b>${kind}</b> strike. ${describe(actual)}`
      : `<b>Planned:</b> ${plan.contact.kind.toLowerCase()} strike. ${describe(plan)}`;
  }

  // Overhead: target up the canvas. Feet across the bottom, ball between them.
  private drawTop(records: [SwingRecord, boolean][]): void {
    const { ctx, w, h } = sized(this.top);
    const cx = w / 2;
    const by = h * 0.62;
    const scale = h / 1.6; // px per metre
    ctx.strokeStyle = '#cfd9cf';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, h);
    ctx.lineTo(cx, 6);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, 'Target', cx + 4, 14);
    const [plan] = records[0];
    // Stance: feet parallel to the aim line, 0.45 m from the ball.
    const aim = plan.aim;
    const fx = cx - Math.cos(aim) * 0.45 * scale;
    const fy = by + Math.sin(aim) * 0.45 * scale;
    ctx.fillStyle = '#e4ece4';
    for (const side of [-1, 1]) {
      const along = side * 0.22 - plan.ballPosition * 0;
      ctx.beginPath();
      ctx.ellipse(fx + Math.sin(aim) * 0 - along * Math.sin(aim) * scale, fy - along * Math.cos(aim) * scale, 7, 15, aim, 0, Math.PI * 2);
      ctx.fill();
    }
    label(ctx, 'Feet', fx - 26, fy + 4, MUTED);
    // Ball position: forward is up the canvas (toward the target).
    const ballY = by - plan.ballPosition * scale * 2.5;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.arc(cx, ballY, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Aim line.
    arrow(ctx, cx, by + 40, cx + Math.sin(aim) * 120, by + 40 - Math.cos(aim) * 120, '#9db7a3', true, 1);
    for (const [r, planned] of records) {
      const colour = planned ? PLAN : ACTUAL;
      const d = r.delivery;
      // Club path through the ball, face normal, and start line, exaggerated 3x so degrees are visible.
      const k = 3;
      const p = d.clubPath * k;
      arrow(ctx, cx - Math.sin(p) * 60, ballY + Math.cos(p) * 60, cx + Math.sin(p) * 70, ballY - Math.cos(p) * 70, colour, planned);
      const f = d.faceAngle * k;
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 4;
      ctx.setLineDash(planned ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(f) * 22, ballY - 8 - Math.sin(f) * 22);
      ctx.lineTo(cx + Math.cos(f) * 22, ballY - 8 + Math.sin(f) * 22);
      ctx.stroke();
      ctx.restore();
      const s = r.launch.launchDirection * k;
      ctx.save();
      ctx.strokeStyle = planned ? '#b8c2bb' : '#f4a3ad';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, ballY);
      ctx.lineTo(cx + Math.sin(s) * 130, ballY - Math.cos(s) * 130);
      ctx.stroke();
      ctx.restore();
    }
    label(ctx, 'Path, face and start line, angles x3', 6, h - 6);
  }

  // Face-on at ground level: target to the right. Shows grass, firm ground, ball, the leading edge's arc, divot.
  private drawSide(records: [SwingRecord, boolean][]): void {
    const { ctx, w, h } = sized(this.side);
    const span = 0.7; // m across the canvas
    const scale = w / span;
    const vscale = scale * 2.2; // vertical exaggeration so millimetres show
    const ox = w * 0.4;
    const gy = h * 0.68;
    const X = (x: number) => ox + x * scale;
    const Y = (y: number) => gy - y * vscale;
    const plan = records[0][0];
    const sand = plan.contact.divot?.ground === 'sand' || plan.contact.kind === 'Splash';
    ctx.fillStyle = sand ? '#e8dcb5' : '#7c6a4f';
    ctx.fillRect(0, gy, w, h - gy);
    label(ctx, sand ? 'Sand' : 'Firm ground', 6, h - 6, sand ? INK : '#f2ead8');
    for (const [r, planned] of records) {
      const c = r.contact;
      // Divot: ground the club removes.
      if (c.divot) {
        ctx.save();
        ctx.fillStyle = planned ? 'rgba(138,149,142,0.35)' : 'rgba(200,16,46,0.35)';
        ctx.beginPath();
        ctx.moveTo(X(c.divot.from), gy);
        for (let x = c.divot.from; x <= c.divot.to; x += 0.005) ctx.lineTo(X(x), Y(Math.min(0, c.lowPointHeight + ((x - c.lowPoint) ** 2) / (2 * c.arcRadius))));
        ctx.lineTo(X(c.divot.to), gy);
        ctx.fill();
        ctx.restore();
      }
    }
    // Ball.
    const r0 = 0.04267 / 2;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.ellipse(X(0), Y(plan.contact.ballSit + r0), r0 * scale, r0 * vscale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (const [r, planned] of records) {
      const c = r.contact;
      const colour = planned ? PLAN : ACTUAL;
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.setLineDash(planned ? [5, 4] : []);
      ctx.beginPath();
      for (let x = -span * 0.4; x <= span * 0.6; x += 0.004) {
        const y = c.lowPointHeight + ((x - c.lowPoint) ** 2) / (2 * c.arcRadius);
        if (x === -span * 0.4) ctx.moveTo(X(x), Y(y));
        else ctx.lineTo(X(x), Y(y));
      }
      ctx.stroke();
      ctx.restore();
      // Low point marker.
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.moveTo(X(c.lowPoint), Y(c.lowPointHeight) + 2);
      ctx.lineTo(X(c.lowPoint) - 5, Y(c.lowPointHeight) + 10);
      ctx.lineTo(X(c.lowPoint) + 5, Y(c.lowPointHeight) + 10);
      ctx.fill();
      // Face at impact: a line at the dynamic loft, from the leading edge.
      const loft = r.delivery.dynamicLoft;
      const ex = X(0) - r0 * scale;
      const ey = Y(c.edgeAtBall);
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 3;
      ctx.setLineDash(planned ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.sin(loft) * 40, ey - Math.cos(loft) * 40);
      ctx.stroke();
      ctx.restore();
    }
    const a = records[records.length - 1][0];
    label(ctx, `Low point ${(a.contact.lowPoint * 100).toFixed(1)} cm ${a.contact.lowPoint >= 0 ? 'ahead of' : 'behind'} the ball`, 6, 14, INK);
    label(ctx, `Depth ${(Math.max(0, -a.contact.lowPointHeight) * 1000).toFixed(0)} mm · heights x2.2`, 6, 28);
  }

  // The clubface with the sweet spot and strike points, 1 px = 0.4 mm.
  private drawFace(records: [SwingRecord, boolean][]): void {
    const { ctx, w, h } = sized(this.face);
    const spec = records[0][0].club;
    const geo = clubGeometry(spec);
    const scale = Math.min(w / 0.13, h / 0.075) * 0.8;
    const cx = w / 2;
    const base = h * 0.82;
    const faceW = spec.head === 'driver' ? 0.11 : spec.head === 'wood' ? 0.09 : spec.head === 'putter' ? 0.1 : 0.075;
    const faceH = spec.head === 'driver' ? 0.058 : spec.head === 'wood' ? 0.04 : spec.head === 'putter' ? 0.025 : 0.048;
    ctx.fillStyle = '#d9dcdc';
    ctx.strokeStyle = '#7d8585';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (spec.head === 'driver' || spec.head === 'wood') {
      ctx.ellipse(cx, base - (faceH * scale) / 2, (faceW * scale) / 2, (faceH * scale) / 2, 0, 0, Math.PI * 2);
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
    if (spec.head === 'iron') {
      ctx.strokeStyle = '#b4baba';
      ctx.lineWidth = 1;
      for (let y = 0.004; y < faceH * 0.8; y += 0.0036) {
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
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 6, sy);
    ctx.lineTo(cx + 6, sy);
    ctx.moveTo(cx, sy - 6);
    ctx.lineTo(cx, sy + 6);
    ctx.stroke();
    for (const [r, planned] of records) {
      const c = r.contact.contact;
      ctx.fillStyle = planned ? 'rgba(138,149,142,0.8)' : ACTUAL;
      ctx.beginPath();
      ctx.arc(cx + c.toe * scale, sy - c.height * scale, planned ? 5 : 6, 0, Math.PI * 2);
      ctx.fill();
    }
    const a = records[records.length - 1][0].contact.contact;
    label(ctx, `${Math.abs(a.toe * 1000).toFixed(0)} mm ${a.toe >= 0 ? 'toe' : 'heel'}, ${Math.abs(a.height * 1000).toFixed(0)} mm ${a.height >= 0 ? 'high' : 'low'}`, 6, 14, INK);
  }

  // Down the line: the swing plane from the ball up through the hands.
  private drawPlane(records: [SwingRecord, boolean][]): void {
    const { ctx, w, h } = sized(this.plane);
    const gy = h * 0.85;
    const bx = w * 0.72;
    ctx.strokeStyle = '#cfd9cf';
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.arc(bx, gy - 4, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (const [r, planned] of records) {
      const len = h * 0.9;
      arrow(ctx, bx, gy - 4, bx - Math.cos(r.plane) * len, gy - 4 - Math.sin(r.plane) * len, planned ? PLAN : ACTUAL, planned);
    }
    const a = records[records.length - 1][0];
    label(ctx, `Plane ${toDegrees(a.plane).toFixed(0)}° from the ground`, 6, 14, INK);
    label(ctx, a.club.name, 6, 28);
  }

  private drawTable(plan: SwingRecord, actual: SwingRecord | null, system: UnitSystem): void {
    const dist = unitFor('distance', system);
    const speed = unitFor('speed', system);
    const rows: [string, (r: SwingRecord) => number, (v: number) => string, number][] = [
      ['Club speed', (r) => speed.fromSI(r.delivery.clubSpeed * r.contact.contact.speedFactor), (v) => `${v.toFixed(1)} ${speed.label}`, 3],
      ['Attack angle', (r) => toDegrees(r.delivery.attackAngle), deg, 2],
      ['Club path', (r) => toDegrees(r.delivery.clubPath), deg, 3],
      ['Face angle', (r) => toDegrees(r.delivery.faceAngle), deg, 3],
      ['Face to path', (r) => toDegrees(r.delivery.faceAngle - r.delivery.clubPath), deg, 3],
      ['Dynamic loft', (r) => toDegrees(r.delivery.dynamicLoft), deg, 3],
      ['Spin loft', (r) => toDegrees(spinLoft(r.delivery)), deg, 3],
      ['Low point', (r) => r.contact.lowPoint * 100, (v) => `${v.toFixed(1)} cm`, 4],
      ['Strike height', (r) => r.contact.contact.height * 1000, (v) => `${v.toFixed(0)} mm`, 8],
      ['Strike toe', (r) => r.contact.contact.toe * 1000, (v) => `${v.toFixed(0)} mm`, 8],
      ['Ball speed', (r) => speed.fromSI(r.launch.ballSpeed), (v) => `${v.toFixed(1)} ${speed.label}`, 5],
      ['Smash factor', (r) => r.launch.ballSpeed / r.delivery.clubSpeed, (v) => v.toFixed(2), 0.1],
      ['Launch angle', (r) => toDegrees(r.launch.launchAngle), deg, 3],
      ['Launch direction', (r) => toDegrees(r.launch.launchDirection), deg, 3],
      ['Spin rate', (r) => toRpm(r.launch.spinRate), (v) => `${v.toFixed(0)} rpm`, 800],
      ['Spin axis', (r) => toDegrees(r.launch.spinAxis), deg, 6],
      ['Backspin', (r) => toRpm(r.launch.spinRate * Math.cos(r.launch.spinAxis)), (v) => `${v.toFixed(0)} rpm`, 800],
      ['Sidespin', (r) => toRpm(r.launch.spinRate * Math.sin(r.launch.spinAxis)), (v) => `${v.toFixed(0)} rpm`, 600],
      ['Carry', (r) => dist.fromSI(r.shot.flight.carry), (v) => `${v.toFixed(1)} ${dist.label}`, 15],
      ['Total', (r) => dist.fromSI(r.shot.total), (v) => `${v.toFixed(1)} ${dist.label}`, 15],
      ['Offline', (r) => dist.fromSI(r.shot.restPosition.z), (v) => `${v.toFixed(1)} ${dist.label}`, 10],
      ['Apex', (r) => dist.fromSI(r.shot.flight.apexPosition.y), (v) => `${v.toFixed(1)} ${dist.label}`, 6],
      ['Landing angle', (r) => toDegrees(r.shot.flight.landingAngle), deg, 6],
    ];
    const html = rows.map(([name, get, fmt, range]) => {
      const p = get(plan);
      if (!actual) return `<tr><th>${name}</th><td>${fmt(p)}</td><td></td><td></td></tr>`;
      const a = get(actual);
      const d = a - p;
      const pct = Math.max(-50, Math.min(50, (d / range) * 25));
      return `<tr><th>${name}</th><td>${fmt(p)}</td><td>${fmt(a)}</td><td class="delta"><span class="bar" style="${pct < 0 ? `right:50%;width:${-pct}%` : `left:50%;width:${pct}%`}"></span><em>${d >= 0 ? '+' : ''}${fmt(d).replace(/^(-?)/, '$1')}</em></td></tr>`;
    }).join('');
    this.table.innerHTML = `<table><thead><tr><th></th><th>Planned</th><th>${actual ? 'Your swing' : ''}</th><th>${actual ? 'Difference' : ''}</th></tr></thead><tbody>${html}</tbody></table>`;
  }
}

const deg = (v: number) => `${v.toFixed(1)}°`;

function describe(r: SwingRecord): string {
  const d = r.delivery;
  const f2p = toDegrees(d.faceAngle - d.clubPath);
  const shape = Math.abs(f2p) < 1 ? 'straight' : f2p > 0 ? (f2p > 4 ? 'slice' : 'fade') : f2p < -4 ? 'hook' : 'draw';
  const start = toDegrees(r.launch.launchDirection);
  const startText = Math.abs(start) < 0.5 ? 'starts on line' : `starts ${Math.abs(start).toFixed(1)}° ${start > 0 ? 'right' : 'left'}`;
  return `Face ${Math.abs(f2p).toFixed(1)}° ${f2p >= 0 ? 'open' : 'closed'} to the path: a ${shape} that ${startText}.`;
}
