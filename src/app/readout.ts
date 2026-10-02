import type { ReferenceShot } from '../analysis/reference-data.ts';
import type { FlightResult } from '../physics/flight.ts';
import { yards } from '../physics/units.ts';
import { DEGREES, RPM, unitFor, type UnitSystem } from './units.ts';

const READINGS = ['Carry', 'Offline', 'Apex', 'Land angle', 'Hang time', 'Land speed', 'Land spin'] as const;
type Reading = (typeof READINGS)[number];

interface Cell {
  readonly value: HTMLElement;
  readonly unit: HTMLElement;
  readonly reference: HTMLElement;
}

interface Shown {
  readonly value: string;
  readonly unit: string;
  readonly reference?: string;
}

export class Readout {
  private readonly cells = new Map<Reading, Cell>();

  constructor(container: HTMLElement) {
    for (const name of READINGS) {
      const cell = document.createElement('div');
      cell.className = 'reading';
      const label = document.createElement('span');
      label.className = 'reading-label';
      label.textContent = name;
      const value = document.createElement('span');
      value.className = 'reading-value';
      const unit = document.createElement('span');
      unit.className = 'reading-unit';
      const reference = document.createElement('span');
      reference.className = 'reading-ref';
      cell.append(label, value, unit, reference);
      container.append(cell);
      this.cells.set(name, { value, unit, reference });
    }
  }

  /** Shows a flight; with a reference shot, also shows the Tour average to compare against. */
  show(result: FlightResult, system: UnitSystem, reference: ReferenceShot | null): void {
    const distance = unitFor('distance', system);
    const height = unitFor('height', system);
    const speed = unitFor('speed', system);
    const side = result.offline > 0.05 ? 'R' : result.offline < -0.05 ? 'L' : '';
    const tour = (value: number, digits: number) => `Tour ${value.toFixed(digits)}`;

    const shown: Record<Reading, Shown> = {
      Carry: {
        value: distance.fromSI(result.carry).toFixed(1),
        unit: distance.label,
        reference: reference ? tour(distance.fromSI(yards(reference.carryYards)), 0) : undefined,
      },
      Offline: { value: Math.abs(distance.fromSI(result.offline)).toFixed(1), unit: `${distance.label} ${side}`.trim() },
      Apex: {
        value: height.fromSI(result.apexPosition.y).toFixed(1),
        unit: height.label,
        reference: reference ? tour(height.fromSI(yards(reference.apexYards)), 0) : undefined,
      },
      'Land angle': {
        value: DEGREES.fromSI(result.landingAngle).toFixed(1),
        unit: 'deg',
        reference: reference ? tour(reference.landingAngleDeg, 0) : undefined,
      },
      'Hang time': { value: result.flightTime.toFixed(2), unit: 's' },
      'Land speed': { value: speed.fromSI(result.landingSpeed).toFixed(1), unit: speed.label },
      'Land spin': { value: RPM.fromSI(result.landingSpinRate).toFixed(0), unit: 'rpm' },
    };

    for (const name of READINGS) {
      const cell = this.cells.get(name)!;
      const s = shown[name];
      cell.value.textContent = s.value;
      cell.unit.textContent = s.unit;
      cell.reference.textContent = s.reference ?? '';
    }
  }
}
