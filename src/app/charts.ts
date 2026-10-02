import type { FlightResult } from '../physics/flight.ts';
import { STATE_SIZE } from '../physics/launch.ts';
import { unitFor, type UnitSystem } from './units.ts';

export type View = 'side' | 'top';

interface Theme {
  readonly background: string;
  readonly grid: string;
  readonly frame: string;
  readonly tick: string;
  readonly axisLabel: string;
  readonly ground: string;
  readonly launch: string;
  readonly apex: string;
  readonly land: string;
  readonly accent: string;
  readonly path: readonly [number, number, number][];
  readonly mono: string;
  readonly sans: string;
}

const PAD = { left: 54, right: 18, top: 28, bottom: 42 };
const SAMPLES = 240;

function readTheme(): Theme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v('--canvas-bg'),
    grid: v('--grid-line'),
    frame: v('--frame'),
    tick: v('--tick-text'),
    axisLabel: v('--axis-label'),
    ground: v('--ground-color'),
    launch: v('--launch-color'),
    apex: v('--apex-color'),
    land: v('--land-color'),
    accent: v('--teal'),
    path: [hexToRgb(v('--traj-start')), hexToRgb(v('--traj-mid')), hexToRgb(v('--traj-end'))],
    mono: v('--mono'),
    sans: v('--sans'),
  };
}

