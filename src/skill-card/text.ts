// Text to PNG on a FIXED character grid: every character is stamped from its
// Unifont bitmap, scaled by an integer factor. The canvas is cols x rows cells
// (a cell is 8x16 font pixels), so the output size never depends on content:
// 64 cols x 32 rows at scale 2 is always exactly 1024x1024. Content that
// exceeds the grid is clipped, never resized.
import { encodePng } from "./png";
import { getFont, type Glyph } from "./unifont";

export interface GridOpts {
  cols: number;
  rows: number;
  scale?: number; // integer pixel multiplier
  bg?: [number, number, number];
  ink?: [number, number, number];
}

const BG: [number, number, number] = [10, 10, 12]; // near-black
const INK: [number, number, number] = [207, 209, 214]; // mono light grey

export function renderGrid(lines: string[], opts: GridOpts): Buffer {
  const scale = Math.max(1, Math.floor(opts.scale ?? 2));
  const bg = opts.bg ?? BG;
  const ink = opts.ink ?? INK;
  const width = opts.cols * 8 * scale;
  const height = opts.rows * 16 * scale;

  const img = Buffer.alloc(width * height * 3);
  for (let i = 0; i < img.length; i += 3) {
    img[i] = bg[0];
    img[i + 1] = bg[1];
    img[i + 2] = bg[2];
  }

  const font = getFont();
  const missing = font.get(0xfffd);
  for (let row = 0; row < Math.min(lines.length, opts.rows); row++) {
    let x = 0;
    for (const ch of lines[row].replace(/\t/g, "    ")) {
      const g = font.get(ch.codePointAt(0) as number) ?? missing;
      const w = g?.width ?? 8;
      if (x + w * scale > width) break; // clip at the right edge
      if (g) drawGlyph(img, width, g, x, row * 16 * scale, scale, ink);
      x += w * scale;
    }
  }
  return encodePng(width, height, img);
}

function drawGlyph(
  img: Buffer,
  imgWidth: number,
  g: Glyph,
  ox: number,
  oy: number,
  scale: number,
  ink: [number, number, number],
): void {
  for (let r = 0; r < 16; r++) {
    const bits = g.rows[r];
    if (!bits) continue;
    for (let c = 0; c < g.width; c++) {
      if (!(bits & (1 << (g.width - 1 - c)))) continue;
      for (let dy = 0; dy < scale; dy++) {
        let idx = (imgWidth * (oy + r * scale + dy) + ox + c * scale) * 3;
        for (let dx = 0; dx < scale; dx++, idx += 3) {
          img[idx] = ink[0];
          img[idx + 1] = ink[1];
          img[idx + 2] = ink[2];
        }
      }
    }
  }
}
