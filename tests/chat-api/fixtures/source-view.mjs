/*
 * Reading source as CODE rather than as text.
 *
 * WHY THIS EXISTS. Several tests in this suite assert that something does
 * NOT appear in a module: no innerHTML in the render path, no localStorage
 * in the transport, no Firestore write function anywhere. A plain substring
 * search cannot do that honestly, because these files explain themselves at
 * length and the explanations name the very things they are promising not
 * to do:
 *
 *   "There is no innerHTML anywhere in this section"
 *   "why this is sessionStorage and not localStorage"
 *   "See openChatForReview() at the foot of this file"
 *
 * A naive check fails on the documentation, and the two ways out - deleting
 * the comments, or loosening the check - are both worse than the problem.
 * So the source is read through one of two views, and each test uses the
 * strictest one that can answer its question:
 *
 *   codeAndStrings(src)   comments blanked, string literals KEPT.
 *                         For "no endpoint is hard-coded here" - a
 *                         fetch('/api/chat/start') must still be caught.
 *
 *   codeOnly(src)         comments AND string bodies blanked.
 *                         For "this identifier is never used" - a name
 *                         inside a message is a mention, not a use.
 *
 * Newlines survive both, so a reported line number still points at the real
 * file.
 */

/*
 * The scanner. Walks the source once, replacing the inside of comments -
 * and optionally of string literals - with spaces.
 *
 * Escape-aware, because 'Esther\'s' is one string and a naive quote-matcher
 * reads it as two. That is not hypothetical: this codebase is full of them.
 */
function blank(src, keepStrings) {
  const gap = (ch) => (ch === '\n' ? '\n' : ' ');
  let out = '';
  let i = 0;

  while (i < src.length) {
    const two = src.slice(i, i + 2);

    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += gap(src[i]);
      continue;
    }

    if (two === '//') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }

    const quote = src[i];
    if (quote === "'" || quote === '"' || quote === '`') {
      out += quote;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += keepStrings ? src.slice(i, i + 2) : (' ' + gap(src[i + 1] || ' '));
          i += 2;
          continue;
        }
        if (src[i] === quote) { out += quote; i += 1; break; }
        out += keepStrings ? src[i] : gap(src[i]);
        i += 1;
      }
      continue;
    }

    out += src[i];
    i += 1;
  }
  return out;
}

/* Comments gone, strings intact. */
export function codeAndStrings(src) {
  return blank(src, true);
}

/* Comments and string bodies gone; only executable structure remains. */
export function codeOnly(src) {
  return blank(src, false);
}
