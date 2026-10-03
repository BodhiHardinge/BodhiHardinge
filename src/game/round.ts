import type { Point } from '../physics/hole.ts';
import type { Course } from './course.ts';

export interface Stroke {
  readonly from: Point;
  readonly to: Point;
  readonly club: string;
  readonly lie: string;
  readonly holed: boolean;
}

/** A round in progress: where the ball is, strokes so far, and the card. */
export class Round {
  readonly course: Course;
  readonly scores: (number | null)[];
  hole = 0;
  ball: Point = { x: 0, z: 0 };
  strokes: Stroke[] = [];
  holed = false;

  constructor(course: Course) {
    this.course = course;
    this.scores = course.holes.map(() => null);
    this.ball = course.holes[0].tee;
  }

  /** True before the first stroke on this hole: the ball is on the tee. */
  get onTee(): boolean {
    return this.strokes.length === 0 || this.strokes.every((s) => s.club === 'Penalty' || (s.to.x === this.current.tee.x && s.to.z === this.current.tee.z));
  }

  get current() {
    return this.course.holes[this.hole];
  }

  get finished(): boolean {
    return this.hole === this.course.holes.length - 1 && this.holed;
  }

  /** Distance from the ball to the flag, m. */
  get toPin(): number {
    const pin = this.current.layout.pin;
    return Math.hypot(pin.x - this.ball.x, pin.z - this.ball.z);
  }

  record(stroke: Stroke): void {
    this.strokes.push(stroke);
    this.ball = stroke.to;
    if (stroke.holed) {
      this.holed = true;
      this.scores[this.hole] = this.strokes.length;
    }
  }

  /** Jumps to any hole (0-based), starting it fresh from the tee. Holes left unfinished stay blank on the card. */
  goToHole(index: number): void {
    if (index < 0 || index >= this.course.holes.length) return;
    this.hole = index;
    this.ball = this.current.tee;
    this.strokes = [];
    this.holed = false;
    this.scores[index] = null;
  }

  nextHole(): void {
    if (this.hole >= this.course.holes.length - 1) return;
    this.hole += 1;
    this.ball = this.current.tee;
    this.strokes = [];
    this.holed = false;
  }

  /** Total strokes and the score against par for holes played. */
  get total(): { strokes: number; toPar: number } {
    let strokes = 0;
    let par = 0;
    this.scores.forEach((s, i) => {
      if (s === null) return;
      strokes += s;
      par += this.course.holes[i].par;
    });
    return { strokes, toPar: strokes - par };
  }
}

/** Golf's names for a hole score. */
export function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return 'Hole in one';
  const names: Record<number, string> = { [-3]: 'Albatross', [-2]: 'Eagle', [-1]: 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double bogey', 3: 'Triple bogey' };
  return names[strokes - par] ?? `${strokes - par > 0 ? '+' : ''}${strokes - par}`;
}
