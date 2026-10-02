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
}

// Tuned so a Tour drive rolls about 22 yd on fairway and 40 yd when firm, and a Tour 7-iron stops on a green.
export const SURFACES = {
  fairway: { name: 'Fairway', firmness: 1, friction: 0.45, rollingResistance: 4, softness: 1 },
  firmFairway: { name: 'Firm fairway', firmness: 1.3, friction: 0.4, rollingResistance: 3, softness: 0.5 },
  green: { name: 'Green', firmness: 1, friction: 0.4, rollingResistance: 0.5, softness: 1 },
  rough: { name: 'Rough', firmness: 0.3, friction: 1, rollingResistance: 10, softness: 1 },
} as const satisfies Record<string, Surface>;

export type SurfaceKey = keyof typeof SURFACES;
