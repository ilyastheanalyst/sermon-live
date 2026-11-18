/**
 * Translation, Arabic -> {French, English}.
 *
 * Two things matter here beyond the actual translating.
 *
 * 1. Fallback. If the preferred provider fails — no credits, bad key, rate
 *    limit — the app tries the next configured one rather than dropping to
 *    untranslated Arabic. A degraded translation beats no translation in
 *    front of a congregation.
 *
 * 2. Reporting. Whatever goes wrong is recorded and surfaced in the operator
 *    console, because "TRANSLATION DEGRADED" with no reason is not something
 *    anyone can act on mid-sermon.
 *
 * Scripture never reaches this file. Qur'anic quotations are intercepted
 * upstream by the verse matcher and served from established translations.
 */

const DEEPL_LANG = { ar: 'AR', fr: 'FR', en: 'EN-US' };

/* ------------------------------------------------------------------ *
 * Error state, readable by the server and shown in the console
 * ------------------------------------------------------------------ */

const state = {
  lastError: null,      // { provider, message, hint, at }
  activeProvider: null, // what actually produced the last successful line
  consecutiveFailures: 0,
};

export function translationState() {
  return { ...state };
}

function recordFailure(provider, message, hint) {
  state.lastError = { provider, message, hint, at: Date.now() };
  state.consecutiveFailures += 1;
}

function recordSuccess(provider) {
  state.activeProvider = provider;
  state.consecutiveFailures = 0;
  state.lastError = null;
}

/**
 * Turns an HTTP failure into something a person can act on. This mapping is
 * the difference between a support conversation and a five-second fix.
 */
function explain(provider, status, body) {
  if (status === 401 || status === 403) {
    return {
      message: `${provider} rejected the API key`,
      hint: 'Check .env for typos or a stray space, then restart.',
    };
  }
  if (status === 400 && /credit|balance|quota/i.test(body)) {
    return {
      message: `${provider} account has no credits`,
      hint: 'Add credits in the provider console. $5 covers hundreds of khutbahs.',
    };
  }
  if (status === 404) {
    return {
      message: `${provider} model not found`,
      hint: 'Set CLAUDE_MODEL in .env to a model your account can use.',
    };
  }
  if (status === 429) {
    return {
      message: `${provider} rate limited`,
      hint: 'Too many requests. It should recover on its own.',
    };
  }
  if (status === 456 || /quota/i.test(body)) {
    return {
      message: `${provider} monthly quota exhausted`,
      hint: 'The free tier is used up for this month.',
    };
  }
  return {
    message: `${provider} returned ${status}`,
    hint: body.slice(0, 160),
  };
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

async function deeplOnce(texts, from, to) {
  const key = process.env.DEEPL_API_KEY;
  if (!key) throw Object.assign(new Error('DEEPL_API_KEY is not set'), { soft: true });

  const res = await fetch(process.env.DEEPL_API_URL || 'https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: texts,
      source_lang: DEEPL_LANG[from] || from.toUpperCase(),
      target_lang: DEEPL_LANG[to] || to.toUpperCase(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error('deepl'), { detail: explain('DeepL', res.status, body) });
  }

  return (await res.json()).translations.map((t) => t.text);
}

async function googleOnce(texts, from, to) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) throw Object.assign(new Error('GOOGLE_TRANSLATE_API_KEY is not set'), { soft: true });

  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, source: from, target: to, format: 'text' }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error('google'), { detail: explain('Google', res.status, body) });
  }

  return (await res.json()).data.translations.map((t) => t.translatedText);
}

async function pairProvider(once, name, texts, from) {
  const [fr, en] = await Promise.all([once(texts, from, 'fr'), once(texts, from, 'en')]);
  return texts.map((_, i) => ({ fr: fr[i] || '', en: en[i] || '', by: name }));
}

/**
 * An LLM handles a khutbah noticeably better than generic MT: the register is
 * formal and homiletic, the terminology has conventional renderings in both
 * languages, and both come back from one call.
 */
