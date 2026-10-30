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
