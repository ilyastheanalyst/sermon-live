/**
 * Speech recognition transport.
 *
 * Real mode opens a websocket to Deepgram and forwards browser audio to it.
 * Mock mode fabricates transcripts on a timer so the display and alignment
 * can be tested end to end before anyone signs up for an API key.
 */

import WebSocket from 'ws';

const MOCK_LINES = [
  'الحمد لله نحمده ونستعينه ونستغفره',
  'يا أيها الذين آمنوا اتقوا الله حق تقاته ولا تموتن إلا وأنتم مسلمون',
  'أما بعد فإن خير الحديث كتاب الله وخير الهدي هدي محمد صلى الله عليه وسلم',
  'إخواني الكرام الصبر ضياء ينير قلب المؤمن في وقت الشدة',
  'قال تعالى يا أيها الذين آمنوا استعينوا بالصبر والصلاة إن الله مع الصابرين',
  'واعلموا أن ابتلاءات هذه الدنيا زائلة لا تدوم',
  'وتزودوا فإن خير الزاد التقوى',
];

/**
 * Builds the Deepgram query string. The parameters here are the ones that
 * matter for a sermon specifically:
 *  - endpointing 400ms: a preacher pauses for effect. Too short and we cut
 *    sentences in half; too long and the screen lags behind.
 *  - interim_results: needed so the operator can see it's alive, even though
 *    the audience display only ever shows finalized text.
 *  - keyterm: religious vocabulary the base model has never seen. For a
 *    khutbah this is where names of scholars, transliterated terms and
 *    formulaic phrases go.
 *
 * The `language` value is a Deepgram Arabic code. Nova-3 ships dialect
 * variants; "ar" is the general model and is the right default for a khutbah,
 * which is delivered largely in Modern Standard Arabic. If your speaker
 * drifts into a regional dialect for the informal portions, try the matching
 * regional code and compare on a real recording.
 */
function buildUrl({ language, keyterms = [] }) {
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || 'nova-3',
    language,
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    endpointing: '400',
    utterance_end_ms: '1200',
    filler_words: 'false',
  });

  // keyterm is repeated, not comma-joined. Cap at 100 per Deepgram's limit.
  const url = new URL(`wss://api.deepgram.com/v1/listen?${params}`);
  for (const term of keyterms.slice(0, 100)) {
    url.searchParams.append('keyterm', term);
  }
  return url.toString();
}

class DeepgramSession {
  constructor({ language, keyterms, onTranscript, onStatus }) {
    this.onTranscript = onTranscript;
    this.onStatus = onStatus;
    this.closed = false;

    this.ws = new WebSocket(buildUrl({ language, keyterms }), {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
    });

    this.ws.on('open', () => {
      this.onStatus({ state: 'listening', engine: 'deepgram' });
      // Deepgram closes idle sockets. A silent sermon pause can be long.
      this.keepAlive = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 8000);
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== 'Results') return;

      const alt = msg.channel?.alternatives?.[0];
      const text = (alt?.transcript || '').trim();
      if (!text) return;

      this.onTranscript({
        text,
        isFinal: Boolean(msg.is_final),
        speechFinal: Boolean(msg.speech_final),
        confidence: alt?.confidence ?? null,
      });
    });

    this.ws.on('error', (err) => {
      this.onStatus({ state: 'error', message: err.message });
    });

    this.ws.on('close', () => {
      clearInterval(this.keepAlive);
      if (!this.closed) this.onStatus({ state: 'disconnected' });
    });
  }

  send(chunk) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
  }

  close() {
    this.closed = true;
    clearInterval(this.keepAlive);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
    this.ws.close();
  }
}

class MockSession {
  constructor({ onTranscript, onStatus, scriptSegments }) {
    // If a script is loaded, replay that instead of the canned lines — it
    // makes alignment testing actually meaningful.
    this.lines =
      scriptSegments?.length > 0 ? scriptSegments.map((s) => s.source) : MOCK_LINES;

    this.i = 0;
    onStatus({ state: 'listening', engine: 'mock' });

    this.timer = setInterval(() => {
      const line = this.lines[this.i % this.lines.length];
      this.i += 1;
      onTranscript({ text: line, isFinal: true, speechFinal: true, confidence: 0.95 });
    }, 4500);
  }

  send() {}

  close() {
    clearInterval(this.timer);
  }
}

export function createAsrSession(options) {
  if (process.env.DEEPGRAM_API_KEY) return new DeepgramSession(options);
  console.warn('[asr] No DEEPGRAM_API_KEY — running in mock mode.');
  return new MockSession(options);
}

export function asrEngineName() {
  return process.env.DEEPGRAM_API_KEY ? 'deepgram' : 'mock';
}
