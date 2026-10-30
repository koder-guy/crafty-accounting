import { MAX_PHOTO_BYTES, photoEncodeAttempts } from '@crafty/shared';

// Waits for the load event, not image.decode(), which can stall until a hidden page is shown again.
async function loadImage(file: File): Promise<HTMLImageElement> {
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The photo could not be encoded'))), 'image/jpeg', quality);
  });
}

/**
 * A photo as a JPEG of at most MAX_PHOTO_BYTES, ready to upload. A JPEG already that small is left
 * alone, and so is anything this browser can't read (Chrome and Firefox can't read HEIC).
 */
export async function compressPhoto(file: File): Promise<File> {
  if (file.type === 'image/jpeg' && file.size <= MAX_PHOTO_BYTES) return file;
  try {
    const image = await loadImage(file);
    const { naturalWidth: width, naturalHeight: height } = image;
    const canvas = document.createElement('canvas');
    let blob: Blob | undefined;
    let drawnScale = 0;
    for (const { scale, quality } of photoEncodeAttempts(Math.max(width, height))) {
      if (scale !== drawnScale) {
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const context = canvas.getContext('2d')!;
        // JPEG has no transparency: without this, a transparent PNG's background turns black.
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        drawnScale = scale;
      }
      blob = await encodeJpeg(canvas, quality);
      if (blob.size <= MAX_PHOTO_BYTES) break;
    }
    return new File([blob!], 'photo.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
