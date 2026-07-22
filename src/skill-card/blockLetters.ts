// Two-row half-block letterforms for the card wordmark (the big ASCII title).
// Each letter is [topRow, bottomRow]; both rows are the same width. Rendered
// with one space between letters. Only A-Z, 0-9 and dash: skill names are
// slugs, anything else falls back to the plain-name treatment in card.ts.

const L: Record<string, [string, string]> = {
  A: ["▄▀█", "█▀█"],
  B: ["█▄▄", "█▄█"],
  C: ["█▀▀", "█▄▄"],
  D: ["█▀▄", "█▄▀"],
  E: ["█▀▀", "██▄"],
  F: ["█▀▀", "█▀ "],
  G: ["█▀▀", "█▄█"],
  H: ["█ █", "█▀█"],
  I: ["█", "█"],
  J: [" █", "▄█"],
  K: ["█▄▀", "█ █"],
  L: ["█  ", "█▄▄"],
  M: ["█▀▄▀█", "█ ▀ █"],
  N: ["█▄ █", "█ ▀█"],
  O: ["█▀█", "█▄█"],
  P: ["█▀█", "█▀▀"],
  Q: ["█▀█", "█▄▀"],
  R: ["█▀█", "█▀▄"],
  S: ["█▀", "▄█"],
  T: ["▀█▀", " █ "],
  U: ["█ █", "█▄█"],
  V: ["█ █", "▀▄▀"],
  W: ["█ █ █", "▀▄▀▄▀"],
  X: ["▀▄▀", "█ █"],
  Y: ["█ █", " █ "],
  Z: ["▀▀█", "█▄▄"],
  "0": ["█▀█", "█▄█"],
  "1": ["▄█", " █"],
  "2": ["▀▀█", "█▄▄"],
  "3": ["▀▀█", "▄▄█"],
  "4": ["█ █", "▀▀█"],
  "5": ["█▀▀", "▄▄█"],
  "6": ["█▄▄", "█▄█"],
  "7": ["▀▀█", " ▄▀"],
  "8": ["▄█▄", "█▄█"],
  "9": ["█▀█", "▄▄█"],
  "-": ["▄▄", "  "],
};

/** Render text as a two-row block wordmark, or null when a character has no
 *  letterform. Rows come back equal-width. */
export function wordmark(text: string): [string, string] | null {
  const top: string[] = [];
  const bottom: string[] = [];
  for (const ch of text.toUpperCase()) {
    const form = L[ch];
    if (!form) return null;
    top.push(form[0]);
    bottom.push(form[1]);
  }
  return [top.join(" "), bottom.join(" ")];
}
