// Turns a chosen logo (an image or a PDF) into a small PNG or JPEG before it's uploaded:
// the first page of a PDF and any SVG are drawn as pictures, the plain border is trimmed,
// it's scaled down to MAX_LOGO_DIMENSION, and made smaller still if it's over TARGET_LOGO_BYTES.
import { MAX_LOGO_BYTES, MAX_LOGO_DIMENSION, TARGET_LOGO_BYTES } from '@crafty/shared';

export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.svg,.pdf';

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

export class LogoError extends Error {}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new LogoError('This browser can’t read that image. Try a PNG, JPEG or PDF.'));
    };
    image.src = url;
  });
}

/** Draws the first page of a PDF on a transparent canvas, about twice the size it will be kept at. */
async function drawPdf(file: File): Promise<HTMLCanvasElement> {
  // Loaded only when a PDF is chosen, so the rest of the app doesn't carry it.
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let pdf;
  try {
    pdf = await task.promise;
  } catch {
    await task.destroy();
    throw new LogoError('That PDF couldn’t be read. Try saving the logo as a PNG instead.');
  }
  try {
    const page = await pdf.getPage(1);
    const size = page.getViewport({ scale: 1 });
    const scale = Math.min(8, (MAX_LOGO_DIMENSION * 2) / Math.max(size.width, size.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    // pdf.js makes an opaque context of its own, so pass one that keeps the logo's transparency. The print
    // intent draws in one go rather than frame by frame, so it finishes even if the tab is in the background.
    const canvasContext = canvas.getContext('2d')!;
    await page.render({ canvas, canvasContext, viewport, background: 'rgba(0,0,0,0)', intent: 'print' }).promise;
    return canvas;
  } finally {
    await task.destroy();
  }
}

async function drawImage(file: File): Promise<HTMLCanvasElement> {
  const image = await loadImage(file);
  let { naturalWidth: width, naturalHeight: height } = image;
  // An SVG without a size of its own draws at whatever size it's asked for.
  if (!width || !height) [width, height] = [MAX_LOGO_DIMENSION, MAX_LOGO_DIMENSION];
  const scale = /svg/.test(file.type) || /\.svg$/i.test(file.name) ? (MAX_LOGO_DIMENSION * 2) / Math.max(width, height) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The part of the canvas inside its plain border: the colour (or transparency) of the top-left corner. */
function contentBox(canvas: HTMLCanvasElement) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d')!.getImageData(0, 0, width, height);
  const [r0, g0, b0, a0] = data;
  const plain = (i: number) =>
    a0 < 16
      ? data[i + 3] < 16
      : Math.abs(data[i] - r0) < 16 && Math.abs(data[i + 1] - g0) < 16 && Math.abs(data[i + 2] - b0) < 16 && Math.abs(data[i + 3] - a0) < 16;
  let [left, top, right, bottom] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (plain((y * width + x) * 4)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) throw new LogoError('That logo looks blank.');
  // Keep a little room around it.
  const pad = Math.round(Math.max(right - left, bottom - top) * 0.02);
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  return { left, top, width: Math.min(width, right + pad + 1) - left, height: Math.min(height, bottom + pad + 1) - top, data };
}

const encode = (canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new LogoError('The logo couldn’t be saved.'))), type, quality));

function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

/** The logo as a small PNG (when it has transparency) or whichever of PNG and JPEG is smaller. */
export async function prepareLogo(file: File): Promise<File> {
  if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
    throw new LogoError('HEIC photos can’t be used as a logo here. Save it as a PNG or JPEG first.');
  }
  const source = isPdf(file) ? await drawPdf(file) : await drawImage(file);
  const box = contentBox(source);
  let longest = Math.min(MAX_LOGO_DIMENSION, Math.max(box.width, box.height));

  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = longest / Math.max(box.width, box.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(box.width * scale));
    canvas.height = Math.max(1, Math.round(box.height * scale));
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, box.left, box.top, box.width, box.height, 0, 0, canvas.width, canvas.height);

    let blob = await encode(canvas, 'image/png');
    if (!hasTransparency(canvas)) {
      // JPEG has no transparency, so only for logos without it, on white.
      const flat = document.createElement('canvas');
      [flat.width, flat.height] = [canvas.width, canvas.height];
      const flatContext = flat.getContext('2d')!;
      flatContext.fillStyle = '#fff';
      flatContext.fillRect(0, 0, flat.width, flat.height);
      flatContext.drawImage(canvas, 0, 0);
      const jpeg = await encode(flat, 'image/jpeg', 0.9);
      if (jpeg.size < blob.size) blob = jpeg;
    }
    if (blob.size <= TARGET_LOGO_BYTES || (attempt === 5 && blob.size <= MAX_LOGO_BYTES)) {
      const ext = blob.type === 'image/png' ? 'png' : 'jpg';
      return new File([blob], `logo.${ext}`, { type: blob.type });
    }
    longest = Math.round(longest * 0.75);
  }
  throw new LogoError('That logo is too detailed to make small enough. Try a simpler version of it.');
}
