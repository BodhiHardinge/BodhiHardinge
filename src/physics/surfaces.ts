export interface Surface {
  readonly name: string;
  /** Scales the turf restitution curve: above 1 is firmer and bouncier. */
  readonly firmness: number;
  /** Ball-on-turf sliding friction coefficient. */
  readonly friction: number;
  /** Rolling deceleration, m/s². A green at Stimpmeter 11 is about 0.5. */
  readonly rollingResistance: number;
  /** How deep a pitch mark the ball makes, 0 (hard) to 1 (soft green), which tilts the bounce back. */
  readonly softness: number;
  /** A ball that lands here is lost to a hazard (water) rather than played. */
  readonly hazard?: 'water';
  /**
   * Sliding speed (m/s) at which the turf's grip halves. Grass grips a slowly skidding ball well but a ball
   * skidding very fast (a high-spin wedge) tears and flattens the blades, so it grips less. Unset: constant grip.
   */
  readonly slipSoftening?: number;
  /**
   * Share of the ball's spin left when it settles into the turf to skid and roll (0 to 1). The ball sinks a little
   * into grass, which soaks up spin; this is what stops very high-spin wedges spinning back unrealistically far.
   */
  readonly spinRetention?: number;
}

// Tuned so a Tour drive rolls about 22 yd on fairway and 40 yd when firm, and a Tour 7-iron stops on a green.
// Sand barely bounces and stops a ball within a metre or two; thick rough and native areas swallow it.
export const SURFACES = {
  fairway: { name: 'Fairway', firmness: 1, friction: 0.45, rollingResistance: 4, softness: 1 },
  firmFairway: { name: 'Firm fairway', firmness: 1.3, friction: 0.4, rollingResistance: 3, softness: 0.5 },
  // Greens: Stimpmeter about 11 ft (a ball rolling at 1.83 m/s goes 3.35 m). Bounce, grip and spin retention are
  // tuned so a Tour 7-iron stops, a Tour wedge checks back a few yards and a driver still runs out (tools notes).
  green: { name: 'Green', firmness: 0.85, friction: 0.7, rollingResistance: 0.5, softness: 1.2, slipSoftening: 6, spinRetention: 0.55 },
  fringe: { name: 'Fringe', firmness: 0.9, friction: 0.7, rollingResistance: 1.6, softness: 1.1, slipSoftening: 6, spinRetention: 0.55 },
  tee: { name: 'Tee', firmness: 1, friction: 0.45, rollingResistance: 4, softness: 1 },
  rough: { name: 'Rough', firmness: 0.3, friction: 1, rollingResistance: 10, softness: 1 },
  thickRough: { name: 'Thick rough', firmness: 0.15, friction: 1.4, rollingResistance: 22, softness: 1 },
  sand: { name: 'Sand', firmness: 0.08, friction: 1.6, rollingResistance: 30, softness: 1.4 },
  native: { name: 'Native area', firmness: 0.2, friction: 1.4, rollingResistance: 25, softness: 1 },
  water: { name: 'Water', firmness: 0, friction: 2, rollingResistance: 100, softness: 1, hazard: 'water' },
} as const satisfies Record<string, Surface>;

export type SurfaceKey = keyof typeof SURFACES;

/** Course rasters store one code per square metre, in this order (see tools/build_course.py). */
export const SURFACE_CODES: readonly Surface[] = [
  SURFACES.native, SURFACES.thickRough, SURFACES.rough, SURFACES.fairway, SURFACES.fringe,
  SURFACES.green, SURFACES.tee, SURFACES.sand, SURFACES.water,
];
