import { Hono } from "hono";
import { readAsset, generateETag, decodeAssetData, detectImageType } from "../chain";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../cache";

export const renderRouter = new Hono();

// Load resvg for PNG output
let Resvg: any = null;
try {
  const mod = await import("@resvg/resvg-js");
  Resvg = mod.Resvg;
  console.log("[render] resvg loaded — serving PNG");
} catch {
  console.log("[render] resvg not available — serving SVG");
}

// IQ Labs color palette (from solchat-web)
const IQ_GREEN = "#41FF00";
const IQ_GREEN_DARK = "#006400";
const BG_BLACK = "#0a0a0a";
const WIN_GRAY  = "#c0c0c0";
const WIN_LIGHT = "#dfdfdf";
const WIN_SHADOW = "#808080";
const WIN_DARK = "#404040";

/** Escape text for safe embedding in HTML/SVG markup. */
export function escapeMarkup(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Detect if a line is pre-formatted (ASCII art, tables, code)
function isPreformatted(line: string): boolean {
  // Leading whitespace used for alignment
  if (/^\s{2,}\S/.test(line)) return true;
  // Box-drawing / block characters
  if (/[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬█▓▒░▄▀▌▐]/.test(line)) return true;
  // Repeated symbols (art patterns)
  if (/(.)\1{4,}/.test(line.replace(/\s/g, ""))) return true;
  return false;
}

function formatLines(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= maxChars) {
      lines.push(rawLine || " ");
    } else if (isPreformatted(rawLine)) {
      // Truncate pre-formatted lines, don't wrap
      lines.push(rawLine.slice(0, maxChars));
    } else {
      // Word-wrap prose
      let remaining = rawLine;
      while (remaining.length > maxChars) {
        let breakIdx = remaining.lastIndexOf(" ", maxChars);
        if (breakIdx <= 0) breakIdx = maxChars;
        lines.push(remaining.slice(0, breakIdx));
        remaining = remaining.slice(breakIdx).trimStart();
      }
      if (remaining) lines.push(remaining);
    }
  }
  return lines;
}

