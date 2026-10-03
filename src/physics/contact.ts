import type { ClubSpec, Delivery } from './club.ts';
import type { Contact } from './impact.ts';
import { tourDynamicLoft } from './impact.ts';
import { ARM_LENGTH } from './swing.ts';
import { degrees } from './units.ts';

const BALL_RADIUS = 0.04267 / 2;

/** How a ball sits in a lie, and what the club has to get through to reach it. Heights in m above firm ground. */
export interface LieGeometry {
  readonly name: string;
  /** Height of the bottom of the ball above firm ground (soil or sand). Negative: sunk in. */
  readonly sit: number;
  /** Height of the grass the club must pass through before the ball; 0 for none. */
  readonly grass: number;
  /**
   * Share of the club's energy lost per 0.3 m of grass cut through with an iron's sole. Grass drag grows with
   * speed like a fluid's, so it costs a chip the same share as a full swing (a chip from rough is not a duff).
   */
  readonly grassDrag: number;
  /** Spin kept when grass gets between face and ball. */
  readonly grassSpin: number;
  /** Energy to plough through the ground, J/m³. Sand is far softer than turf. */
  readonly groundWork: number;
  readonly ground: 'turf' | 'sand';
}

export const LIE_GEOMETRY: Record<string, LieGeometry> = {
  Tee: { name: 'Tee', sit: 0.006, grass: 0, grassDrag: 0, grassSpin: 1, groundWork: 3e7, ground: 'turf' },
  Fairway: { name: 'Fairway', sit: 0.006, grass: 0, grassDrag: 0, grassSpin: 1, groundWork: 3e7, ground: 'turf' },
  Fringe: { name: 'Fringe', sit: 0.004, grass: 0, grassDrag: 0, grassSpin: 1, groundWork: 3e7, ground: 'turf' },
  Green: { name: 'Green', sit: 0.002, grass: 0, grassDrag: 0, grassSpin: 1, groundWork: 3e7, ground: 'turf' },
  Rough: { name: 'Rough', sit: 0.012, grass: 0.05, grassDrag: 0.08, grassSpin: 0.55, groundWork: 3e7, ground: 'turf' },
  'Thick rough': { name: 'Thick rough', sit: 0.015, grass: 0.1, grassDrag: 0.22, grassSpin: 0.35, groundWork: 3e7, ground: 'turf' },
  'Native area': { name: 'Native area', sit: 0.01, grass: 0.12, grassDrag: 0.3, grassSpin: 0.4, groundWork: 3.5e7, ground: 'turf' },
  Sand: { name: 'Sand', sit: -0.004, grass: 0, grassDrag: 0, grassSpin: 1, groundWork: 2.5e6, ground: 'sand' },
};

export function lieGeometry(surfaceName: string): LieGeometry {
  return LIE_GEOMETRY[surfaceName] ?? LIE_GEOMETRY.Fairway;
}

/** A teed ball: the bottom of the ball this far above the ground, m. Drivers tee high, irons barely. */
export function teeHeight(spec: ClubSpec): number {
  return spec.head === 'driver' ? 0.03 : spec.head === 'wood' ? 0.012 : 0.006;
}

/** Shape of the club near the ground. */
export interface ClubGeometry {
  /** Height of the sweet spot above the leading edge, m. */
  readonly sweetSpot: number;
  /** Width of the sole that ploughs the ground, m (front to back). */
  readonly soleWidth: number;
  /** Sole bounce angle, rad. */
  readonly bounce: number;
  /** Head mass, kg. */
  readonly mass: number;
}

export function clubGeometry(spec: ClubSpec): ClubGeometry {
  const loft = (spec.loft * 180) / Math.PI;
  switch (spec.head) {
    case 'driver':
      return { sweetSpot: 0.03, soleWidth: 0.09, bounce: spec.bounce ?? 0, mass: 0.2 };
    case 'wood':
      return { sweetSpot: loft > 19 ? 0.02 : 0.022, soleWidth: loft > 19 ? 0.045 : 0.06, bounce: spec.bounce ?? degrees(2), mass: 0.215 };
    case 'putter':
      return { sweetSpot: 0.015, soleWidth: 0.03, bounce: 0, mass: 0.35 };
    default: {
      const wedgeBounce = loft >= 54 ? 12 : loft >= 49 ? 8 : loft >= 44 ? 6 : 4;
      return { sweetSpot: 0.018, soleWidth: 0.022 + Math.max(0, loft - 40) * 0.0007, bounce: spec.bounce ?? degrees(wedgeBounce), mass: 0.25 + (loft - 20) * 0.0012 };
    }
  }
}