// Any CSS colour, normalised by the canvas to #rrggbb so short or named forms parse too.
function hexToRgb(colour: string): [number, number, number] {
  const ctx = document.createElement('canvas').getContext('2d');
  if (ctx) ctx.fillStyle = colour;
  const n = Number.parseInt(String(ctx?.fillStyle ?? colour).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function pathColour(stops: Theme['path'], t: number): string {
  const scaled = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(',')})`;
}

/** A round step size giving roughly `ticks` gridlines across `range`. */
function niceStep(range: number, ticks: number): number {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}

const ROUND_FACTORS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The smallest round number (such as 150, 200, 250 or 300) at or above value. */
function niceCeil(value: number): number {
  const mag = 10 ** Math.floor(Math.log10(value));
  return ROUND_FACTORS.find((f) => f * mag >= value)! * mag;
}

const lateralLabel = (v: number) => (Math.abs(v) < 1e-9 ? '0' : `${Math.abs(v)}${v < 0 ? 'L' : 'R'}`);

export interface WindIndicator {
  /** Direction the wind blows from, rad (0 = headwind). */
  readonly from: number;
  /** m/s */
  readonly speed: number;
}

/** One launch-monitor style screen: a side or top view of the flight. */
export class FlightChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly view: View;
  private theme: Theme | null = null;
  private xMax = 0;
  private yMax = 0;
  private system: UnitSystem | null = null;
  private readonly buffer = new Float64Array(STATE_SIZE);

  constructor(canvas: HTMLCanvasElement, view: View) {
    this.canvas = canvas;
    this.view = view;
  }

  render(result: FlightResult, system: UnitSystem, wind: WindIndicator): void {
    this.theme ??= readTheme();
    const theme = this.theme;
    const ctx = this.prepare();
    if (!ctx) return;
    const { width: W, height: H } = ctx.canvas.getBoundingClientRect();

    const distance = unitFor('distance', system);
    const vertical = this.view === 'side' ? unitFor('height', system) : distance;

    const xs = new Float64Array(SAMPLES + 1);
    const ys = new Float64Array(SAMPLES + 1);
    const duration = result.trajectory.duration;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const s = result.trajectory.stateAt((duration * i) / SAMPLES, this.buffer);
      xs[i] = distance.fromSI(s[0]);
      ys[i] = vertical.fromSI(this.view === 'side' ? s[1] : s[2]);
      maxX = Math.max(maxX, xs[i]);
      maxY = Math.max(maxY, this.view === 'side' ? ys[i] : Math.abs(ys[i]));
    }
    this.updateScale(system, maxX, maxY);

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const sx = (x: number) => PAD.left + (x / this.xMax) * plotW;
    const sy =
      this.view === 'side'
        ? (y: number) => PAD.top + plotH - (y / this.yMax) * plotH
        : (z: number) => PAD.top + plotH / 2 + (z / this.yMax) * (plotH / 2);

    this.drawGrid(ctx, theme, H, plotW, plotH, sx, sy, distance.label, vertical.label);

    ctx.lineWidth = 2.25;
    ctx.lineCap = 'round';
    for (let i = 1; i <= SAMPLES; i++) {
      ctx.strokeStyle = pathColour(theme.path, i / SAMPLES);
      ctx.beginPath();
      ctx.moveTo(sx(xs[i - 1]), sy(ys[i - 1]));
      ctx.lineTo(sx(xs[i]), sy(ys[i]));
      ctx.stroke();
    }

    ctx.fillStyle = theme.launch;
    ctx.beginPath();
    ctx.arc(sx(0), sy(0), 4, 0, 2 * Math.PI);
    ctx.fill();

    if (this.view === 'side') {
      const ax = distance.fromSI(result.apexPosition.x);
      const ay = vertical.fromSI(result.apexPosition.y);
      this.drawApex(ctx, theme, sx(ax), sy(ay), sy(0), `${ay.toFixed(1)} ${vertical.label}`);
    }

    if (result.landed) {
      const lx = distance.fromSI(result.landingPosition.x);
      const ly = this.view === 'side' ? 0 : distance.fromSI(result.landingPosition.z);
      const label =
        this.view === 'side'
          ? `${distance.fromSI(result.carry).toFixed(1)} ${distance.label}`
          : `${Math.abs(ly).toFixed(1)} ${distance.label} ${ly > 0.05 ? 'R' : ly < -0.05 ? 'L' : ''}`.trim();
      this.drawLanding(ctx, theme, sx(lx), sy(ly), label, W);
    }

    const next = this.drawTag(ctx, theme, PAD.left + 8, this.view === 'side' ? 'SIDE VIEW' : 'TOP VIEW');
    if (this.view === 'top' && wind.speed > 0.05) this.drawWind(ctx, theme, wind, system, next);
  }

  private prepare(): CanvasRenderingContext2D | null {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.theme!.background;
    ctx.fillRect(0, 0, rect.width, rect.height);
    return ctx;
  }

  // Axes only rescale when the shot outgrows them or shrinks a lot, so they don't jitter while dragging.
  private updateScale(system: UnitSystem, maxX: number, maxY: number): void {
    if (system !== this.system) {
      this.system = system;
      this.xMax = 0;
      this.yMax = 0;
    }
    const needX = niceCeil(Math.max(maxX * 1.08, 10));
    if (needX > this.xMax || needX < this.xMax * 0.6) this.xMax = needX;
    const minY = this.view === 'side' ? (system === 'imperial' ? 40 : 12) : 10;
    const needY = niceCeil(Math.max(maxY * (this.view === 'side' ? 1.3 : 1.25), minY));
    if (needY > this.yMax || needY < this.yMax * 0.6) this.yMax = needY;
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    theme: Theme,
    H: number,
    plotW: number,
    plotH: number,
    sx: (x: number) => number,
    sy: (y: number) => number,
    xUnit: string,
    yUnit: string,
  ): void {
    ctx.save();
    const glow = ctx.createRadialGradient(
      PAD.left + plotW / 2, PAD.top + plotH / 2, 0,
      PAD.left + plotW / 2, PAD.top + plotH / 2, Math.max(plotW, plotH) * 0.7,
    );
    glow.addColorStop(0, 'rgba(0,0,0,0)');
    glow.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = glow;
    ctx.fillRect(PAD.left, PAD.top, plotW, plotH);

    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.font = `10px ${theme.mono}`;
    ctx.fillStyle = theme.tick;

    const xStep = niceStep(this.xMax, 7);
    ctx.textAlign = 'center';
    for (let x = 0; x <= this.xMax + 1e-9; x += xStep) {
      const px = sx(x);
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, PAD.top + plotH);
      ctx.stroke();
      ctx.fillText(String(Math.round(x)), px, PAD.top + plotH + 14);
    }

    ctx.textAlign = 'right';
    if (this.view === 'side') {
      const yStep = niceStep(this.yMax, 5);
      for (let y = 0; y <= this.yMax + 1e-9; y += yStep) {
        const py = sy(y);
        ctx.beginPath();
        ctx.moveTo(PAD.left, py);
        ctx.lineTo(PAD.left + plotW, py);
        ctx.stroke();
        ctx.fillText(String(Math.round(y)), PAD.left - 6, py + 3);
      }
    } else {
      const yStep = niceStep(this.yMax, 2);
      const count = Math.floor(this.yMax / yStep + 1e-9);
      for (let k = -count; k <= count; k++) {
        const z = k * yStep;
        const py = sy(z);
        ctx.beginPath();
        ctx.moveTo(PAD.left, py);
        ctx.lineTo(PAD.left + plotW, py);
        ctx.stroke();
        ctx.fillText(lateralLabel(z), PAD.left - 6, py + 3);
      }
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = theme.ground;
    ctx.lineWidth = this.view === 'side' ? 1.5 : 1;
    if (this.view === 'top') ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, sy(0));
    ctx.lineTo(PAD.left + plotW, sy(0));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = theme.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD.left, PAD.top, plotW, plotH);

    ctx.fillStyle = theme.axisLabel;
    ctx.font = `10px ${theme.sans}`;
    ctx.textAlign = 'center';
    ctx.fillText(`Distance (${xUnit})`, PAD.left + plotW / 2, H - 8);
    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(this.view === 'side' ? `Height (${yUnit})` : `Lateral (${yUnit})`, 0, 0);
    ctx.restore();
    ctx.restore();
  }

  private drawApex(ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number, groundY: number, label: string): void {
    ctx.save();
    ctx.strokeStyle = theme.apex;
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, groundY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.apex;
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x, y + 6);
    ctx.lineTo(x - 5, y);
    ctx.closePath();
    ctx.fill();
    ctx.font = `600 10px ${theme.mono}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y - 10);
    ctx.restore();
  }

  private drawLanding(ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number, label: string, W: number): void {
    ctx.save();
    ctx.strokeStyle = theme.land;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 5, y - 5);
    ctx.lineTo(x + 5, y + 5);
    ctx.moveTo(x + 5, y - 5);
    ctx.lineTo(x - 5, y + 5);
    ctx.stroke();
    ctx.fillStyle = theme.land;
    ctx.font = `600 10px ${theme.mono}`;
    const width = ctx.measureText(label).width;
    const fitsRight = x + 10 + width < W - PAD.right;
    ctx.textAlign = fitsRight ? 'left' : 'right';
    ctx.fillText(label, fitsRight ? x + 10 : x - 10, this.view === 'side' ? y - 8 : y + 4);
    ctx.restore();
  }

  /** Draws a tag in the plot's top-left corner row and returns the x where the next tag can start. */
  private drawTag(ctx: CanvasRenderingContext2D, theme: Theme, x: number, text: string, icon = 0): number {
    ctx.save();
    ctx.font = `700 9px ${theme.mono}`;
    const w = ctx.measureText(text).width + 16 + icon;
    const y = PAD.top + 8;
    ctx.fillStyle = 'rgba(13, 216, 178, 0.08)';
    ctx.strokeStyle = 'rgba(13, 216, 178, 0.22)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, 18, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.accent;
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 8 + icon, y + 12.5);
    ctx.restore();
    return x + w + 6;
  }

  private drawWind(ctx: CanvasRenderingContext2D, theme: Theme, wind: WindIndicator, system: UnitSystem, x: number): void {
    const speed = unitFor('speed', system);
    this.drawTag(ctx, theme, x, `WIND ${speed.fromSI(wind.speed).toFixed(1)} ${speed.label}`, 14);
    // Screen x is downrange and screen y points right of target, so the wind vector maps directly.
    const dx = -Math.cos(wind.from);
    const dy = -Math.sin(wind.from);
    const cx = x + 13;
    const cy = PAD.top + 17;
    const len = 5.5;
    const angle = Math.atan2(dy, dx);
    const tipX = cx + dx * len;
    const tipY = cy + dy * len;
    ctx.save();
    ctx.strokeStyle = theme.accent;
    ctx.fillStyle = theme.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - dx * len, cy - dy * len);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 4.5 * Math.cos(angle - 0.5), tipY - 4.5 * Math.sin(angle - 0.5));
    ctx.lineTo(tipX - 4.5 * Math.cos(angle + 0.5), tipY - 4.5 * Math.sin(angle + 0.5));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