function generateSvg(text: string, sig: string): string {
  const MAX_CHARS = 58;
  const FONT_SIZE = 18;
  const LINE_HEIGHT = 26;
  const PAD = 24;
  const TITLE_H = 36;
  const FOOTER_H = 32;
  const BORDER = 4;
  const WIDTH = 800;

  const lines = formatLines(text, MAX_CHARS);
  const MAX_LINES = 25;
  const display = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) display.push("...");

  const contentH = display.length * LINE_HEIGHT + PAD * 2;
  const INNER_TOP = BORDER + TITLE_H + 4;
  const HEIGHT = BORDER * 2 + TITLE_H + contentH + FOOTER_H + 12;

  const shortSig = sig.length > 24 ? sig.slice(0, 8) + "..." + sig.slice(-8) : sig;

  const textEls = display
    .map(
      (line, i) =>
        `<text x="${BORDER + PAD}" y="${INNER_TOP + PAD + 6 + i * LINE_HEIGHT}" ` +
        `font-family="DejaVu Sans Mono, monospace" font-size="${FONT_SIZE}" font-weight="bold" ` +
        `fill="${IQ_GREEN}" xml:space="preserve">${escapeMarkup(line || " ")}</text>`
    )
    .join("\n    ");

  // Win95 3D raised border: light on top+left, dark on bottom+right
  // Inset border for content: dark on top+left, light on bottom+right
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="titleGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000000"/>
      <stop offset="100%" stop-color="${IQ_GREEN_DARK}"/>
    </linearGradient>
    <pattern id="scanlines" x="0" y="0" width="2" height="4" patternUnits="userSpaceOnUse">
      <rect width="2" height="1" fill="${IQ_GREEN}" opacity="0.04"/>
    </pattern>
    <filter id="glow">
      <feGaussianBlur stdDeviation="1.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Win95 outer raised border -->
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${WIN_LIGHT}"/>
  <rect x="2" y="2" width="${WIDTH - 2}" height="${HEIGHT - 2}" fill="${WIN_SHADOW}"/>
  <rect x="2" y="2" width="${WIDTH - 4}" height="${HEIGHT - 4}" fill="${WIN_GRAY}"/>

  <!-- Title bar -->
  <rect x="${BORDER}" y="${BORDER}" width="${WIDTH - BORDER * 2}" height="${TITLE_H}" fill="url(#titleGrad)"/>

  <!-- Title text -->
  <text x="${BORDER + 10}" y="${BORDER + 24}" font-family="DejaVu Sans Mono, monospace" font-size="16" font-weight="bold" fill="${IQ_GREEN}" filter="url(#glow)">IQLabs — ${escapeMarkup(shortSig)}</text>

  <!-- Win95 title bar buttons -->
  <!-- Minimize -->
  <rect x="${WIDTH - BORDER - 70}" y="${BORDER + 6}" width="20" height="20" fill="${WIN_GRAY}"/>
  <rect x="${WIDTH - BORDER - 70}" y="${BORDER + 6}" width="20" height="1" fill="${WIN_LIGHT}"/>
  <rect x="${WIDTH - BORDER - 70}" y="${BORDER + 6}" width="1" height="20" fill="${WIN_LIGHT}"/>
  <rect x="${WIDTH - BORDER - 50}" y="${BORDER + 6}" width="1" height="20" fill="${WIN_DARK}"/>
  <rect x="${WIDTH - BORDER - 70}" y="${BORDER + 25}" width="21" height="1" fill="${WIN_DARK}"/>
  <rect x="${WIDTH - BORDER - 64}" y="${BORDER + 21}" width="8" height="2" fill="#000"/>

  <!-- Maximize -->
  <rect x="${WIDTH - BORDER - 46}" y="${BORDER + 6}" width="20" height="20" fill="${WIN_GRAY}"/>
  <rect x="${WIDTH - BORDER - 46}" y="${BORDER + 6}" width="20" height="1" fill="${WIN_LIGHT}"/>
  <rect x="${WIDTH - BORDER - 46}" y="${BORDER + 6}" width="1" height="20" fill="${WIN_LIGHT}"/>
  <rect x="${WIDTH - BORDER - 26}" y="${BORDER + 6}" width="1" height="20" fill="${WIN_DARK}"/>
  <rect x="${WIDTH - BORDER - 46}" y="${BORDER + 25}" width="21" height="1" fill="${WIN_DARK}"/>
  <rect x="${WIDTH - BORDER - 42}" y="${BORDER + 10}" width="12" height="12" fill="none" stroke="#000" stroke-width="2"/>

  <!-- Close -->
  <rect x="${WIDTH - BORDER - 22}" y="${BORDER + 6}" width="20" height="20" fill="${WIN_GRAY}"/>
  <rect x="${WIDTH - BORDER - 22}" y="${BORDER + 6}" width="20" height="1" fill="${WIN_LIGHT}"/>
  <rect x="${WIDTH - BORDER - 22}" y="${BORDER + 6}" width="1" height="20" fill="${WIN_LIGHT}"/>
  <rect x="${WIDTH - BORDER - 2}" y="${BORDER + 6}" width="1" height="20" fill="${WIN_DARK}"/>
  <rect x="${WIDTH - BORDER - 22}" y="${BORDER + 25}" width="21" height="1" fill="${WIN_DARK}"/>
  <line x1="${WIDTH - BORDER - 17}" y1="${BORDER + 11}" x2="${WIDTH - BORDER - 7}" y2="${BORDER + 21}" stroke="#000" stroke-width="2"/>
  <line x1="${WIDTH - BORDER - 7}" y1="${BORDER + 11}" x2="${WIDTH - BORDER - 17}" y2="${BORDER + 21}" stroke="#000" stroke-width="2"/>

  <!-- Content area inset border -->
  <rect x="${BORDER}" y="${INNER_TOP}" width="${WIDTH - BORDER * 2}" height="${contentH + 4}" fill="${WIN_DARK}"/>
  <rect x="${BORDER + 2}" y="${INNER_TOP + 2}" width="${WIDTH - BORDER * 2 - 2}" height="${contentH + 2}" fill="${WIN_LIGHT}"/>
  <rect x="${BORDER + 2}" y="${INNER_TOP + 2}" width="${WIDTH - BORDER * 2 - 4}" height="${contentH}" fill="${BG_BLACK}"/>

  <!-- Scanline overlay -->
  <rect x="${BORDER + 2}" y="${INNER_TOP + 2}" width="${WIDTH - BORDER * 2 - 4}" height="${contentH}" fill="url(#scanlines)"/>

  <!-- Text content with glow -->
  <g filter="url(#glow)">
    ${textEls}
  </g>

  <!-- Footer status bar (Win95 style sunken panels) -->
  <rect x="${BORDER}" y="${HEIGHT - BORDER - FOOTER_H}" width="${WIDTH - BORDER * 2}" height="${FOOTER_H}" fill="${WIN_GRAY}"/>
  <!-- Left panel (inset) -->
  <rect x="${BORDER + 2}" y="${HEIGHT - BORDER - FOOTER_H + 4}" width="${WIDTH - BORDER * 2 - 120}" height="${FOOTER_H - 8}" fill="${WIN_DARK}"/>
  <rect x="${BORDER + 3}" y="${HEIGHT - BORDER - FOOTER_H + 5}" width="${WIDTH - BORDER * 2 - 122}" height="${FOOTER_H - 10}" fill="${WIN_LIGHT}"/>
  <rect x="${BORDER + 3}" y="${HEIGHT - BORDER - FOOTER_H + 5}" width="${WIDTH - BORDER * 2 - 123}" height="${FOOTER_H - 11}" fill="#f0f0f0"/>
  <text x="${BORDER + 10}" y="${HEIGHT - BORDER - 11}" font-family="DejaVu Sans Mono, monospace" font-size="12" fill="#000">inscribed on solana via iqlabs • gateway.iqlabs.dev</text>

  <!-- Right panel (inset) -->
  <rect x="${WIDTH - BORDER - 114}" y="${HEIGHT - BORDER - FOOTER_H + 4}" width="110" height="${FOOTER_H - 8}" fill="${WIN_DARK}"/>
  <rect x="${WIDTH - BORDER - 113}" y="${HEIGHT - BORDER - FOOTER_H + 5}" width="108" height="${FOOTER_H - 10}" fill="${WIN_LIGHT}"/>
  <rect x="${WIDTH - BORDER - 113}" y="${HEIGHT - BORDER - FOOTER_H + 5}" width="107" height="${FOOTER_H - 11}" fill="#f0f0f0"/>
  <rect x="${WIDTH - BORDER - 106}" y="${HEIGHT - BORDER - 20}" width="8" height="8" fill="${IQ_GREEN}"/>
  <text x="${WIDTH - BORDER - 94}" y="${HEIGHT - BORDER - 11}" font-family="DejaVu Sans Mono, monospace" font-size="12" font-weight="bold" fill="${IQ_GREEN_DARK}">ON-CHAIN</text>
