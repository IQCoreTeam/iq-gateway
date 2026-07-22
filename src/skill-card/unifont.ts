// GNU Unifont .hex parser + lazy singleton. Each line is "CODEPOINT:HEXROWS";
// 32 hex digits is an 8x16 glyph (one byte per row), 64 is a 16x16 glyph (two
// bytes per row). Rows run top to bottom, MSB is the leftmost pixel. Unifont
// is a bitmap font, so rendering needs no rasterizer: the same input yields
// byte-identical pixels on any machine, which keeps card images cacheable.
import { readFileSync } from "node:fs";

export interface Glyph {
  width: 8 | 16;
  rows: Uint16Array; // 16 rows, one bitmask per row
}

let cached: Map<number, Glyph> | null = null;

export function getFont(): Map<number, Glyph> {
  if (cached) return cached;
  const path = new URL("../../fonts/unifont.hex", import.meta.url).pathname;
  const font = new Map<number, Glyph>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const cp = parseInt(line.slice(0, colon), 16);
    const hex = line.slice(colon + 1).trim();
    const width = hex.length === 64 ? 16 : 8;
    const digitsPerRow = width / 4;
    const rows = new Uint16Array(16);
    for (let r = 0; r < 16; r++) {
      rows[r] = parseInt(hex.slice(r * digitsPerRow, (r + 1) * digitsPerRow), 16);
    }
    font.set(cp, { width, rows });
  }
  cached = font;
  return font;
}
