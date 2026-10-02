import { findOutliers, type OutlierVerdict } from '../analysis/outliers.ts';
import type { ShotRecord } from '../analysis/shots.ts';
import { toDegrees, toRpm } from '../physics/units.ts';
import { clubsIn, readLibrary, typicalShot, type ShotLibrary } from './data.ts';
import { unitFor, type UnitSystem } from './units.ts';

const STORAGE_KEY = 'ballflight.shot-choices';

type Choice = 'keep' | 'drop';
type SortKey = 'club' | 'date' | 'ballSpeed' | 'launchAngle' | 'spinRate' | 'carry' | 'offline';

const keyOf = (s: ShotRecord) => `${s.date}|${s.club}|${s.ballSpeed.toFixed(3)}`;

function loadChoices(): Map<string, Choice> {
  try {
    return new Map(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as [string, Choice][]);
  } catch {
    return new Map();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/**
 * The "Your shots" panel: which clubs are in play, which shots count (outlier filter plus your own choices),
 * and a table to review them. Calls back when the selection or the shot to play changes.
 */
export class LibraryPanel {
  onPlay: (shot: ShotRecord, typical: boolean) => void = () => {};
  onSelectionChange: () => void = () => {};

  private library: ShotLibrary | null;
  private readonly clubs = new Set<string>();
  private threshold = 2.5;
  private hideOutliers = true;
  private hideEstimated = false;
  private readonly choices = loadChoices();
  private verdicts = new Map<ShotRecord, OutlierVerdict>();
  private system: UnitSystem = 'imperial';
  private playClub = '';
  private playIndex = -1;
  private sort: { key: SortKey; descending: boolean } = { key: 'date', descending: false };

  private readonly root: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly status = el('p', { className: 'library-name' });
  private readonly error = el('p', { className: 'library-error', hidden: true });
  private readonly chips = el('div', { className: 'chips' });
  private readonly summary = el('p', { className: 'library-name' });
  private readonly playClubSelect = el('select', { id: 'play-club' });
  private readonly playShotSelect = el('select', { id: 'play-shot' });
  private readonly thresholdInput = el('input', { type: 'range', id: 'outlier-threshold', min: '1.5', max: '5', step: '0.1' });
  private readonly thresholdLabel = el('span', { className: 'param-hint' });

  constructor(root: HTMLElement, dialog: HTMLDialogElement, library: ShotLibrary | null) {
    this.root = root;
    this.dialog = dialog;
    this.library = library;
    this.build();
    this.setLibrary(library);
  }

  setUnits(system: UnitSystem): void {
    this.system = system;
    this.fillPlayShots();
    if (this.dialog.open) this.renderTable();
  }

  /** Shots in the selected clubs that pass the filters and your choices. */
  selectedShots(): ShotRecord[] {
    return this.library ? this.library.shots.filter((s) => this.clubs.has(s.club) && this.kept(s)) : [];
  }

  keptShotsOf(club: string): ShotRecord[] {
    return this.library ? this.library.shots.filter((s) => s.club === club && this.kept(s)) : [];
  }

  clearPlayback(): void {
    this.playClubSelect.value = '';
    this.fillPlayShots();
  }

  private kept(shot: ShotRecord): boolean {
    const choice = this.choices.get(keyOf(shot));
    if (choice) return choice === 'keep';
    if (this.hideEstimated && !shot.spinMeasured) return false;
    return !(this.hideOutliers && this.verdicts.get(shot)?.outlier);
  }

  private setLibrary(library: ShotLibrary | null): void {
    this.library = library;
    this.clubs.clear();
    if (library) {
      const counts = clubsIn(library);
      const busiest = counts.reduce((a, b) => (b.count > a.count ? b : a), counts[0]);
      if (busiest) this.clubs.add(busiest.club);
    }
    this.recompute();
  }

  private recompute(): void {
    this.verdicts = this.library ? findOutliers(this.library.shots, { threshold: this.threshold, rejectEstimatedSpin: false }) : new Map();
    this.thresholdLabel.textContent = `beyond ${this.threshold.toFixed(1)}σ`;
    this.renderChips();
    this.fillPlayClubs();
    if (this.dialog.open) this.renderTable();
    this.onSelectionChange();
  }

  private build(): void {
    const file = el('input', { type: 'file', id: 'data-file', accept: '.csv,text/csv' });
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      try {
        this.setLibrary(await readLibrary(chosen));
        this.error.hidden = true;
      } catch (e) {
        this.error.textContent = e instanceof Error ? e.message : 'That file could not be read.';
        this.error.hidden = false;
      }
    });

    const outliers = el('input', { type: 'checkbox', id: 'hide-outliers', checked: true });
    outliers.addEventListener('change', () => {
      this.hideOutliers = outliers.checked;
      this.recompute();
    });
    this.thresholdInput.value = String(this.threshold);
    this.thresholdInput.setAttribute('aria-label', 'Outlier threshold in robust standard deviations');
    this.thresholdInput.addEventListener('input', () => {
      this.threshold = Number(this.thresholdInput.value);
      this.recompute();
    });
    const estimated = el('input', { type: 'checkbox', id: 'hide-estimated' });
    estimated.addEventListener('change', () => {
      this.hideEstimated = estimated.checked;
      this.recompute();
    });

    this.playClubSelect.addEventListener('change', () => {
      this.playIndex = -1;
      this.fillPlayShots();
      this.play();
    });
    this.playShotSelect.addEventListener('change', () => {
      this.playIndex = Number(this.playShotSelect.value);
      this.play();
    });
    const step = (delta: number) => {
      const count = this.keptShotsOf(this.playClub).length;
      if (!this.playClub || count === 0) return;
      this.playIndex = (this.playIndex + delta + count + 1) % (count + 1) - 1;
      this.playShotSelect.value = String(this.playIndex);
      this.play();
    };

    const table = el('button', { type: 'button', className: 'wide-button', textContent: 'Review shots in a table' });
    table.addEventListener('click', () => {
      this.renderTable();
      this.dialog.showModal();
    });

    this.root.replaceChildren(
      el('h2', { className: 'section-head first', textContent: 'Your shots' }),
      this.status,
      el('label', { className: 'file-button' }, 'Load an Awesome Golf or Garmin CSV', file),
      this.error,
      el('p', { className: 'subhead', textContent: 'Clubs' }),
      this.chips,
      el('label', { className: 'check' }, outliers, 'Hide outliers ', this.thresholdLabel),
      this.thresholdInput,
      el('label', { className: 'check' }, estimated, 'Hide shots with estimated spin'),
      this.summary,
      table,
      el('label', { className: 'field' }, el('span', { textContent: 'Play club' }), this.playClubSelect),
      el('label', { className: 'field' }, el('span', { textContent: 'Shot' }), this.playShotSelect),
      el('div', { className: 'shot-nav' },
        Object.assign(el('button', { type: 'button', textContent: 'Previous', id: 'prev-shot' }), { onclick: () => step(-1) }),
        Object.assign(el('button', { type: 'button', textContent: 'Next', id: 'next-shot' }), { onclick: () => step(1) }),
      ),
    );
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
  }

  private renderChips(): void {
    const lib = this.library;
    this.status.textContent = lib ? lib.name : 'No export loaded yet.';
    this.chips.replaceChildren();
    if (!lib) return;
    const counts = clubsIn(lib);
    const toggleAll = (on: boolean) => {
      this.clubs.clear();
      if (on) for (const { club } of counts) this.clubs.add(club);
      this.recompute();
    };
    for (const { club } of counts) {
      const kept = this.keptShotsOf(club).length;
      const chip = el('button', { type: 'button', className: 'chip', textContent: `${club} ${kept}` });
      chip.setAttribute('aria-pressed', String(this.clubs.has(club)));
      chip.addEventListener('click', () => {
        if (this.clubs.has(club)) this.clubs.delete(club);
        else this.clubs.add(club);
        this.recompute();
      });
      this.chips.append(chip);
    }
    this.chips.append(
      Object.assign(el('button', { type: 'button', className: 'chip chip-plain', textContent: 'All' }), { onclick: () => toggleAll(true) }),
      Object.assign(el('button', { type: 'button', className: 'chip chip-plain', textContent: 'None' }), { onclick: () => toggleAll(false) }),
    );
    const total = lib.shots.filter((s) => this.clubs.has(s.club)).length;
    this.summary.textContent = this.clubs.size ? `${this.selectedShots().length.toLocaleString()} of ${total.toLocaleString()} shots kept in the selected clubs.` : 'Choose one or more clubs.';
  }

  private fillPlayClubs(): void {
    const selected = [...this.clubs].sort((a, b) => clubsIn(this.library!).findIndex((c) => c.club === a) - clubsIn(this.library!).findIndex((c) => c.club === b));
    this.playClubSelect.replaceChildren(new Option(selected.length ? 'Choose a club' : 'Select clubs above', ''), ...selected.map((c) => new Option(c, c)));
    this.playClubSelect.disabled = selected.length === 0;
    this.playClubSelect.value = selected.includes(this.playClub) ? this.playClub : '';
    this.fillPlayShots();
  }

  private fillPlayShots(): void {
    this.playClub = this.playClubSelect.value;
    const shots = this.playClub ? this.keptShotsOf(this.playClub) : [];
    const distance = unitFor('distance', this.system);
    this.playShotSelect.replaceChildren(
      new Option(shots.length ? 'Typical (median of kept shots)' : 'Choose a club first', '-1'),
      ...shots.map((s, i) => new Option(`${s.date.slice(0, 10)} · ${s.carry !== undefined ? distance.fromSI(s.carry).toFixed(0) : '?'} ${distance.label}${s.classification ? ` · ${s.classification}` : ''}`, String(i))),
    );
    this.playShotSelect.disabled = shots.length === 0;
    this.playShotSelect.value = String(Math.min(this.playIndex, shots.length - 1));
  }

  private play(): void {
    const shots = this.keptShotsOf(this.playClub);
    if (!this.playClub || shots.length === 0) return;
    this.onPlay(this.playIndex < 0 ? typicalShot(shots) : shots[this.playIndex], this.playIndex < 0);
  }

  private playShot(shot: ShotRecord): void {
    if (!this.clubs.has(shot.club)) {
      this.clubs.add(shot.club);
      this.recompute();
    }
    this.playClubSelect.value = shot.club;
    this.fillPlayShots();
    this.playIndex = this.keptShotsOf(shot.club).indexOf(shot);
    this.playShotSelect.value = String(this.playIndex);
    this.onPlay(shot, false);
  }

  private renderTable(): void {
    const lib = this.library;
    const distance = unitFor('distance', this.system);
    const speed = unitFor('speed', this.system);
    const shots = lib ? lib.shots.filter((s) => this.clubs.has(s.club)) : [];
    const value: Record<SortKey, (s: ShotRecord) => number | string> = {
      club: (s) => s.club, date: (s) => s.date, ballSpeed: (s) => s.ballSpeed, launchAngle: (s) => s.launchAngle,
      spinRate: (s) => s.spinRate, carry: (s) => s.carry ?? -1, offline: (s) => s.carryLateral ?? 0,
    };
    const { key, descending } = this.sort;
    shots.sort((a, b) => {
      const x = value[key](a);
      const y = value[key](b);
      return (x < y ? -1 : x > y ? 1 : 0) * (descending ? -1 : 1);
    });

    const columns: [SortKey | null, string][] = [
      [null, 'Keep'], ['club', 'Club'], ['date', 'Date'], ['ballSpeed', `Ball ${speed.label}`], ['launchAngle', 'Launch'],
      ['spinRate', 'Spin rpm'], ['carry', `Carry ${distance.label}`], ['offline', `Side ${distance.label}`], [null, 'Why flagged'], [null, ''],
    ];
    const head = el('tr');
    for (const [sortKey, label] of columns) {
      const th = el('th', { scope: 'col' });
      if (sortKey) {
        const button = el('button', { type: 'button', textContent: `${label}${key === sortKey ? (descending ? ' ▾' : ' ▴') : ''}` });
        button.addEventListener('click', () => {
          this.sort = { key: sortKey, descending: key === sortKey ? !descending : false };
          this.renderTable();
        });
        th.append(button);
      } else th.textContent = label;
      head.append(th);
    }

    const body = el('tbody');
    for (const shot of shots) {
      const verdict = this.verdicts.get(shot);
      const keep = el('input', { type: 'checkbox', checked: this.kept(shot) });
      keep.setAttribute('aria-label', `Keep the ${shot.club} shot from ${shot.date}`);
      keep.addEventListener('change', () => {
        this.choices.set(keyOf(shot), keep.checked ? 'keep' : 'drop');
        this.saveChoices();
        this.recompute();
      });
      const play = el('button', { type: 'button', className: 'row-play', textContent: 'Play' });
      play.addEventListener('click', () => {
        this.dialog.close();
        this.playShot(shot);
      });
      const manual = this.choices.has(keyOf(shot));
      const row = el(
        'tr',
        { className: this.kept(shot) ? '' : 'dropped' },
        el('td', {}, keep),
        el('td', { textContent: shot.club }),
        el('td', { textContent: shot.date.slice(0, 16) }),
        el('td', { textContent: speed.fromSI(shot.ballSpeed).toFixed(1) }),
        el('td', { textContent: toDegrees(shot.launchAngle).toFixed(1) }),
        el('td', { textContent: toRpm(shot.spinRate).toFixed(0) }),
        el('td', { textContent: shot.carry !== undefined ? distance.fromSI(shot.carry).toFixed(1) : '' }),
        el('td', { textContent: shot.carryLateral !== undefined ? distance.fromSI(shot.carryLateral).toFixed(1) : '' }),
        el('td', { className: 'why', textContent: [manual ? 'your choice' : '', ...(verdict?.reasons ?? []), shot.spinMeasured ? '' : 'spin estimated'].filter(Boolean).join(', ') }),
        el('td', {}, play),
      );
      body.append(row);
    }

    const close = el('button', { type: 'button', className: 'wide-button', textContent: 'Done' });
    close.addEventListener('click', () => this.dialog.close());
    const reset = el('button', { type: 'button', className: 'wide-button', textContent: 'Clear my keep and drop choices' });
    reset.addEventListener('click', () => {
      this.choices.clear();
      this.saveChoices();
      this.recompute();
    });
    this.dialog.replaceChildren(
      el('div', { className: 'dialog-head' },
        el('h2', { textContent: 'Your shots' }),
        el('p', { textContent: `${shots.filter((s) => this.kept(s)).length} of ${shots.length} kept. Untick a shot to drop it, tick a flagged one to keep it. Sort by any column.` }),
      ),
      el('div', { className: 'dialog-scroll' }, el('table', { className: 'shot-table' }, el('thead', {}, head), body)),
      el('div', { className: 'dialog-actions' }, reset, close),
    );
  }

  private saveChoices(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.choices.entries()]));
    } catch {
      // Storage unavailable: choices last for this visit only.
    }
  }
}
