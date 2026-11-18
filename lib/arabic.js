/**
 * Arabic normalisation and Qur'anic verse matching.
 *
 * Two problems this file solves.
 *
 * 1. Arabic has many valid written forms for the same spoken words —
 *    diacritics, alef and hamza variants, ta marbuta, tatweel. A recogniser
 *    and a stored verse will disagree on all of them while representing
 *    identical speech. Everything gets flattened before comparison.
 *
 * 2. A khutbah quotes scripture constantly, and scripture must never be
 *    machine-translated. Established translations exist and are what people
 *    expect to read. This module detects a quotation and hands back the
 *    canonical rendering instead, so the translation layer never sees it.
 */

const DIACRITICS = /[\u064B-\u0652\u0670\u06D6-\u06ED\u08F0-\u08FF\u0653-\u0655]/g;
const TATWEEL = /\u0640/g;

export function normalizeArabic(text) {
  return text
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // آ أ إ ٱ -> ا
    .replace(/\u0624/g, '\u0648')                      // ؤ -> و
    .replace(/\u0626/g, '\u064A')                      // ئ -> ي
    .replace(/\u0649/g, '\u064A')                      // ى -> ي
    .replace(/\u0629/g, '\u0647')                      // ة -> ه
    .replace(/[^\u0621-\u064A\s]/g, ' ')               // drop punctuation, digits, latin
    .replace(/\s+/g, ' ')
    .trim();
}

// Extremely common words carry no positional information.
const STOPWORDS_AR = new Set([
  'من', 'في', 'على', 'الى', 'عن', 'مع', 'ان', 'انا', 'او', 'ثم', 'قد', 'لا',
  'ما', 'هو', 'هي', 'هم', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'كان', 'كل',
  'به', 'له', 'بها', 'وهو', 'وما', 'ولا', 'يا',
]);

export function tokenizeArabic(text) {
  return normalizeArabic(text)
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS_AR.has(w));
}

function similarity(aTokens, bTokens) {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const counts = new Map();
  for (const t of bTokens) counts.set(t, (counts.get(t) || 0) + 1);

  let overlap = 0;
  for (const t of aTokens) {
    const n = counts.get(t) || 0;
    if (n > 0) {
      overlap += 1;
      counts.set(t, n - 1);
    }
  }

  const precision = overlap / aTokens.length;
  const recall = overlap / bTokens.length;
  if (precision + recall === 0) return 0;

  // Balanced F-score. Unlike script alignment — where a heard fragment is
  // expected to be shorter than the line — a quotation should match a verse
  // in both directions. Rewarding one-sided overlap here would let any
  // sentence containing "الله" match half the Qur'an.
  return (2 * precision * recall) / (precision + recall);
}

export class VerseMatcher {
  /**
   * @param {Array<{ref: string, surah: number, ayah: number, ar: string,
   *                 fr: string, en: string}>} verses
   * @param {object} options
   */
  constructor(verses = [], options = {}) {
    this.verses = verses;
    // Deliberately high. A false positive puts the wrong scripture on the
    // screen, which is far worse than missing a quotation and letting the
    // machine translate an ordinary sentence.
    this.threshold = options.threshold ?? 0.62;
    this.minTokens = options.minTokens ?? 3;
    this.tokenized = verses.map((v) => tokenizeArabic(v.ar));
  }

  /**
   * @param {string} heard
   * @returns {null | {verse: object, score: number}}
   */
  match(heard) {
    const tokens = tokenizeArabic(heard);
    if (tokens.length < this.minTokens || this.verses.length === 0) return null;

    let best = { index: -1, score: 0 };
    for (let i = 0; i < this.verses.length; i += 1) {
      const score = similarity(tokens, this.tokenized[i]);
      if (score > best.score) best = { index: i, score };
    }

    if (best.score < this.threshold) return null;
    return { verse: this.verses[best.index], score: best.score };
  }

  get size() {
    return this.verses.length;
  }
}

/**
 * Split Arabic prose into display-sized lines. Arabic sentences run long and
 * the usual western sentence terminators are unreliable, so we lean on the
 * Arabic full stop, question mark, and comma as well.
 */
export function segmentArabic(raw, maxChars = 110) {
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const out = [];

  for (const para of paragraphs) {
    const parts = para.match(/[^.؟!۔]+[.؟!۔]+|[^.؟!۔]+$/g) || [para];

    for (const part of parts) {
      const s = part.trim();
      if (!s) continue;

      if (s.length <= maxChars) {
        out.push(s);
        continue;
      }

      // Long sentence: break at Arabic comma, then at conjunction "و" if we
      // still have nothing shorter to work with.
      const clauses = s.split(/(?<=[،؛:])\s+/);
      let buffer = '';
      for (const clause of clauses) {
        if (buffer && buffer.length + clause.length + 1 > maxChars) {
          out.push(buffer);
          buffer = clause;
        } else {
          buffer = buffer ? `${buffer} ${clause}` : clause;
        }
      }
      if (buffer) out.push(buffer);
    }
  }

  return out;
}