async function claudeMulti(texts, from) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY is not set'), { soft: true });

  const system = `You translate a live Friday sermon from Arabic into French and English for a screen the congregation reads in real time.

Rules:
- Preserve the formal, homiletic register. This is a sermon, not conversation.
- Use conventional Islamic terminology in both languages: taqwa, ummah, zakat, salat, the Sunnah. Do not render these into church vocabulary.
- Keep "Allah" as Allah. Keep honorifics attached to names.
- Translate only what is given. Never continue, complete, explain or comment.
- If the input is a fragment, translate it as a fragment. Do not invent an ending.
- Reply with JSON only: {"fr":"...","en":"..."} and nothing else.`;

  const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const out = [];

  for (const text of texts) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: `Source language: ${from}\n\n${text}` }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(new Error('claude'), { detail: explain('Anthropic', res.status, body) });
    }

    const raw = (await res.json()).content
      .filter((b) => b.type === 'text').map((b) => b.text).join('')
      .replace(/```json|```/g, '').trim();

    try {
      const parsed = JSON.parse(raw);
      out.push({ fr: parsed.fr || '', en: parsed.en || '', by: 'claude' });
    } catch {
      out.push({ fr: raw, en: raw, by: 'claude' });
    }
  }

  return out;
}

const RUNNERS = {
  claude: (texts, from) => claudeMulti(texts, from),
  deepl: (texts, from) => pairProvider(deeplOnce, 'deepl', texts, from),
  google: (texts, from) => pairProvider(googleOnce, 'google', texts, from),
};

/** Which providers have keys, preferred one first. */
function chain() {
  const preferred = (process.env.TRANSLATE_PROVIDER || 'none').toLowerCase();
  if (preferred === 'none') return [];

  const available = [];
  if (process.env.ANTHROPIC_API_KEY) available.push('claude');
  if (process.env.DEEPL_API_KEY) available.push('deepl');
  if (process.env.GOOGLE_TRANSLATE_API_KEY) available.push('google');

  return [
    ...available.filter((p) => p === preferred),
    ...available.filter((p) => p !== preferred),
  ];
}

export function configuredProviders() {
  return chain();
}

/* ------------------------------------------------------------------ *
 * Glossary
 * ------------------------------------------------------------------ */

let glossary = { fr: [], en: [] };

export function loadGlossary(entries) {
  glossary = { fr: entries?.fr || [], en: entries?.en || [] };
}

function applyGlossary(text, lang) {
  let out = text;
  for (const { from, to } of glossary[lang] || []) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), to);
  }
  return out;
}

/* ------------------------------------------------------------------ */

export async function translateMulti(texts, from = 'ar') {
  const list = Array.isArray(texts) ? texts : [texts];
  if (list.length === 0) return [];

  const providers = chain();

  if (providers.length === 0) {
    // No keys at all. Pass the Arabic through so the screen keeps moving.
    if (!state.lastError) {
      recordFailure(
        'none',
        'No translation provider is configured',
        'Add ANTHROPIC_API_KEY or DEEPL_API_KEY to .env, then restart.'
      );
    }
    return list.map((t) => ({ fr: t, en: t, degraded: true }));
  }

  for (const name of providers) {
    try {
      const results = await RUNNERS[name](list, from);
      recordSuccess(name);
      return results.map((r) => ({
        fr: applyGlossary(r.fr, 'fr'),
        en: applyGlossary(r.en, 'en'),
        by: name,
      }));
    } catch (err) {
      const detail = err.detail || { message: err.message, hint: '' };
      recordFailure(name, detail.message, detail.hint);
      console.error(`[translate] ${detail.message}${detail.hint ? ` — ${detail.hint}` : ''}`);
      // fall through to the next provider
    }
  }

  return list.map((t) => ({ fr: t, en: t, degraded: true }));
}

export function providerName() {
  return (process.env.TRANSLATE_PROVIDER || 'none').toLowerCase();
}
