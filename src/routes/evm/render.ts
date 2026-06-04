import { Hono } from "hono";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../../cache";
import { isTxHash } from "../../utils";
import type { EvmEnv } from "../../chain/wrappers";

export const renderRouter = new Hono<EvmEnv>();

let Resvg: any = null;
try {
  const mod = await import("@resvg/resvg-js");
  Resvg = mod.Resvg;
  console.log("[render] resvg loaded — serving PNG");
} catch {
  console.log("[render] resvg not available — serving SVG");
}

const IQ_GREEN = "#41FF00";
const IQ_GREEN_DARK = "#006400";
const BG_BLACK = "#0a0a0a";
const WIN_GRAY  = "#c0c0c0";
const WIN_LIGHT = "#dfdfdf";
const WIN_SHADOW = "#808080";
const WIN_DARK = "#404040";

export function escapeMarkup(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isPreformatted(line: string): boolean {
  if (/^\s{2,}\S/.test(line)) return true;
  if (/[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬█▓▒░▄▀▌▐]/.test(line)) return true;
  if (/(.)\1{4,}/.test(line.replace(/\s/g, ""))) return true;
  return false;
}

function formatLines(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= maxChars) {
      lines.push(rawLine || " ");
    } else if (isPreformatted(rawLine)) {
      lines.push(rawLine.slice(0, maxChars));
    } else {
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

function generateSvg(text: string, txHash: string): string {
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

  const short = txHash.length > 24 ? txHash.slice(0, 10) + "..." + txHash.slice(-8) : txHash;

  const textEls = display
    .map(
      (line, i) =>
        `<text x="${BORDER + PAD}" y="${INNER_TOP + PAD + 6 + i * LINE_HEIGHT}" ` +
        `font-family="DejaVu Sans Mono, monospace" font-size="${FONT_SIZE}" font-weight="bold" ` +
        `fill="${IQ_GREEN}" xml:space="preserve">${escapeMarkup(line || " ")}</text>`,
    )
    .join("\n    ");

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

  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${WIN_LIGHT}"/>
  <rect x="2" y="2" width="${WIDTH - 2}" height="${HEIGHT - 2}" fill="${WIN_SHADOW}"/>
  <rect x="2" y="2" width="${WIDTH - 4}" height="${HEIGHT - 4}" fill="${WIN_GRAY}"/>

  <rect x="${BORDER}" y="${BORDER}" width="${WIDTH - BORDER * 2}" height="${TITLE_H}" fill="url(#titleGrad)"/>
  <text x="${BORDER + 12}" y="${BORDER + 24}" font-family="DejaVu Sans Mono, monospace" font-size="16" font-weight="bold" fill="${IQ_GREEN}" filter="url(#glow)">IQLabs — ${escapeMarkup(short)}</text>

  <rect x="${BORDER}" y="${INNER_TOP}" width="${WIDTH - BORDER * 2}" height="${contentH + 4}" fill="${WIN_DARK}"/>
  <rect x="${BORDER + 2}" y="${INNER_TOP + 2}" width="${WIDTH - BORDER * 2 - 2}" height="${contentH + 2}" fill="${WIN_LIGHT}"/>
  <rect x="${BORDER + 2}" y="${INNER_TOP + 2}" width="${WIDTH - BORDER * 2 - 4}" height="${contentH}" fill="${BG_BLACK}"/>
  <rect x="${BORDER + 2}" y="${INNER_TOP + 2}" width="${WIDTH - BORDER * 2 - 4}" height="${contentH}" fill="url(#scanlines)"/>

  <g filter="url(#glow)">
    ${textEls}
  </g>

  <rect x="${BORDER}" y="${HEIGHT - BORDER - FOOTER_H}" width="${WIDTH - BORDER * 2}" height="${FOOTER_H}" fill="${WIN_GRAY}"/>
  <text x="${BORDER + 10}" y="${HEIGHT - BORDER - 11}" font-family="DejaVu Sans Mono, monospace" font-size="12" fill="#000">inscribed on EVM via iqlabs</text>
  <rect x="${WIDTH - BORDER - 110}" y="${HEIGHT - BORDER - 20}" width="8" height="8" fill="${IQ_GREEN}"/>
  <text x="${WIDTH - BORDER - 98}" y="${HEIGHT - BORDER - 11}" font-family="DejaVu Sans Mono, monospace" font-size="12" font-weight="bold" fill="${IQ_GREEN_DARK}">ON-CHAIN</text>
</svg>`;
}

renderRouter.get("/:txHash", async (c) => {
  let txHash = c.req.param("txHash");
  if (txHash.endsWith(".png")) txHash = txHash.slice(0, -4);
  if (txHash.endsWith(".svg")) txHash = txHash.slice(0, -4);
  if (!isTxHash(txHash)) return c.text("invalid tx hash", 400);
  const chain = c.get("chain");
  const network = c.get("network");

  const isPng = Resvg !== null;
  const format = isPng ? "png" : "svg";
  const cacheKey = `${network}:render-${format}:${txHash}`;

  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("render", txHash, network);
    if (disk) {
      buf = disk;
      imageCache.set(cacheKey, buf, TTL.IMAGE);
    }
  }

  if (!buf) {
    try {
      const { data } = await chain.readAsset(txHash);
      if (!data) return c.text("not found", 404);
      const decoded = chain.decodeAssetData(data);
      if (chain.detectImageType(decoded)) return c.redirect(`/img/${txHash}`, 302);
      const text = decoded.toString("utf-8");
      const svg = generateSvg(text, txHash);
      if (isPng) {
        const resvg = new Resvg(svg, {
          fitTo: { mode: "width" as const, value: 800 },
          font: { fontFiles: ["./fonts/DejaVuSansMono-Bold.ttf", "./fonts/DejaVuSansMono.ttf"], loadSystemFonts: true },
        });
        buf = Buffer.from(resvg.render().asPng());
      } else {
        buf = Buffer.from(svg, "utf-8");
      }
      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("render", txHash, buf, network);
    } catch (e) {
      console.error("render error:", e instanceof Error ? e.message : e);
      return c.text("failed to render", 500);
    }
  }

  const contentType = isPng ? "image/png" : "image/svg+xml";
  const etag = chain.generateETag(buf);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
