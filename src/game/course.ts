import { makeHole, type HoleLayout, type Point } from '../physics/hole.ts';

export interface CourseHole {
  readonly number: number;
  readonly par: number;
  /** Tee to green centre, m. */
  readonly length: number;
  readonly layout: HoleLayout;
  /** Where the hole is played from. */
  readonly tee: Point;
}

export interface Course {
  readonly name: string;
  readonly note: string;
  readonly holes: readonly CourseHole[];
}

// Pars and lengths from the club scorecard as published online; still to be checked against the card itself.
const CARD: readonly (readonly [number, number])[] = [
  [4, 379], [4, 290], [3, 164], [5, 481], [4, 361], [4, 423], [4, 358], [3, 164], [5, 553],
  [4, 371], [4, 417], [4, 390], [4, 362], [3, 170], [5, 533], [4, 413], [3, 187], [5, 512],
];

// Pin placements vary from hole to hole so the approach is not always dead centre.
const PIN_OFFSETS = [-3, 4, -2, 5, 2, -5, 3, -4, 1, 4, -3, 2, -2, 5, -4, 3, -1, 2];

/**
 * Sun City Country Club, Yanchep. Until the LiDAR and outline data arrive (milestone M1) each hole is laid out
 * straight, at its scorecard length and par, with a fairway that narrows on the longer holes.
 */
export const SUN_CITY: Course = {
  name: 'Sun City',
  note: 'Straight stand-in holes at scorecard lengths. Real shapes and slopes come with the course data.',
  holes: CARD.map(([par, length], i) => {
    const layout = makeHole(length - 2, PIN_OFFSETS[i], par === 3 ? 18 : par === 5 ? 20 : 22);
    // Par 3s have no fairway to speak of: just a short apron in front of the green.
    const fairway =
      par === 3 ? { ...layout.fairway, from: { x: length - 50, z: 0 } } : { ...layout.fairway, from: { x: 30, z: 0 } };
    return { number: i + 1, par, length, layout: { ...layout, fairway }, tee: { x: 0, z: 0 } };
  }),
};