</svg>`;
}

renderRouter.get("/:sig", async (c) => {
  let sig = c.req.param("sig");
  if (sig.endsWith(".png")) sig = sig.slice(0, -4);
  if (sig.endsWith(".svg")) sig = sig.slice(0, -4);
  if (!sig || sig.length < 80) return c.text("invalid signature", 400);

  const isPng = Resvg !== null;
  const format = isPng ? "png" : "svg";
  const cacheKey = `render-${format}:${sig}`;

  // Check caches
  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("render", sig);
    if (disk) {
      buf = disk;
      imageCache.set(cacheKey, buf, TTL.IMAGE);
    }
  }

  if (!buf) {
    try {
      const { data } = await readAsset(sig);
      if (!data) return c.text("not found", 404);

      const decoded = decodeAssetData(data);
      if (detectImageType(decoded)) return c.redirect(`/img/${sig}`, 302);
      const text = decoded.toString("utf-8");

      const svg = generateSvg(text, sig);

      if (isPng) {
        const resvg = new Resvg(svg, {
          fitTo: { mode: "width" as const, value: 800 },
          font: {
            fontFiles: ["./fonts/DejaVuSansMono-Bold.ttf", "./fonts/DejaVuSansMono.ttf"],
            loadSystemFonts: true,
          },
        });
        const rendered = resvg.render();
        buf = Buffer.from(rendered.asPng());
      } else {
        buf = Buffer.from(svg, "utf-8");
      }

      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("render", sig, buf);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      console.error("render error:", msg);
      return c.text("failed to render", 500);
    }
  }

  const contentType = isPng ? "image/png" : "image/svg+xml";
  const etag = generateETag(buf);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
