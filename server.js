import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { translateMulti, loadGlossary, providerName, translationState, configuredProviders } from './lib/translate.js';
import { ScriptAligner } from './lib/aligner.js';
import { VerseMatcher, segmentArabic } from './lib/arabic.js';
import { createAsrSession, asrEngineName } from './lib/asr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CONFIG = path.join(__dirname, 'config');
const SCRIPT_PATH = path.join(CONFIG, 'script.json');

const app = express();
app.use(express.json({ limit: '4mb' }));

// The spec type for a web app manifest. Express would otherwise serve it as
// application/json, which most browsers accept but some install checks don't.
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.use(express.static(path.join(__dirname, 'public')));
const server = createServer(app);

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

async function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    console.warn(`[config] ${path.basename(file)} unreadable: ${e.message}`);
    return fallback;
  }
}

const keyterms = await readJson(path.join(CONFIG, 'vocabulary.json'), []);
loadGlossary(await readJson(path.join(CONFIG, 'glossary.json'), { fr: [], en: [] }));
const verses = await readJson(path.join(CONFIG, 'verses.json'), []);
const savedScript = await readJson(SCRIPT_PATH, { segments: [] });

const verseMatcher = new VerseMatcher(verses);

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

const session = {
  running: false,
  mode: 'live',
  dialect: process.env.ARABIC_DIALECT || 'ar',
  asr: null,
  aligner: null,
  segments: savedScript.segments || [],
  history: [],
  stats: { lines: 0, verses: 0, matched: 0, fallback: 0 },
};

const HISTORY_LIMIT = 8;
const displays = new Set();
const operators = new Set();
let lineId = 0;

const send = (s, p) => { if (s.readyState === 1) s.send(JSON.stringify(p)); };
const toDisplays = (p) => { for (const s of displays) send(s, p); };
const toOperators = (p) => { for (const s of operators) send(s, p); };

let lastHealth = '';

function reportHealth() {
  const t = translationState();
  const key = JSON.stringify([t.activeProvider, t.lastError?.message]);
  if (key === lastHealth) return;
  lastHealth = key;
  toOperators({ type: 'health', ...t, providers: configuredProviders() });
}

function emitLine(line) {
  session.history.push(line);
  if (session.history.length > HISTORY_LIMIT) session.history.shift();
  session.stats.lines += 1;
  toDisplays({ type: 'line', ...line });
  toOperators({ type: 'line', ...line });
  reportHealth();
}

function status() {
  return {
    type: 'status',
    running: session.running,
    mode: session.mode,
    dialect: session.dialect,
    engine: asrEngineName(),
    translator: providerName(),
    verseCount: verseMatcher.size,
    providers: configuredProviders(),
    translation: translationState(),
    segmentCount: session.segments.length,
    stats: session.stats,
  };
}

/* ------------------------------------------------------------------ *
 * The pipeline
 *
 * Order matters and is the heart of this application:
 *   1. Is it scripture?  -> canonical translation, never machine translated
 *   2. Is it on script?  -> the rendering a human approved this week
 *   3. Otherwise         -> live machine translation into both languages
 * ------------------------------------------------------------------ */

async function handleTranscript({ text, isFinal, confidence }) {
  if (!isFinal) {
    toOperators({ type: 'partial', text });
    return;
  }

  toOperators({ type: 'heard', text, confidence });

  // 1. Scripture
  const verse = verseMatcher.match(text);
  if (verse) {
    session.stats.verses += 1;
    emitLine({
      id: (lineId += 1),
      ar: verse.verse.ar,
      fr: verse.verse.fr,
      en: verse.verse.en,
      ref: verse.verse.ref,
      origin: 'verse',
      score: Number(verse.score.toFixed(2)),
    });
    return;
  }

  // 2. Prepared script
  if (session.mode === 'script' && session.aligner) {
    const result = session.aligner.match(text);

    if (result.matched && result.duplicate) return;

    if (result.matched) {
      session.stats.matched += 1;
      emitLine({
        id: (lineId += 1),
        ar: result.segment.source,
        fr: result.segment.fr,
        en: result.segment.en,
        origin: 'script',
        score: Number(result.score.toFixed(2)),
      });
      toOperators({ type: 'pointer', index: result.index, progress: session.aligner.progress });
      return;
    }

    session.stats.fallback += 1;
    const [live] = await translateMulti([text], 'ar');
    emitLine({
      id: (lineId += 1),
      ar: text,
      fr: live.fr,
      en: live.en,
      origin: 'live-fallback',
      degraded: live.degraded,
      score: Number(result.score.toFixed(2)),
    });
    return;
  }

  // 3. Live
  const [out] = await translateMulti([text], 'ar');
  emitLine({
    id: (lineId += 1),
    ar: text,
    fr: out.fr,
    en: out.en,
    origin: 'live',
    degraded: out.degraded,
  });
}

/* ------------------------------------------------------------------ *
 * Session control
 * ------------------------------------------------------------------ */

