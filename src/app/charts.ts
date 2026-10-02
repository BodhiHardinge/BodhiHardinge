import type { Shot } from '../physics/ground.ts';
import type { HoleLayout } from '../physics/hole.ts';
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
  readonly ghost: string;
  readonly tour: string;
  readonly trail: string;
  readonly green: string;
  readonly pin: string;
  readonly dots: string;
  readonly tagBg: string;
  readonly tagBorder: string;
  readonly tagText: string;
  readonly path: readonly [number, number, number][];
  readonly font: string;
}

export interface WindIndicator {
  /** Direction the wind blows from, rad (0 = headwind). */
  readonly from: number;
  /** m/s */
  readonly speed: number;
}

export interface ChartExtras {
  /** The same shot in standard conditions, drawn as a faint dashed line. */
  readonly ghost?: Shot | null;
  /** The Tour average for the same club in the same conditions, drawn as a blue dashed line. */
  readonly tour?: Shot | null;
  /** Other recorded shots, drawn as faint lines. */
  readonly trails?: readonly Shot[];
  readonly hole?: HoleLayout | null;
  /** Landing points of other shots (x downrange, z right), m. */
  readonly dispersion?: readonly { readonly x: number; readonly z: number }[];
}

const PAD = { left: 50, right: 16, top: 30, bottom: 40 };
const SAMPLES = 480;

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
    ghost: v('--ghost-color'),
    tour: v('--tour-color'),
    trail: v('--trail-color'),
    green: v('--green-surface'),
    pin: v('--pin-color'),
    dots: v('--dispersion-color'),
    tagBg: v('--tag-bg'),
    tagBorder: v('--tag-border'),
    tagText: v('--tag-text'),
    path: [toRgb(v('--traj-start')), toRgb(v('--traj-mid')), toRgb(v('--traj-end'))],
    font: v('--sans'),
  };
}

