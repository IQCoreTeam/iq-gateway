/** Preserve alignment for multiline art, tables, and indented code. Prose
 * keeps its normal wrapping; long preformatted lines scroll inside the view. */
export function isPreformattedText(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.length > 1 && lines.some((line) =>
    /^\s{2,}\S/.test(line) ||
    /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬█▓▒░▄▀▌▐]/.test(line) ||
    /([^\w\s])\1{3,}/u.test(line)
  );
}
