// The AgentNet skill card template: card data becomes exactly ROWS lines of at
// most COLS columns, which renderGrid turns into a fixed 1024x1024 PNG (64
// cols x 32 rows of 8x16 cells at scale 2). Every field is read from chain
// (mint metadata, the code-in inscription, the gate ItemConfig PDA), so the
// image derives from on-chain state only. Mutable market fields (supply,
// holders, stars) are deliberately excluded so responses cache long.
import { wordmark } from "./blockLetters";
import { renderGrid } from "./text";

export interface CardData {
  name: string;
  type: "skill" | "workflow";
  category?: string;
  hashtags: string[];
  description: string;
  creator: string | null; // base58, shown truncated
  priceLamports: string | null;
}

export const COLS = 64;
export const ROWS = 32;
const INDENT = "   ";
const INNER = COLS - INDENT.length * 2; // 58 usable columns

// CJK and Hangul glyphs are fullwidth in Unifont (two columns), so width
// budgeting counts them as 2. Slug names are ASCII; descriptions may not be.
function colsOf(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) as number) > 0x2e7f ? 2 : 1;
  return w;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const joined = line ? `${line} ${word}` : word;
    if (colsOf(joined) <= width) {
      line = joined;
    } else {
      if (line) out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Hard-wrap a slug on hyphen boundaries (keeps the hyphen at line end). */
function wrapSlug(slug: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const part of slug.split(/(?<=-)/)) {
    if (colsOf(line + part) <= width || !line) {
      line += part;
    } else {
      out.push(line);
      line = part;
    }
  }
  if (line) out.push(line);
  return out;
}

function lamportsToSol(lamports: string | null): string {
  if (!lamports) return "-";
  const n = Number(lamports) / 1e9;
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")} SOL`;
}

function truncMiddle(addr: string | null): string {
  return addr ? `${addr.slice(0, 4)}..${addr.slice(-4)}` : "-";
}

export function cardLines(data: CardData): string[] {
  const head: string[] = ["╔" + "═".repeat(COLS - 2) + "╗", ""];

  // Title: the full name as block letters when it fits, else the first slug
  // token as a wordmark with the full name underneath, else plain name only.
  const full = wordmark(data.name);
  const firstToken = data.name.split("-")[0] ?? data.name;
  const short = wordmark(firstToken);
  if (full && colsOf(full[0]) <= INNER) {
    head.push(INDENT + full[0], INDENT + full[1]);
  } else if (short && colsOf(short[0]) <= INNER && firstToken.length < data.name.length) {
    head.push(INDENT + short[0], INDENT + short[1]);
    const nameLines = wrapSlug(data.name, INNER - 2).slice(0, 3);
    head.push(...nameLines.map((l, i) => INDENT + (i === 0 ? "> " : "  ") + l));
  } else {
    head.push(...wrapSlug(data.name, INNER - 2).slice(0, 3).map((l, i) => INDENT + (i === 0 ? "> " : "  ") + l));
  }

  const rule = INDENT + "─".repeat(INNER);
  head.push("", rule, "");
  head.push(INDENT + `[ ${(data.category ?? "").toUpperCase()}${data.category ? " / " : ""}${data.type.toUpperCase()} ]`, "");

  const foot: string[] = [
    rule,
    "",
    INDENT + `creator    ${truncMiddle(data.creator)}`,
    INDENT + `price      ${lamportsToSol(data.priceLamports)}`,
    "",
    footerLine(),
    "",
    "╚" + "═".repeat(COLS - 2) + "╝",
  ];

  // Description gets whatever rows remain; hashtags take one line when present.
  const tagLine = data.hashtags.length ? fitTags(data.hashtags) : null;
  const budget = ROWS - head.length - foot.length - (tagLine ? 2 : 0);
  const desc = wrap(data.description ?? "", INNER);
  const body: string[] = [];
  if (desc.length > budget && budget > 0) {
    const cut = desc.slice(0, budget);
    cut[budget - 1] = cut[budget - 1].slice(0, INNER - 3) + "...";
    body.push(...cut.map((l) => INDENT + l));
  } else {
    body.push(...desc.slice(0, Math.max(0, budget)).map((l) => INDENT + l));
  }
  if (tagLine) body.push("", INDENT + tagLine);
  while (head.length + body.length + foot.length < ROWS) body.push("");

  return [...head, ...body, ...foot];
}

function fitTags(tags: string[]): string {
  let line = "";
  for (const t of tags) {
    const next = line ? `${line}  # ${t}` : `# ${t}`;
    if (colsOf(next) > INNER) break;
    line = next;
  }
  return line;
}

function footerLine(): string {
  const left = INDENT + "soulbound  token-2022  solana mainnet";
  const brand = "AGENTNET";
  const gap = COLS - INDENT.length - colsOf(left) - brand.length;
  return left + " ".repeat(Math.max(1, gap)) + brand;
}

export function renderCard(data: CardData): Buffer {
  return renderGrid(cardLines(data), { cols: COLS, rows: ROWS, scale: 2 });
}