// Any CSS colour, normalised by the canvas to #rrggbb so short or named forms parse too.
function toRgb(colour: string): [number, number, number] {
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

const sideOf = (v: number) => (v > 0.05 ? ' R' : v < -0.05 ? ' L' : '');

/**
 * A side or top view of the whole shot, drawn to scale: one unit across is the same length as one unit up,
 * so the true shape of the flight shows.
 */
export class FlightChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly view: View;
  private theme: Theme | null = null;
  private span = 0;
  private system: UnitSystem | null = null;

  constructor(canvas: HTMLCanvasElement, view: View) {
    this.canvas = canvas;
    this.view = view;
  }

  render(shot: Shot, system: UnitSystem, wind: WindIndicator, extras: ChartExtras = {}): void {
    this.theme ??= readTheme();
    const theme = this.theme;
    const ctx = this.prepare(theme);
    if (!ctx) return;
    const { width: W, height: H } = ctx.canvas.getBoundingClientRect();
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    if (plotW <= 0 || plotH <= 0) return;

    const unit = unitFor('distance', system);
    const d = unit.fromSI;
    const pointsOf = (s: Shot, samples = SAMPLES) =>
      Array.from({ length: samples + 1 }, (_, i) => {
        const p = s.positionAt((s.duration * i) / samples);
        return { x: d(p.x), v: d(this.view === 'side' ? p.y : p.z) };
      });
    const points = pointsOf(shot);
    const ghost = extras.ghost ? pointsOf(extras.ghost) : [];
    const tour = extras.tour ? pointsOf(extras.tour) : [];
    const trails = (extras.trails ?? []).map((t) => pointsOf(t, 90));
    const pinX = extras.hole ? d(extras.hole.pin.x) : 0;

    // One scale for both axes, chosen so the whole shot (and the pin) fits.
    const all = [...points, ...ghost, ...tour];
    let needX = Math.max(10, pinX + 8, ...all.map((p) => p.x)) * 1.06;
    const needV = Math.max(4, ...all.map((p) => Math.abs(p.v))) * 1.25;
    needX = Math.max(needX, (needV * plotW) / (this.view === 'side' ? plotH : plotH / 2));
    this.updateSpan(system, niceCeil(needX));
    const scale = plotW / this.span;
    const sx = (x: number) => PAD.left + x * scale;
    const sy = this.view === 'side' ? (v: number) => PAD.top + plotH - v * scale : (v: number) => PAD.top + plotH / 2 + v * scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, plotW, plotH);
    ctx.clip();
    this.drawGrid(ctx, theme, plotW, plotH, scale, sx, sy);
    if (this.view === 'top' && extras.hole) {
      const g = extras.hole.green;
      ctx.fillStyle = theme.green;
      ctx.beginPath();
      ctx.arc(sx(d(g.x)), sy(d(g.z)), d(g.radius) * scale, 0, 2 * Math.PI);
      ctx.fill();
    }
    if (this.view === 'top' && extras.dispersion) {
      ctx.fillStyle = theme.dots;
      for (const p of extras.dispersion) {
        ctx.beginPath();
        ctx.arc(sx(d(p.x)), sy(d(p.z)), 2.2, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    const line = (pts: { x: number; v: number }[], colour: string, width: number, dash: number[]) => {
      if (!pts.length) return;
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.v)) : ctx.moveTo(sx(p.x), sy(p.v))));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    for (const trail of trails) line(trail, theme.trail, 1, []);
    line(ghost, theme.ghost, 1.5, [5, 4]);
    line(tour, theme.tour, 1.75, [7, 3]);
    if (extras.hole) this.drawPin(ctx, theme, sx(pinX), sy(this.view === 'side' ? 0 : d(extras.hole.pin.z)), scale, unit.label);

    ctx.lineWidth = 2.25;
    ctx.lineCap = 'round';
    for (let i = 1; i < points.length; i++) {
      ctx.strokeStyle = pathColour(theme.path, i / SAMPLES);
      ctx.beginPath();
      ctx.moveTo(sx(points[i - 1].x), sy(points[i - 1].v));
      ctx.lineTo(sx(points[i].x), sy(points[i].v));
      ctx.stroke();
    }
    ctx.restore();
    this.drawAxes(ctx, theme, plotW, plotH, scale, niceStep(this.span, 7), sx, sy);

    ctx.fillStyle = theme.launch;
    ctx.beginPath();
    ctx.arc(sx(0), sy(0), 4, 0, 2 * Math.PI);
    ctx.fill();

    const flight = shot.flight;
    if (this.view === 'side') {
      const ax = d(flight.apexPosition.x);
      const ay = d(flight.apexPosition.y);
      this.drawApex(ctx, theme, sx(ax), sy(ay), sy(0), `${ay.toFixed(1)} ${unit.label} high`);
    }
    if (flight.landed) {
      const lv = this.view === 'side' ? 0 : d(flight.landingPosition.z);
      this.drawCross(ctx, theme, sx(d(flight.landingPosition.x)), sy(lv));
      const rest = shot.restPosition;
      const rv = this.view === 'side' ? 0 : d(rest.z);
      const label =
        this.view === 'side'
          ? `${d(flight.carry).toFixed(1)} carry, ${d(shot.total).toFixed(1)} total`
          : `${Math.abs(d(rest.z)).toFixed(1)} ${unit.label}${sideOf(rest.z)}`;
      this.drawRest(ctx, theme, sx(d(rest.x)), sy(rv), label, W);
    }

    const next = this.drawTag(ctx, theme, PAD.left + 8, this.view === 'side' ? 'SIDE VIEW · TO SCALE' : 'TOP VIEW · TO SCALE');
    if (this.view === 'top' && wind.speed > 0.05) this.drawWind(ctx, theme, wind, system, next);
  }

  private prepare(theme: Theme): CanvasRenderingContext2D | null {
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
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, rect.width, rect.height);
    return ctx;
  }

  // The span only changes when the shot outgrows it or shrinks a lot, so it doesn't jitter while dragging.
  private updateSpan(system: UnitSystem, need: number): void {
    if (system !== this.system) {
      this.system = system;
      this.span = 0;
    }
    if (need > this.span || need < this.span * 0.6) this.span = need;
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    theme: Theme,
    plotW: number,
    plotH: number,
    scale: number,
    sx: (x: number) => number,
    sy: (v: number) => number,
  ): void {
    const step = niceStep(this.span, 7);
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    for (let x = 0; x <= this.span + 1e-9; x += step) {
      ctx.beginPath();
      ctx.moveTo(sx(x), PAD.top);
      ctx.lineTo(sx(x), PAD.top + plotH);
      ctx.stroke();
    }
    const rows = plotH / scale;
    const from = this.view === 'side' ? 0 : -Math.floor(rows / 2 / step) * step;
    for (let v = from; v <= (this.view === 'side' ? rows : rows / 2) + 1e-9; v += step) {
      ctx.beginPath();
      ctx.moveTo(PAD.left, sy(v));
      ctx.lineTo(PAD.left + plotW, sy(v));
      ctx.stroke();
    }
    ctx.strokeStyle = theme.ground;
    ctx.lineWidth = this.view === 'side' ? 1.5 : 1;
    if (this.view === 'top') ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, sy(0));
    ctx.lineTo(PAD.left + plotW, sy(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawAxes(
    ctx: CanvasRenderingContext2D,
    theme: Theme,
    plotW: number,
    plotH: number,
    scale: number,
    step: number,
    sx: (x: number) => number,
    sy: (v: number) => number,
  ): void {
    ctx.save();
    ctx.strokeStyle = theme.frame;
    ctx.strokeRect(PAD.left, PAD.top, plotW, plotH);
    ctx.fillStyle = theme.tick;
    ctx.font = `10px ${theme.font}`;
    ctx.textAlign = 'center';
    for (let x = 0; x <= this.span + 1e-9; x += step) ctx.fillText(String(Math.round(x)), sx(x), PAD.top + plotH + 14);
    ctx.textAlign = 'right';
    const rows = plotH / scale;
    if (this.view === 'side') {
      for (let v = 0; v <= rows + 1e-9; v += step) ctx.fillText(String(Math.round(v)), PAD.left - 6, sy(v) + 3);
    } else {
      const k = Math.floor(rows / 2 / step);
      for (let i = -k; i <= k; i++) {
        const v = i * step;
        ctx.fillText(v === 0 ? '0' : `${Math.abs(v)}${v < 0 ? 'L' : 'R'}`, PAD.left - 6, sy(v) + 3);
      }
    }
    const unit = unitFor('distance', this.system ?? 'imperial').label;
    ctx.fillStyle = theme.axisLabel;
    ctx.textAlign = 'center';
    ctx.fillText(`Distance (${unit})`, PAD.left + plotW / 2, PAD.top + plotH + 32);
    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(this.view === 'side' ? `Height (${unit})` : `Lateral (${unit})`, 0, 0);
    ctx.restore();
    ctx.restore();
  }

  private drawPin(ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number, scale: number, unit: string): void {
    ctx.save();
    ctx.strokeStyle = theme.pin;
    ctx.fillStyle = theme.pin;
    ctx.lineWidth = 1.5;
    if (this.view === 'side') {
      // A flagstick is 7 ft (2.13 m) tall; draw it at true size but never shorter than 14 px.
      const height = Math.max(14, (unit === 'yd' ? 2.33 : 2.13) * scale);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y - height);
      ctx.lineTo(x + 9, y - height + 3.5);
      ctx.lineTo(x, y - height + 7);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawApex(ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number, groundY: number, label: string): void {
    ctx.save();
    ctx.strokeStyle = theme.apex;
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, groundY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.apex;
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 4, y);
    ctx.lineTo(x, y + 5);
    ctx.lineTo(x - 4, y);
    ctx.closePath();
    ctx.fill();
    ctx.font = `600 10px ${theme.font}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y - 9);
    ctx.restore();
  }

  private drawCross(ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number): void {
    ctx.save();
    ctx.strokeStyle = theme.land;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 4);
    ctx.lineTo(x + 4, y + 4);
    ctx.moveTo(x + 4, y - 4);
    ctx.lineTo(x - 4, y + 4);
    ctx.stroke();
    ctx.restore();
  }

  private drawRest(ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number, label: string, W: number): void {
    ctx.save();
    ctx.fillStyle = theme.background;
    ctx.strokeStyle = theme.launch;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.launch;
    ctx.font = `600 10px ${theme.font}`;
    const width = ctx.measureText(label).width;
    const fitsRight = x + 10 + width < W - PAD.right;
    ctx.textAlign = fitsRight ? 'left' : 'right';
    ctx.fillText(label, fitsRight ? x + 10 : x - 10, this.view === 'side' ? y - 12 : y - 8);
    ctx.restore();
  }

  /** Draws a tag in the plot's top-left row and returns the x where the next tag can start. */
  private drawTag(ctx: CanvasRenderingContext2D, theme: Theme, x: number, text: string, icon = 0): number {
    ctx.save();
    ctx.font = `700 9px ${theme.font}`;
    const w = ctx.measureText(text).width + 16 + icon;
    const y = PAD.top - 22;
    ctx.fillStyle = theme.tagBg;
    ctx.strokeStyle = theme.tagBorder;
    ctx.beginPath();
    ctx.roundRect(x, y, w, 17, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.tagText;
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 8 + icon, y + 12);
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
    const cy = PAD.top - 13.5;
    const len = 5;
    const angle = Math.atan2(dy, dx);
    const tipX = cx + dx * len;
    const tipY = cy + dy * len;
    ctx.save();
    ctx.strokeStyle = theme.tagText;
    ctx.fillStyle = theme.tagText;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - dx * len, cy - dy * len);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 4 * Math.cos(angle - 0.5), tipY - 4 * Math.sin(angle - 0.5));
    ctx.lineTo(tipX - 4 * Math.cos(angle + 0.5), tipY - 4 * Math.sin(angle + 0.5));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
