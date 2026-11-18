/**
 * Tests each API key on its own and reports exactly what is wrong.
 *
 *   node scripts/check-keys.js
 */

import 'dotenv/config';

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

console.log('\nChecking keys…\n');

/* ---- Deepgram ---- */

const dg = process.env.DEEPGRAM_API_KEY;
if (!dg) {
  bad('DEEPGRAM_API_KEY is not set — speech recognition will run in mock mode');
} else {
  try {
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${dg}` },
    });
    if (res.ok) ok('Deepgram key works');
    else if (res.status === 401) bad('Deepgram rejected the key (401) — check for typos or stray spaces');
    else bad(`Deepgram returned ${res.status}`);
  } catch (e) {
    bad(`Could not reach Deepgram: ${e.message}`);
  }
}

/* ---- Anthropic ---- */

const an = process.env.ANTHROPIC_API_KEY;
const provider = (process.env.TRANSLATE_PROVIDER || 'none').toLowerCase();

if (provider !== 'claude') {
  info(`TRANSLATE_PROVIDER is "${provider}", so the Anthropic key is not used`);
} else if (!an) {
  bad('ANTHROPIC_API_KEY is not set — translation will pass Arabic through untranslated');
} else {
  const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': an,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: 'Reply with JSON only: {"fr":"...","en":"..."}',
        messages: [{ role: 'user', content: 'Source language: ar\n\nالحمد لله رب العالمين' }],
      }),
    });

    const body = await res.text();

    if (res.ok) {
      ok(`Anthropic key works (model ${model})`);
      const text = JSON.parse(body).content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      info(`test translation: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
    } else if (res.status === 401) {
      bad('Anthropic rejected the key (401) — check for typos or stray spaces');
    } else if (res.status === 400 && /credit/i.test(body)) {
      bad('Anthropic account has no credits');
      info('Go to console.anthropic.com → Billing and add credits. $5 covers hundreds of khutbahs.');
    } else if (res.status === 404) {
      bad(`Model "${model}" was not found`);
      info('Set CLAUDE_MODEL in .env to a model your account can use.');
    } else if (res.status === 429) {
      bad('Rate limited (429) — wait a moment and try again');
    } else {
      bad(`Anthropic returned ${res.status}`);
      info(body.slice(0, 300));
    }
  } catch (e) {
    bad(`Could not reach Anthropic: ${e.message}`);
  }
}

console.log('');