function startSession(opts = {}) {
  if (session.running) stopSession();

  session.mode = opts.mode || 'live';
  session.dialect = opts.dialect || session.dialect;
  session.history = [];
  session.stats = { lines: 0, verses: 0, matched: 0, fallback: 0 };

  session.aligner =
    session.mode === 'script'
      ? new ScriptAligner(session.segments, { sourceLang: 'ar' })
      : null;

  session.asr = createAsrSession({
    language: session.dialect,
    keyterms,
    scriptSegments: session.segments,
    onTranscript: (t) => handleTranscript(t).catch((e) => console.error('[pipeline]', e)),
    onStatus: (s) => {
      toOperators({ type: 'engine', ...s });
      toDisplays({ type: 'connection', ok: s.state === 'listening' });
    },
  });

  session.running = true;
  toDisplays({ type: 'session', running: true });
  toOperators(status());
}

function stopSession() {
  if (session.asr) session.asr.close();
  session.asr = null;
  session.running = false;
  toDisplays({ type: 'session', running: false });
  toOperators(status());
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const authorized = (req) =>
  (req.headers['x-operator-password'] || req.query.password) ===
  (process.env.OPERATOR_PASSWORD || 'change-me');

app.get('/api/script', (req, res) => res.json({ segments: session.segments }));

app.get('/api/verses', (req, res) => res.json({ count: verseMatcher.size, verses }));

app.post('/api/script', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong password.' });

  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Paste the khutbah text first.' });

  try {
    const sources = segmentArabic(text);

    // Scripture inside the prepared script is resolved the same way it is
    // live: matched against the verse library, never sent to a translator.
    const segments = [];
    const needsTranslation = [];

    for (const source of sources) {
      const verse = verseMatcher.match(source);
      if (verse) {
        segments.push({
          source,
          fr: verse.verse.fr,
          en: verse.verse.en,
          ref: verse.verse.ref,
          isVerse: true,
        });
      } else {
        segments.push({ source, fr: '', en: '', isVerse: false });
        needsTranslation.push({ index: segments.length - 1, source });
      }
    }

    const translated = await translateMulti(needsTranslation.map((n) => n.source), 'ar');
    needsTranslation.forEach((n, i) => {
      segments[n.index].fr = translated[i]?.fr || '';
      segments[n.index].en = translated[i]?.en || '';
    });

    session.segments = segments;
    await mkdir(CONFIG, { recursive: true });
    await writeFile(SCRIPT_PATH, JSON.stringify({ segments }, null, 2));

    res.json({ segments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/script/:index', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong password.' });

  const i = Number(req.params.index);
  const seg = session.segments[i];
  if (!seg) return res.status(404).json({ error: 'No such line.' });

  if (seg.isVerse) {
    return res.status(409).json({
      error: 'This line is a Qur\'anic quotation. Edit config/verses.json instead.',
    });
  }

  if (typeof req.body.fr === 'string') seg.fr = req.body.fr;
  if (typeof req.body.en === 'string') seg.en = req.body.en;

  await writeFile(SCRIPT_PATH, JSON.stringify({ segments: session.segments }, null, 2));
  res.json({ ok: true });
});

app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    engine: asrEngineName(),
    translator: providerName(),
    verses: verseMatcher.size,
    running: session.running,
    displays: displays.size,
  })
);

/* ------------------------------------------------------------------ *
 * WebSockets
 * ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/ws/display') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      displays.add(ws);
      send(ws, { type: 'hello', running: session.running, history: session.history });
      ws.on('close', () => displays.delete(ws));
      ws.on('error', () => displays.delete(ws));
    });
    return;
  }

  if (pathname === '/ws/control') {
    if (searchParams.get('password') !== (process.env.OPERATOR_PASSWORD || 'change-me')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, attachOperator);
    return;
  }

  socket.destroy();
});

function attachOperator(ws) {
  operators.add(ws);
  send(ws, status());

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (session.asr) session.asr.send(data);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.action) {
      case 'start': startSession(msg); break;
      case 'stop': stopSession(); break;
      case 'seek':
        if (session.aligner) {
          session.aligner.seek(msg.index);
          send(ws, { type: 'pointer', index: msg.index, progress: session.aligner.progress });
        }
        break;
      case 'push':
        if (msg.fr || msg.en) {
          emitLine({ id: (lineId += 1), ar: '', fr: msg.fr || '', en: msg.en || '', origin: 'manual' });
        }
        break;
      case 'clear':
        session.history = [];
        toDisplays({ type: 'clear' });
        break;
    }
  });

  ws.on('close', () => operators.delete(ws));
  ws.on('error', () => operators.delete(ws));
}

server.listen(PORT, () => {
  console.log(`\n  sermon-live  →  http://localhost:${PORT}`);
  console.log(`  display   /            (viewer picks French, English, or both)`);
  console.log(`  operator  /control.html`);
  console.log(`  speech: ${asrEngineName()}   translation: ${providerName()}   verses: ${verseMatcher.size}\n`);
});
