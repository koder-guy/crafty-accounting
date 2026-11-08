// Whether a logo needs a white tile behind it on the dark theme. A logo with a transparent background is
// shown as it is, unless what's drawn is mostly dark ink, which would vanish on the dark page.
import { useEffect, useState } from 'react';

export type LogoBackdrop = 'none' | 'white';

const cache = new Map<string, LogoBackdrop>();

async function measure(url: string): Promise<LogoBackdrop> {
  const image = new Image();
  image.src = url;
  await image.decode();
  // A small copy is plenty to judge it by.
  const scale = Math.min(1, 96 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let transparent = 0;
  let drawn = 0;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) transparent++;
    if (data[i + 3] < 128) continue;
    drawn++;
    const luminance = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    if (luminance < 0.2) dark++;
  }
  // Only a background that's really see-through, not a few soft edges on a solid one.
  if (transparent < (data.length / 4) * 0.05) return 'white';
  return drawn > 0 && dark / drawn < 0.5 ? 'none' : 'white';
}

/** 'none' or 'white' once the logo has been looked at; null until then (or with no logo). */
export function useLogoBackdrop(url: string | null | undefined): LogoBackdrop | null {
  const [backdrop, setBackdrop] = useState<LogoBackdrop | null>(() => (url ? (cache.get(url) ?? null) : null));
  useEffect(() => {
    if (!url) return setBackdrop(null);
    const known = cache.get(url);
    if (known) return setBackdrop(known);
    let current = true;
    setBackdrop(null);
    measure(url)
      .catch((): LogoBackdrop => 'white')
      .then((result) => {
        cache.set(url, result);
        if (current) setBackdrop(result);
      });
    return () => {
      current = false;
    };
  }, [url]);
  return backdrop;
}
