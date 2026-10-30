// Names for photos taken with a camera. Documents are stored under their filename, which must
// be unique, and a camera gives no useful one (an iPhone calls every photo image.jpg).

const PHOTO_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

/** The most a photo taken with a camera may take up once it's been made into a JPEG. */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

const PHOTO_LONGEST_SIDES = [3000, 2250, 1700, 1300, 1000];
const PHOTO_QUALITIES = [0.85, 0.7, 0.55];

/** What to try in turn to fit a photo into MAX_PHOTO_BYTES: lower quality first, then a smaller image. */
export function photoEncodeAttempts(longestSide: number): { scale: number; quality: number }[] {
  const scales = [...new Set(PHOTO_LONGEST_SIDES.map((side) => Math.min(1, side / longestSide)))];
  return scales.flatMap((scale) => PHOTO_QUALITIES.map((quality) => ({ scale, quality })));
}

/** Such as "Photo 2026-10-30 14-05-12 a3f9.jpg", in local time; the random part keeps a burst of photos apart. */
export function photoFilename(file: { type: string; name?: string }, now = new Date()): string {
  const extension = PHOTO_EXTENSIONS[file.type] ?? /\.[^.]+$/.exec(file.name ?? '')?.[0].toLowerCase() ?? '.jpg';
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
  const random = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `Photo ${date} ${time} ${random}${extension}`;
}
