/**
 * Tests the two decisions that matter most:
 *   1. Does a Qur'anic quotation get recognised despite spelling variation?
 *   2. Does ordinary speech get correctly NOT recognised as scripture?
 *
 * The second is the important one. A false positive puts the wrong verse of
 * the Qur'an on a screen in front of a congregation.
 *
 * Run:  node scripts/test-pipeline.js
 */

import { readFile } from 'node:fs/promises';
import { VerseMatcher, normalizeArabic, segmentArabic } from '../lib/arabic.js';
import { ScriptAligner } from '../lib/aligner.js';

const verses = JSON.parse(await readFile(new URL('../config/verses.json', import.meta.url)));
const matcher = new VerseMatcher(verses);

console.log(`verse library: ${matcher.size} entries\n`);

console.log('--- normalisation ---');
const variants = [
  'إِنَّ اللَّهَ مَعَ الصَّابِرِينَ',   // fully vocalised
  'ان الله مع الصابرين',              // bare, alef unhamzated
  'إن اللّه مع الصّابرين',            // mixed shadda, different alef
];
variants.forEach((v) => console.log(`  ${v}  ->  ${normalizeArabic(v)}`));
const allSame = new Set(variants.map(normalizeArabic)).size === 1;
console.log(`  all three collapse to one form: ${allSame ? 'yes' : 'NO'}\n`);

console.log('--- should match scripture ---');
const quotes = [
  ['يا أيها الذين آمنوا استعينوا بالصبر والصلاة إن الله مع الصابرين', '2:153 verbatim'],
  ['ومن يتق الله يجعل له مخرجا ويرزقه من حيث لا يحتسب', '65:2 undiacritised'],
  ['فان مع العسر يسرا ان مع العسر يسرا', '94:5 bare spelling'],
  ['وتزودوا فإن خير الزاد التقوى', '2:197'],
];

let hits = 0;
for (const [text, label] of quotes) {
  const m = matcher.match(text);
  if (m) { hits += 1; console.log(`  ✓ ${m.verse.ref.padEnd(8)} ${m.score.toFixed(2)}  ${label}`);
           console.log(`      FR  ${m.verse.fr.slice(0, 68)}…`);
           console.log(`      EN  ${m.verse.en.slice(0, 68)}…`); }
  else console.log(`  ✗ MISSED  ${label}`);
}

console.log('\n--- must NOT match scripture ---');
const ordinary = [
  ['إخواني الكرام أريد أن أحدثكم اليوم عن الصبر في حياتنا', 'sermon prose mentioning sabr'],
  ['الحمد لله نحمده ونستعينه ونستغفره ونتوب إليه', 'standard opening, not a verse'],
  ['وقد التقيت رجلا في الأسبوع الماضي يعمل بجد لإطعام أولاده', 'a personal anecdote'],
  ['الله', 'a single word'],
  ['إن الله', 'two words, appears in many verses'],
];

let falsePositives = 0;
for (const [text, label] of ordinary) {
  const m = matcher.match(text);
  if (m) { falsePositives += 1; console.log(`  ✗ FALSE POSITIVE -> ${m.verse.ref} (${m.score.toFixed(2)})  ${label}`); }
  else console.log(`  ✓ passed through to translation  ${label}`);
}

console.log('\n--- script alignment on Arabic ---');
const khutbah = `الحمد لله نحمده ونستعينه ونستغفره. ونعوذ بالله من شرور أنفسنا.

إخواني الكرام، الصبر ضياء ينير قلب المؤمن في وقت الشدة. ومن صبر واحتسب وجد المخرج.

واعلموا أن ابتلاءات هذه الدنيا زائلة لا تدوم.`;

const sources = segmentArabic(khutbah);
console.log(`  split into ${sources.length} display lines`);
sources.forEach((s, i) => console.log(`   ${String(i + 1).padStart(2)}  ${s}`));

const aligner = new ScriptAligner(
  sources.map((source, i) => ({ source, fr: `[FR ${i + 1}]`, en: `[EN ${i + 1}]` })),
  { sourceLang: 'ar' }
);

const spoken = [
  ['الحمد لله نحمده ونستعينه ونستغفره', 'opening'],
  ['إخواني الكرام الصبر ضياء ينير قلب المؤمن في وقت الشدة', 'on script'],
  ['ودعوني أروي لكم قصة رجل عرفته منذ سنوات طويلة', 'AD LIB'],
  ['واعلموا أن ابتلاءات هذه الدنيا زائلة لا تدوم', 'rejoins, skipping a line'],
];

let matched = 0, fell = 0;
for (const [text, label] of spoken) {
  const r = aligner.match(text);
  if (r.matched && !r.duplicate) { matched += 1; console.log(`  ✓ line ${r.index + 1} (${r.score.toFixed(2)})  ${label}`); }
  else if (r.matched) console.log(`  · dedup (${r.score.toFixed(2)})  ${label}`);
  else { fell += 1; console.log(`  ~ live translation (${r.score.toFixed(2)})  ${label}`); }
}

console.log('\n=== summary ===');
console.log(`  verses recognised:  ${hits}/${quotes.length}`);
console.log(`  false positives:    ${falsePositives}  ${falsePositives === 0 ? '(good)' : '(FIX THIS)'}`);
console.log(`  script lines hit:   ${matched}`);
console.log(`  ad-libs to live MT: ${fell}`);
process.exit(falsePositives === 0 && hits === quotes.length ? 0 : 1);
