import { tokenizeArabic } from './arabic.js';

/**
 * Script alignment.
 *
 * The problem: we have the sermon written out and translated ahead of time,
 * but we don't know where the speaker currently is. Speakers skip lines,
 * repeat themselves, ad-lib for two minutes, then rejoin. So we run speech
 * recognition anyway and use it only to answer "which line is he on?"
 *
 * The approach is a monotonic pointer with a lookahead window. We score the
 * recognized words against a handful of candidate lines around the current
 * position and take the best one — but only if it clears a confidence
 * threshold. Below that we assume he's off-script and hand back to live
 * translation, without moving the pointer.
 */

const STOPWORDS_FR = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'a', 'au',
  'aux', 'ce', 'ces', 'cette', 'que', 'qui', 'dans', 'pour', 'par', 'sur',
  'en', 'il', 'elle', 'ils', 'nous', 'vous', 'est', 'sont', 'ne', 'pas', 'se',
]);

const STOPWORDS_EN = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'by', 'with',
  'that', 'this', 'these', 'is', 'are', 'was', 'were', 'it', 'he', 'she',
  'they', 'we', 'you', 'not', 'as', 'at', 'be',
]);

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents: "prière" -> "priere"
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text, lang) {
  // Arabic needs its own normalisation — stripping diacritics and unifying
  // alef, hamza and ta marbuta forms. Latin accent-folding would leave the
  // text untouched and every comparison would fail.
  if (lang === 'ar') return tokenizeArabic(text);

  const stop = lang === 'fr' ? STOPWORDS_FR : STOPWORDS_EN;
  return normalize(text)
    .split(' ')
    .filter((w) => w.length > 1 && !stop.has(w));
}

/**
 * Dice coefficient over token bags. Chosen over Jaccard because it's more
 * forgiving when the recognized fragment is much shorter than the script
 * line, which is the common case — ASR hands us a clause, the script has
 * a full sentence.
 */
function similarity(aTokens, bTokens) {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const bCounts = new Map();
  for (const t of bTokens) bCounts.set(t, (bCounts.get(t) || 0) + 1);

  let overlap = 0;
  for (const t of aTokens) {
    const n = bCounts.get(t) || 0;
    if (n > 0) {
      overlap += 1;
      bCounts.set(t, n - 1);
    }
  }

  // Weight toward "how much of the heard fragment appears in this line",
  // which is what we actually care about for position finding.
  const recall = overlap / aTokens.length;
  const dice = (2 * overlap) / (aTokens.length + bTokens.length);
  return 0.7 * recall + 0.3 * dice;
}

export class ScriptAligner {
  /**
   * @param {Array<{source: string, target: string}>} segments
   * @param {object} options
   */
  constructor(segments, options = {}) {
    this.segments = segments || [];
    this.sourceLang = options.sourceLang || 'fr';
    this.threshold = options.threshold ?? 0.42;
    this.lookahead = options.lookahead ?? 6;
    this.lookbehind = options.lookbehind ?? 2;

    this.tokenized = this.segments.map((s) => tokenize(s.source, this.sourceLang));
    this.pointer = 0;
    this.lastEmitted = -1;
    this.missStreak = 0;
  }

  reset() {
    this.pointer = 0;
    this.lastEmitted = -1;
    this.missStreak = 0;
  }

  /** Jump the pointer manually — the operator console exposes this. */
  seek(index) {
    this.pointer = Math.max(0, Math.min(index, this.segments.length - 1));
    this.lastEmitted = this.pointer - 1;
    this.missStreak = 0;
  }

  /**
   * @param {string} heard  a finalized transcript fragment
   * @returns {{matched: boolean, index?: number, segment?: object, score: number}}
   */
  match(heard) {
    const tokens = tokenize(heard, this.sourceLang);
    if (tokens.length < 2 || this.segments.length === 0) {
      return { matched: false, score: 0 };
    }

    // After several consecutive misses the speaker has probably jumped
    // somewhere unexpected, so widen the search to the whole script.
    const wide = this.missStreak >= 3;
    const start = wide ? 0 : Math.max(0, this.pointer - this.lookbehind);
    const end = wide
      ? this.segments.length
      : Math.min(this.segments.length, this.pointer + this.lookahead);

    let best = { index: -1, score: 0 };
    for (let i = start; i < end; i += 1) {
      const score = similarity(tokens, this.tokenized[i]);
      if (score > best.score) best = { index: i, score };
    }

    if (best.score < this.threshold) {
      this.missStreak += 1;
      return { matched: false, score: best.score };
    }

    this.missStreak = 0;
    this.pointer = best.index + 1;

    // One script line often spans several ASR fragments. Don't re-display
    // a line we just showed.
    if (best.index === this.lastEmitted) {
      return { matched: true, duplicate: true, index: best.index, score: best.score };
    }

    this.lastEmitted = best.index;
    return {
      matched: true,
      duplicate: false,
      index: best.index,
      segment: this.segments[best.index],
      score: best.score,
    };
  }

  get progress() {
    if (this.segments.length === 0) return 0;
    return Math.min(1, (this.lastEmitted + 1) / this.segments.length);
  }
}

/**
 * Split a pasted sermon into display-sized segments. Paragraphs are too long
 * to read on a screen in one go; single words are too choppy. Sentences,
 * merged up to a character budget, land about right.
 */
export function segmentScript(raw, maxChars = 120) {
  // Only merge a sentence onto the previous one when that previous one is
  // too short to stand alone ("Mes frères." / "Écoutez bien."). Merging on a
  // pure character budget produces two-sentence lines that appear on screen
  // all at once and then sit there while the speaker works through them —
  // the display stops tracking the voice, which is the whole point.
  const MERGE_UNDER = 55;

  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const out = [];

  for (const para of paragraphs) {
    const sentences = para.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || [para];

    let buffer = '';
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (!s) continue;

      const canMerge =
        buffer && buffer.length < MERGE_UNDER && buffer.length + s.length + 1 <= maxChars;

      if (canMerge) {
        buffer = `${buffer} ${s}`;
      } else {
        if (buffer) out.push(buffer);
        buffer = s;
      }
    }
    if (buffer) out.push(buffer);
  }

  // A sentence longer than the budget still has to break somewhere. Clause
  // boundaries are the least bad place — never mid-phrase.
  const final = [];
  for (const line of out) {
    if (line.length <= maxChars * 1.6) {
      final.push(line);
      continue;
    }
    const clauses = line.split(/(?<=,|;|:)\s+/);
    let buffer = '';
    for (const clause of clauses) {
      if (buffer && buffer.length + clause.length + 1 > maxChars) {
        final.push(buffer);
        buffer = clause;
      } else {
        buffer = buffer ? `${buffer} ${clause}` : clause;
      }
    }
    if (buffer) final.push(buffer);
  }

  return final;
}
