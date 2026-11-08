// The sample business's logo: a string of beads on a violet disc, drawn as a PNG
// here rather than shipped as a file, so it's there however the app is installed.
import zlib from 'node:zlib';

const SIZE = 256;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** How much of the pixel at (x, y) a circle covers, smoothed over its edge. */
const coverage = (x: number, y: number, cx: number, cy: number, r: number) =>
  Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));

export function sampleLogoPng(): Buffer {
  const centre = SIZE / 2;
  const beads = Array.from({ length: 9 }, (_, i) => {
    // An arc of beads hanging like a necklace, largest in the middle.
    const angle = Math.PI * (0.15 + (0.7 * i) / 8);
    const r = 13 + 9 * Math.sin((Math.PI * i) / 8);
    return { x: centre + 78 * Math.cos(angle), y: centre - 10 + 62 * Math.sin(angle), r };
  });
  const rows: Buffer[] = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 4);
    for (let x = 0; x < SIZE; x++) {
      const disc = coverage(x, y, centre, centre, centre - 4);
      // Violet at the top left to indigo at the bottom right.
      const t = (x + y) / (2 * SIZE);
      let [r, g, b] = [139 + (79 - 139) * t, 92 + (70 - 92) * t, 246 + (229 - 246) * t];
      // The cord the beads hang from.
      const cord = Math.max(0, 1 - Math.abs(Math.hypot(x + 0.5 - centre, (y + 0.5 - centre + 10) * (78 / 62)) - 78) / 1.6);
      const onCord = y > centre - 10 ? cord * 0.7 : 0;
      const bead = Math.max(0, ...beads.map((p) => coverage(x, y, p.x, p.y, p.r)));
      const white = Math.max(onCord, bead);
      [r, g, b] = [r + (255 - r) * white, g + (255 - g) * white, b + (255 - b) * white];
      row.set([Math.round(r), Math.round(g), Math.round(b), Math.round(255 * disc)], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