/** What the player means to do at the bottom of the swing. */
export interface Strike {
  /** Moves the bottom of the arc toward the target (+) or back (-), m. Timing errors land here. */
  readonly lowPointShift: number;
  /** How much lower (+) or higher (-) than a centred strike the club is swung, m. Digging versus picking. */
  readonly depth: number;
  /** Strike point toward the toe (+), m. */
  readonly toe: number;
}

export const CENTRED_STRIKE: Strike = { lowPointShift: 0, depth: 0, toe: 0 };

export type ContactKind = 'Clean' | 'Pure' | 'Heavy' | 'Fat' | 'Duff' | 'Thin' | 'Topped' | 'Splash' | 'Picked clean' | 'Flyer';

export interface ContactReport {
  readonly contact: Contact;
  readonly kind: ContactKind;
  /** Bottom of the club's arc relative to the ball, m (+ ahead). */
  readonly lowPoint: number;
  /** Lowest point of the leading edge relative to firm ground, m (negative = into the ground). */
  readonly lowPointHeight: number;
  /** Leading edge height relative to firm ground as it reaches the ball, m. */
  readonly edgeAtBall: number;
  /** Strike point above the leading edge, m. */
  readonly strikeHeight: number;
  /** Where the club enters and leaves the ground relative to the ball (m, + ahead), and how deep. Null: no divot. */
  readonly divot: { readonly from: number; readonly to: number; readonly depth: number; readonly ground: 'turf' | 'sand' } | null;
  /** Height of the ball's bottom above firm ground, m. */
  readonly ballSit: number;
  /** Vertical radius of the club's arc along the target line, m. */
  readonly arcRadius: number;
}

/**
 * The club meeting the ground and the ball. The leading edge runs on an arc whose bottom sits `lowPoint` ahead of
 * the ball (set by the attack angle). The player swings to strike the ball on the sweet spot; timing and natural
 * error move the arc. Where the edge goes below firm ground it ploughs a divot, and whatever it ploughs before
 * reaching the ball costs club speed. Leading edge too high meets the ball low on the face (thin) or above its
 * equator (topped). In sand, a club entering well behind the ball moves a cushion of sand into it (a splash).
 * Sole bounce, increased by opening the face, keeps the club from digging in soft ground.
 */
