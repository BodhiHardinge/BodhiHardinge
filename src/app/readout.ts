import type { ReferenceShot } from '../analysis/reference-data.ts';
import type { Shot } from '../physics/ground.ts';
import { yards } from '../physics/units.ts';
import { DEGREES, RPM, unitFor, type UnitSystem } from './units.ts';

const COLUMNS = ['Carry', 'Roll', 'Total', 'Offline', 'Apex', 'Land angle', 'Hang time', 'Land spin'] as const;
type Column = (typeof COLUMNS)[number];

const side = (metres: number) => (metres > 0.05 ? ' R' : metres < -0.05 ? ' L' : '');

/** Results shown like a golf leaderboard: this shot, and the Tour average when a preset is chosen. */
export class Leaderboard {
  private readonly units = new Map<Column, HTMLElement>();
  private readonly shotCells = new Map<Column, HTMLElement>();
  private readonly tourCells = new Map<Column, HTMLElement>();
  private readonly tourRow: HTMLTableRowElement;

  constructor(table: HTMLTableElement) {
    const head = table.createTHead().insertRow();
    head.append(document.createElement('th'));
    for (const name of COLUMNS) {
      const th = document.createElement('th');
      th.scope = 'col';
      const unit = document.createElement('small');
      th.append(name, unit);
      head.append(th);
      this.units.set(name, unit);
    }
    const body = table.createTBody();
    const shotRow = body.insertRow();
    this.tourRow = body.insertRow();
    this.tourRow.className = 'row-tour';
    for (const [row, label, cells] of [
      [shotRow, 'Your shot', this.shotCells],
      [this.tourRow, 'Tour average', this.tourCells],
    ] as const) {
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      row.append(th);
      for (const name of COLUMNS) cells.set(name, row.insertCell());
    }
  }

  show(shot: Shot, system: UnitSystem, reference: ReferenceShot | null): void {
    const distance = unitFor('distance', system);
    const height = unitFor('height', system);
    const flight = shot.flight;
    const d = (m: number) => distance.fromSI(m).toFixed(1);

    const units: Record<Column, string> = {
      Carry: distance.label,
      Roll: distance.label,
      Total: distance.label,
      Offline: distance.label,
      Apex: height.label,
      'Land angle': 'deg',
      'Hang time': 's',
      'Land spin': 'rpm',
    };
    const values: Record<Column, string> = {
      Carry: d(flight.carry),
      Roll: `${shot.roll >= 0 ? '+' : ''}${d(shot.roll)}`,
      Total: d(shot.total),
      Offline: `${Math.abs(distance.fromSI(shot.totalOffline)).toFixed(1)}${side(shot.totalOffline)}`,
      Apex: height.fromSI(flight.apexPosition.y).toFixed(1),
      'Land angle': DEGREES.fromSI(flight.landingAngle).toFixed(1),
      'Hang time': flight.flightTime.toFixed(2),
      'Land spin': RPM.fromSI(flight.landingSpinRate).toFixed(0),
    };
    const tour: Partial<Record<Column, string>> = reference
      ? {
          Carry: distance.fromSI(yards(reference.carryYards)).toFixed(0),
          Apex: height.fromSI(yards(reference.apexYards)).toFixed(0),
          'Land angle': String(reference.landingAngleDeg),
        }
      : {};

    for (const name of COLUMNS) {
      this.units.get(name)!.textContent = units[name];
      this.shotCells.get(name)!.textContent = values[name];
      this.tourCells.get(name)!.textContent = tour[name] ?? '';
    }
    this.tourRow.hidden = reference === null;
  }
}
