import { spinFromComponents } from '../physics/launch.ts';
import * as u from '../physics/units.ts';

/** One measured shot from a launch monitor export, in SI units (angles in rad, spin in rad/s). */
export interface ShotRecord {
  readonly date: string;
  readonly club: string;
  readonly ballSpeed: number;
  readonly launchAngle: number;
  readonly launchDirection: number;
  readonly spinRate: number;
  readonly spinAxis: number;
  /** False when the monitor estimated spin instead of measuring it. */
  readonly spinMeasured: boolean;
  readonly clubSpeed?: number;
  readonly attackAngle?: number;
  readonly dynamicLoft?: number;
  readonly clubPath?: number;
  readonly faceAngle?: number;
  readonly faceToPath?: number;
  readonly carry?: number;
  readonly total?: number;
  readonly apex?: number;
  readonly descentAngle?: number;
  readonly carryLateral?: number;
  readonly totalLateral?: number;
  readonly classification?: string;
}

export interface ImportResult {
  readonly shots: ShotRecord[];
  /** Rows without enough launch data to simulate. */
  readonly skipped: number;
}

/** Splits CSV text into rows, honouring quoted fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const UNITS: Record<string, (v: number) => number> = {
  mph: u.mph,
  'km/h': u.kmh,
  kmh: u.kmh,
  'm/s': (v) => v,
  m: (v) => v,
  yds: u.yards,
  yd: u.yards,
  ft: u.feet,
  cm: (v) => v / 100,
  deg: u.degrees,
  rpm: u.rpm,
};

// Column names used by Awesome Golf and the Garmin Golf app for the same measurement.
const ALIASES = {
  date: ['Date'],
  club: ['Club Type', 'Club Name', 'Club'],
  ballSpeed: ['Ball Speed'],
  launchAngle: ['Vertical Launch', 'Launch Angle'],
  launchDirection: ['Horizontal Launch', 'Launch Direction'],
  spinRate: ['Spin Rate', 'Total Spin'],
  spinAxis: ['Spin Axis'],
  backspin: ['Backspin', 'Back Spin'],
  sidespin: ['Sidespin', 'Side Spin'],
  spinReading: ['Spin Reading', 'Spin Rate Type'],
  clubSpeed: ['Club Speed'],
  attackAngle: ['Attack Angle'],
  dynamicLoft: ['Dynamic Loft'],
  clubPath: ['Club Path'],
  faceAngle: ['Face Target', 'Club Face', 'Face Angle'],
  faceToPath: ['Face Path', 'Face to Path'],
  carry: ['Carry Distance', 'Carry'],
  total: ['Total Distance', 'Total'],
  apex: ['Peak Height', 'Apex Height', 'Max Height'],
  descentAngle: ['Descent Angle', 'Land Angle'],
  carryLateral: ['Carry Lateral Distance', 'Carry Deviation Distance'],
  totalLateral: ['Total Lateral Distance', 'Total Deviation Distance'],
  classification: ['Shot Classification'],
} as const;

type Field = keyof typeof ALIASES;

// Units assumed when an export has no units row.
const DEFAULT_UNITS: Partial<Record<Field, string>> = {
  ballSpeed: 'mph', clubSpeed: 'mph', carry: 'yds', total: 'yds', apex: 'ft', carryLateral: 'yds', totalLateral: 'yds',
  launchAngle: 'deg', launchDirection: 'deg', spinAxis: 'deg', attackAngle: 'deg', dynamicLoft: 'deg', clubPath: 'deg',
  faceAngle: 'deg', faceToPath: 'deg', descentAngle: 'deg', spinRate: 'rpm', backspin: 'rpm', sidespin: 'rpm',
};

/** Reads a launch monitor CSV export (Awesome Golf or Garmin Golf) into shot records. */
export function importShots(text: string): ImportResult {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length === 0) return { shots: [], skipped: 0 };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasUnitsRow = rows.length > 1 && rows[1].some((c) => /^\[.*\]$/.test(c.trim()));
  const unitsRow = hasUnitsRow ? rows[1].map((c) => c.trim().replace(/^\[|\]$/g, '').toLowerCase()) : [];

  const column = {} as Record<Field, number>;
  for (const field of Object.keys(ALIASES) as Field[]) {
    column[field] = header.findIndex((h) => ALIASES[field].some((name) => name.toLowerCase() === h));
  }

  const convert = (field: Field, raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) return undefined;
    const unit = (hasUnitsRow ? unitsRow[column[field]] : '') || DEFAULT_UNITS[field] || '';
    const fn = UNITS[unit];
    return fn ? fn(value) : value;
  };

  const shots: ShotRecord[] = [];
  let skipped = 0;
  for (const row of rows.slice(hasUnitsRow ? 2 : 1)) {
    const get = (field: Field) => (column[field] >= 0 ? convert(field, row[column[field]]) : undefined);
    const text = (field: Field) => (column[field] >= 0 ? (row[column[field]] ?? '').trim() : '');

    let spinRate = get('spinRate');
    let spinAxis = get('spinAxis');
    const back = get('backspin');
    const side = get('sidespin');
    if (spinRate === undefined && back !== undefined) {
      const spin = spinFromComponents(back, side ?? 0);
      spinRate = spin.spinRate;
      spinAxis ??= spin.spinAxis;
    }
    const ballSpeed = get('ballSpeed');
    const launchAngle = get('launchAngle');
    if (!ballSpeed || ballSpeed <= 0 || launchAngle === undefined || spinRate === undefined || spinRate < 0) {
      skipped++;
      continue;
    }

    const reading = text('spinReading').toLowerCase();
    shots.push(definedOnly({
      date: text('date'),
      club: text('club') || 'Unknown',
      ballSpeed,
      launchAngle,
      launchDirection: get('launchDirection') ?? 0,
      spinRate,
      spinAxis: spinAxis ?? 0,
      spinMeasured: !reading.startsWith('estimat'),
      clubSpeed: get('clubSpeed'),
      attackAngle: get('attackAngle'),
      dynamicLoft: get('dynamicLoft'),
      clubPath: get('clubPath'),
      faceAngle: get('faceAngle'),
      faceToPath: get('faceToPath'),
      carry: get('carry'),
      total: get('total'),
      apex: get('apex'),
      descentAngle: get('descentAngle'),
      carryLateral: get('carryLateral'),
      totalLateral: get('totalLateral'),
      classification: text('classification') || undefined,
    }));
  }
  return { shots, skipped };
}

function definedOnly<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as T;
}

const CLUB_ORDER = [
  'driver', '2 wood', '3 wood', '4 wood', '5 wood', '7 wood', '9 wood', '2 hybrid', '3 hybrid', '4 hybrid', '5 hybrid',
  '6 hybrid', '1 iron', '2 iron', '3 iron', '4 iron', '5 iron', '6 iron', '7 iron', '8 iron', '9 iron', 'pitching wedge',
  'gap wedge', 'approach wedge', 'sand wedge', 'lob wedge',
];

/** Sorts club names from longest (driver) to shortest (lob wedge); unknown names go last. */
export function compareClubs(a: string, b: string): number {
  const rank = (club: string) => {
    const i = CLUB_ORDER.indexOf(club.toLowerCase());
    return i === -1 ? CLUB_ORDER.length : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}
