import { GridTerrain } from '../../physics/terrain.ts';
import type { CourseFile } from '../../game/course-file.ts';
import torreyFile from '../../courses/torrey-south/course.json';
import torreyHeights from '../../courses/torrey-south/heights.png?url';
import torreySurfaces from '../../courses/torrey-south/surfaces.png?url';
import sunCityFile from '../../courses/sun-city/course.json';
import sunCityHeights from '../../courses/sun-city/heights.png?url';
import sunCitySurfaces from '../../courses/sun-city/surfaces.png?url';

export interface CourseEntry {
  readonly id: string;
  readonly file: CourseFile;
  readonly heights: string;
  readonly surfaces: string;
  /** How far to trust it, shown to the player. */
  readonly quality: string;
}

export const COURSES: readonly CourseEntry[] = [
  { id: 'torrey-south', file: torreyFile as unknown as CourseFile, heights: torreyHeights, surfaces: torreySurfaces,
    quality: 'Lidar terrain: real green contours' },
  { id: 'sun-city', file: sunCityFile as unknown as CourseFile, heights: sunCityHeights, surfaces: sunCitySurfaces,
    quality: 'Preview: real hole shapes, coarse terrain, some holes guessed' },
];

export interface LoadedCourse {
  readonly entry: CourseEntry;
  readonly terrain: GridTerrain;
  readonly heights: Float32Array;
  readonly codes: Uint8Array;
  readonly width: number;
  readonly depth: number;
}

async function pixels(url: string): Promise<ImageData> {
  const blob = await (await fetch(url)).blob();
  // No colour management or premultiplying: the pixels are data, not a picture.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** Decodes a course's height (Terrarium RGB) and surface rasters into a terrain. */
export async function loadCourse(entry: CourseEntry): Promise<LoadedCourse> {
  const [h, s] = await Promise.all([pixels(entry.heights), pixels(entry.surfaces)]);
  const width = h.width;
  const depth = h.height;
  const heights = new Float32Array(width * depth);
  const codes = new Uint8Array(width * depth);
  for (let i = 0; i < width * depth; i++) {
    heights[i] = h.data[4 * i] * 256 + h.data[4 * i + 1] + h.data[4 * i + 2] / 256 - 32768;
    codes[i] = s.data[4 * i];
  }
  return { entry, terrain: new GridTerrain(width, depth, heights, codes), heights, codes, width, depth };
}