export function contactFor(delivery: Delivery, spec: ClubSpec, plane: number, lie: LieGeometry, teed: boolean, strikeIntent: Strike = CENTRED_STRIKE): ContactReport {
  const club = clubGeometry(spec);
  const sit = teed ? teeHeight(spec) : lie.sit;
  const arcRadius = (ARM_LENGTH + spec.length) / Math.sin(plane);
  const plannedLow = -Math.sin(delivery.attackAngle) * arcRadius;
  // The arc the player aims for: leading edge at the height that puts the sweet spot on the ball. On turf a good
  // player never sends the edge into the ground before the ball for it: off a tight lie a lofted club meets the
  // ball first, a little low on the face, then takes its divot. In sand, entering behind the ball is the shot.
  const contactAbove = BALL_RADIUS * (1 - Math.sin(Math.max(0, delivery.dynamicLoft)));
  const sweet = sit + contactAbove - club.sweetSpot;
  const target = lie.ground === 'turf' ? Math.max(0, sweet) : sweet;
  let lowY = target - (plannedLow * plannedLow) / (2 * arcRadius) - strikeIntent.depth;
  const lowPoint = plannedLow + strikeIntent.lowPointShift;

  // Bounce: the sole rides up out of soft ground. Opening the face and adding loft show more bounce; steeper
  // attack digs more.
  const extraLoft = Math.max(0, delivery.dynamicLoft - tourDynamicLoft(spec));
  const openFace = Math.max(0, delivery.faceAngle - delivery.clubPath);
  const bounce = club.bounce + 0.5 * openFace + 0.5 * extraLoft;
  if (lowY < 0) {
    const steep = 1 + Math.max(0, -delivery.attackAngle) / degrees(8);
    const softness = lie.ground === 'sand' ? 6 : 15;
    lowY = lowY / (1 + bounce / degrees(softness) / steep);
  }

  const edge = (x: number) => lowY + ((x - lowPoint) * (x - lowPoint)) / (2 * arcRadius);
  const edgeAtBall = edge(0);

  // Ground ploughed before the ball, m².
  let ploughed = 0;
  let grassPath = 0;
  const dx = 0.002;
  for (let x = -0.6; x < 0; x += dx) {
    const y = edge(x);
    if (y < 0) ploughed += -y * dx;
    if (lie.grass > 0 && y < lie.grass) grassPath += dx;
  }
  const energy = 0.5 * club.mass * delivery.clubSpeed * delivery.clubSpeed;
  // Grass takes a share of the energy (wider soles drag more); ploughing ground takes a fixed amount of work.
  const grassShare = Math.min(0.6, lie.grassDrag * (grassPath / 0.3) * (club.soleWidth / 0.025));
  const work = ploughed * club.soleWidth * lie.groundWork;
  let speedFactor = Math.sqrt(Math.max(0.03, (1 - grassShare) - work / Math.max(energy, 1e-9)));

  const strikeHeight = sit + contactAbove - edgeAtBall;
  let height = strikeHeight - club.sweetSpot;
  let spinFactor = 1;
  let cushion = 0;

  // Leading edge below firm ground at the ball: soil or sand is trapped between face and ball.
  if (edgeAtBall < -0.002) {
    if (lie.ground === 'sand') {
      // Sand between face and ball carries the strike: thicker cushion, softer and slower shot.
      const thickness = -edgeAtBall - 0.002;
      cushion = Math.min(0.95, 0.45 + thickness / 0.03);
      height = 0;
      speedFactor = Math.max(speedFactor, 0.35) * Math.exp(-Math.max(0, thickness - 0.025) / 0.02);
    } else {
      spinFactor *= Math.exp((edgeAtBall + 0.002) / 0.005);
    }
  }
  // Grass trapped between face and ball (rough): less spin, the ball "flies".
  if (lie.grass > sit + contactAbove && !teed) spinFactor *= lie.grassSpin;

  // Leading edge above the ball's equator: topped along the ground.
  const topped = edgeAtBall > sit + BALL_RADIUS;
  if (topped) height = -club.sweetSpot - 0.01;

  const contact: Contact = { toe: strikeIntent.toe, height, speedFactor, spinFactor, cushion };

  let divot: ContactReport['divot'] = null;
  if (lowY < 0) {
    const half = Math.sqrt(-2 * arcRadius * lowY);
    divot = { from: lowPoint - half, to: lowPoint + half, depth: -lowY, ground: lie.ground };
  }

  let kind: ContactKind;
  if (topped) kind = 'Topped';
  else if (cushion > 0) kind = 'Splash';
  else if (speedFactor < 0.6) kind = 'Duff';
  else if (speedFactor < 0.85) kind = 'Fat';
  else if (speedFactor < 0.97) kind = 'Heavy';
  // Thin: met in the bottom few millimetres of the face, near the leading edge, or well below a wood's sweet spot.
  else if (strikeHeight < 0.006 || height < -0.014) kind = 'Thin';
  else if (spinFactor < 0.7) kind = 'Flyer';
  else if (lie.ground === 'sand') kind = 'Picked clean';
  else if (Math.hypot(height, strikeIntent.toe) < 0.004) kind = 'Pure';
  else kind = 'Clean';

  return { contact, kind, lowPoint, lowPointHeight: lowY, edgeAtBall, strikeHeight, divot, ballSit: sit, arcRadius };
}
