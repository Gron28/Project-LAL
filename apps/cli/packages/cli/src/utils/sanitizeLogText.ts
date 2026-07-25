// Log-injection defence, moved out of @lal/channel-base when the
// messaging-channel packages were deleted (PLAN 7.2). Nothing about it was
// channel-specific — run-qwen-serve.ts uses it for every stderr audit line —
// so it survives the feature it happened to live inside.

/**
 * Characters that must be neutralized in ANY attacker-controlled text we embed
 * into a prompt, independent of the wrapper's own delimiters: the C1 control
 * block (U+0080-U+009F) - notably NEL (U+0085), a Unicode line break (UAX#14 BK
 * class) that renders as a new line, i.e. prompt-line injection - plus the
 * Unicode line/paragraph separators (U+2028/U+2029, likewise rendered as
 * newlines) and the bidirectional override/isolate controls (U+202A-U+202E,
 * U+2066-U+2069 -> trojan-source, where the visual order differs from the
 * logical byte order). Also strips common zero-width format chars that make
 * visually identical names/text compare differently. ASCII C0/DEL (incl. CR/LF)
 * are stripped by each caller.
 */
export const PROMPT_UNSAFE_INVISIBLES =
  /[\u0080-\u009f\p{Cf}\u2028\u2029]|\p{Variation_Selector}/gu;

/**
 * Truncate to at most `max` Unicode CODE POINTS (not UTF-16 code units). A cap
 * applied with `.slice` counts code units, so one landing mid-surrogate-pair
 * (e.g. an emoji \ud83c\udf89 = 2 units) leaves a lone surrogate that renders as `\ufffd`.
 * `Array.from` iterates by code point, so slicing it never splits a pair.
 */
export function truncateCodePoints(str: string, max: number): string {
  const cp = Array.from(str);
  return cp.length > max ? cp.slice(0, max).join('') : str;
}

/**
 * Neutralize attacker-controlled text before it is written to a single-line
 * stderr audit/diagnostic log. Caps to `maxLen` code points, renders ASCII
 * newlines as a visible `\n` escape (so a multi-line payload stays one readable
 * log line instead of collapsing to a space), then strips everything that could
 * forge or corrupt a log line: PROMPT_UNSAFE_INVISIBLES (the C1 block incl. NEL
 * U+0085, the Unicode line/paragraph separators U+2028/U+2029, and the bidi
 * override/isolate controls — all of which render as a line break or reorder
 * text) AND the C0/DEL controls (CR could overwrite the line, ESC could inject
 * ANSI/OSC). Shared by every audit-log site so the strip set can't drift apart.
 */
export function sanitizeLogText(text: string, maxLen: number): string {
  return (
    truncateCodePoints(text, maxLen)
      // Render real newlines visibly BEFORE the control strip, so the common
      // ASCII-newline case shows as `\n` rather than collapsing to a space.
      .replace(/\n/g, '\\n')
      .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
  );
}
