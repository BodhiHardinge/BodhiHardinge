import { ARROWS, PHASE_INFO, TimingRun, type Arrow, type Judgement, type Prompt, type TimingSettings } from '../../game/timing.ts';

const GLYPH: Record<Arrow, string> = { left: '←', up: '↑', down: '↓', right: '→' };
const KEYS: Record<string, Arrow> = { ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'right' };
const CALL: Record<Judgement['grade'], string> = {
  perfect: 'Perfect', great: 'Great', good: 'Good', poor: 'Poor', miss: 'Missed', wrong: 'Wrong key',
};

/** Where the target line sits, as a share of the track height from the top. */
const LINE = 0.82;

/**
 * The timing lane: arrows fall down four columns to a line, one per swing moment. Press the matching arrow key
 * (or tap the column) as it crosses.
 */
export class Lane {
  private readonly root: HTMLElement;
  private readonly track: HTMLElement;
  private readonly phaseLabel: HTMLElement;
  private readonly call: HTMLElement;
  private run: TimingRun | null = null;
  private settings: TimingSettings | null = null;
  private notes: HTMLElement[] = [];
  private receptors = new Map<Arrow, HTMLElement>();
  private startedAt = 0;
  private frame = 0;
  private done: ((judgements: Judgement[]) => void) | null = null;
  private readonly onKey = (event: KeyboardEvent) => this.key(event);

  constructor(root: HTMLElement, track: HTMLElement, phaseLabel: HTMLElement, call: HTMLElement) {
    this.root = root;
    this.track = track;
    this.phaseLabel = phaseLabel;
    this.call = call;
  }

  get active(): boolean {
    return this.run !== null;
  }

  start(prompts: readonly Prompt[], settings: TimingSettings, random: () => number, done: (judgements: Judgement[]) => void): void {
    this.settings = settings;
    this.run = new TimingRun(prompts, settings, random);
    this.done = done;
    this.build(prompts);
    this.root.hidden = false;
    this.call.textContent = '';
    this.startedAt = performance.now() + 250;
    window.addEventListener('keydown', this.onKey);
    this.frame = requestAnimationFrame(() => this.tick());
  }

  private now(at = performance.now()): number {
    return (at - this.startedAt) / 1000;
  }

  private build(prompts: readonly Prompt[]): void {
    this.track.replaceChildren();
    this.receptors.clear();
    for (const arrow of ARROWS) {
      const column = document.createElement('div');
      column.className = 'lane-column';
      const receptor = document.createElement('button');
      receptor.type = 'button';
      receptor.className = 'lane-receptor';
      receptor.style.top = `${LINE * 100}%`;
      receptor.textContent = GLYPH[arrow];
      receptor.setAttribute('aria-label', `${arrow} arrow`);
      receptor.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.hit(arrow, this.now(event.timeStamp || performance.now()));
      });
      column.append(receptor);
      this.receptors.set(arrow, receptor);
      this.track.append(column);
    }
    this.notes = prompts.map((p) => {
      const note = document.createElement('div');
      note.className = `lane-note phase-${p.phase}`;
      note.textContent = GLYPH[p.arrow];
      note.style.left = `${(ARROWS.indexOf(p.arrow) + 0.5) * 25}%`;
      this.track.append(note);
      return note;
    });
  }

  private key(event: KeyboardEvent): void {
    const arrow = KEYS[event.key];
    if (!arrow || !this.run) return;
    event.preventDefault();
    if (event.repeat) return;
    // Key events carry their own time stamp on the same clock, so frame timing does not blur the judgement.
    this.hit(arrow, this.now(event.timeStamp || performance.now()));
  }

  private hit(arrow: Arrow, time: number): void {
    if (!this.run) return;
    const receptor = this.receptors.get(arrow);
    receptor?.classList.remove('pressed');
    void receptor?.offsetWidth;
    receptor?.classList.add('pressed');
    const before = this.run.current;
    const judgement = this.run.press(arrow, time);
    for (let i = Math.max(0, before); i < this.run.judgements.length; i++) this.mark(i);
    if (judgement) this.announce(judgement);
  }

  private mark(i: number): void {
    const j = this.run?.judgements[i];
    if (j) this.notes[i].dataset.grade = j.grade;
  }

  private announce(j: Judgement): void {
    const when = j.offset === null || j.grade === 'perfect' || j.grade === 'wrong' ? '' : j.offset < 0 ? 'Early · ' : 'Late · ';
    this.call.textContent = `${when}${CALL[j.grade]}`;
    this.call.dataset.grade = j.grade;
    this.call.classList.remove('pop');
    void this.call.offsetWidth;
    this.call.classList.add('pop');
  }

  private tick(): void {
    const run = this.run;
    const settings = this.settings;
    if (!run || !settings) return;
    const t = this.now();
    for (const missed of run.advance(t)) this.announce(missed);
    run.judgements.forEach((_, i) => this.mark(i));

    const height = this.track.clientHeight;
    run.prompts.forEach((p, i) => {
      // Arrows fall at constant speed and reach the line exactly on their beat.
      const y = (LINE + ((t - p.time) / settings.laneTime) * LINE) * height;
      const note = this.notes[i];
      note.style.transform = `translate(-50%, ${y}px) translate(0, -50%)`;
      note.style.opacity = y < -40 || y > height + 40 ? '0' : '1';
    });

    const next = run.current === -1 ? null : run.prompts[run.current];
    this.phaseLabel.innerHTML = next
      ? `<b>${PHASE_INFO[next.phase].label}</b><span>${PHASE_INFO[next.phase].controls}</span>`
      : '<b>Through the ball</b>';

    const last = run.prompts[run.prompts.length - 1];
    if (run.finished && t > last.time + 0.45) {
      this.stop();
      return;
    }
    this.frame = requestAnimationFrame(() => this.tick());
  }

  private stop(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('keydown', this.onKey);
    const run = this.run!;
    const done = this.done;
    this.run = null;
    this.done = null;
    this.root.hidden = true;
    done?.(run.judgements.map((j) => j!));
  }
}
