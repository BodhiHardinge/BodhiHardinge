import type { Shot } from '../physics/ground.ts';
import type { HoleLayout } from '../physics/hole.ts';
import { DEGREES, RPM, unitFor, type UnitSystem } from './units.ts';

export const COLUMNS = ['Carry', 'Roll', 'Total', 'Offline', 'To pin', 'Apex', 'Land angle', 'Hang time', 'Land spin'] as const;
export type Column = (typeof COLUMNS)[number];

/** Measured or published values in SI (m, rad, s), any of which may be missing. */
export type KnownValues = Partial<Record<'carry' | 'total' | 'offline' | 'apex' | 'landAngle', number>>;

export type BoardRow =
  | { readonly label: string; readonly tone: 'shot' | 'tour' | 'ghost'; readonly shot: Shot }
  | { readonly label: string; readonly tone: 'reference'; readonly values: KnownValues };

const side = (metres: number) => (metres > 0.05 ? ' R' : metres < -0.05 ? ' L' : '');

/** Results shown like a golf leaderboard, one row per player: your shot, standard conditions, a reference. */
export class Leaderboard {
  private readonly table: HTMLTableElement;
  private readonly units = new Map<Column, HTMLElement>();

  constructor(table: HTMLTableElement) {
    this.table = table;
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
    table.createTBody();
  }

  show(rows: readonly BoardRow[], system: UnitSystem, hole: HoleLayout | null): void {
    const distance = unitFor('distance', system);
    const height = unitFor('height', system);
    const units: Record<Column, string> = {
      Carry: distance.label, Roll: distance.label, Total: distance.label, Offline: distance.label,
      'To pin': system === 'imperial' ? 'ft' : 'm', Apex: height.label, 'Land angle': 'deg', 'Hang time': 's', 'Land spin': 'rpm',
    };
    for (const name of COLUMNS) this.units.get(name)!.textContent = units[name];

    const d = (m: number) => distance.fromSI(m).toFixed(1);
    const body = this.table.tBodies[0];
    body.replaceChildren();
    for (const row of rows) {
      const tr = body.insertRow();
      tr.className = `row-${row.tone}`;
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = row.label;
      tr.append(th);
      const values: Partial<Record<Column, string>> = {};
      if (row.tone === 'reference') {
        const v = row.values;
        if (v.carry !== undefined) values.Carry = d(v.carry);
        if (v.total !== undefined) values.Total = d(v.total);
        if (v.carry !== undefined && v.total !== undefined) values.Roll = signed(distance.fromSI(v.total - v.carry));
        if (v.offline !== undefined) values.Offline = `${Math.abs(distance.fromSI(v.offline)).toFixed(1)}${side(v.offline)}`;
        if (v.apex !== undefined) values.Apex = height.fromSI(v.apex).toFixed(1);
        if (v.landAngle !== undefined) values['Land angle'] = DEGREES.fromSI(v.landAngle).toFixed(1);
      } else {
        const shot = row.shot;
        const flight = shot.flight;
        values.Carry = d(flight.carry);
        values.Roll = signed(distance.fromSI(shot.roll));
        values.Total = d(shot.total);
        values.Offline = `${Math.abs(distance.fromSI(shot.totalOffline)).toFixed(1)}${side(shot.totalOffline)}`;
        if (hole) {
          const gap = Math.hypot(shot.restPosition.x - hole.pin.x, shot.restPosition.z - hole.pin.z);
          values['To pin'] = shot.holed ? 'Holed' : unitFor(system === 'imperial' ? 'height' : 'distance', system).fromSI(gap).toFixed(1);
        }
        values.Apex = height.fromSI(flight.apexPosition.y).toFixed(1);
        values['Land angle'] = DEGREES.fromSI(flight.landingAngle).toFixed(1);
        values['Hang time'] = flight.flightTime.toFixed(2);
        values['Land spin'] = RPM.fromSI(flight.landingSpinRate).toFixed(0);
      }
      for (const name of COLUMNS) tr.insertCell().textContent = values[name] ?? '';
    }
  }
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}
