/**
 * Removes em dashes (and en dashes used as em dashes) from anything the bot writes. People read
 * them as a sign of AI-written text. Numeric ranges like "30–31" keep their en dash.
 */
export function noDashes(text: string): string {
  return text
    .replace(/^[ \t]*[—–][ \t]+/gm, "• ") // a dash used as a bullet
    .replace(/[ \t]*—[ \t]*/g, ", ") // any em dash, spaced or not
    .replace(/[ \t]+–[ \t]+/g, ", ") // a spaced en dash standing in for one
    .replace(/,[ \t]*([,.;:!?])/g, "$1") // "word — ." or "— ," leftovers
    .replace(/,[ \t]*$/gm, ""); // a dash that ended a line
}
