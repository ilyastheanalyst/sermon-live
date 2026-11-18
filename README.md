# sermon-live

Live translation of the Friday khutbah from **Arabic into French and English**,
displayed on a screen. It never speaks; it only shows text.

People choose their own language on their phone. The projector shows both side
by side.

Two modes:

- **Live** — listens and translates as the imam speaks. Nothing to prepare.
- **Script** — you supply the khutbah in advance, it gets translated and
  proofread before Friday, and the app tracks where the speaker is. Falls back
  to live translation the moment he goes off script.

## What's in here

- The server and the web display, at the root. This is the whole app.
- `mobile/` — an optional Expo client for phones. Not needed: the web display
  installs to a phone's home screen on its own.

---

## Scripture is not machine translated

A khutbah quotes the Qur'an constantly, and generating a fresh machine
translation of scripture is both less accurate and not something this app
should be doing. The Qur'an Foundation makes the same point in their own API
docs: re-translating an already vetted translation introduces serious semantic
errors.

So the pipeline checks for scripture **before** it reaches any translator:

1. **Is it a Qur'anic quotation?** → serve the established translation
   (Hamidullah in French, Saheeh International in English), labelled on screen
   with its reference. Never machine translated, and not editable in the console.
2. **Is it on the prepared script?** → serve the rendering a human approved
   this week.
3. **Otherwise** → live machine translation into both languages.

Verses live in `config/verses.json`. Eight commonly quoted passages ship with
it; add more with `scripts/fetch-verses.js` (below). Matching is deliberately
strict — a false positive would put the wrong verse on a screen in front of the
congregation, which is much worse than missing one and translating a normal
sentence.

---

## Run it now, with no API keys

```bash
npm install
cp .env.example .env
npm start
```

Open <http://localhost:3000/control.html>, sign in with `change-me`, press
**Start**. With no keys set the app runs in mock mode: it emits Arabic
transcripts on a timer so you can watch the whole pipeline — including verse
detection — before signing up for anything.

Open <http://localhost:3000/?lang=both> in another window to see the projector view.

Run the test suite, which needs no keys and no network:

```bash
node scripts/test-pipeline.js
```

It checks that Arabic spelling variants collapse to one form, that real
quotations are recognised, that ordinary sermon prose is *not* mistaken for
scripture, and that script alignment survives a speaker ad-libbing and skipping
ahead.

## Then add the services

| Key | Where | Cost |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | [console.deepgram.com](https://console.deepgram.com) | $200 free credit, no card. A 30-minute khutbah is about 25¢. |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | A few cents per khutbah on Haiku. |

**On translation provider:** set `TRANSLATE_PROVIDER=claude`. Arabic into
French and English at sermon register is precisely where generic machine
translation is weakest — it flattens homiletic register and renders Islamic
terminology into church vocabulary. An LLM with a register instruction handles
it better and returns both languages from one call. `deepl` and `google` are
supported if you'd rather; `none` passes the Arabic through untranslated, which
is useful for confirming recognition works before adding a second key.

**On Arabic recognition:** Deepgram added Nova-3 Arabic in January 2026 with
dialect variants, and reports roughly 40% lower word error rate than
competitors — though that benchmark is their own, and at least one competitor
publishes rankings that place them lower. Record ten minutes of your actual
imam and compare `ar`, `ar-MA`, and a second vendor before committing. Accent,
room, and microphone matter more than vendor marketing.

**Change `OPERATOR_PASSWORD`** before this touches a network.

---

## Friday morning

1. **Plug in the audio.** A line out from the sound system's mixer into the
   laptop, not a microphone in the room. This affects accuracy more than
   anything else in this file. A room mic picks up echo off hard surfaces and
   roughly doubles the error rate.
2. Open the console, select that input, and watch the level meter while someone
   speaks. If it isn't moving, nothing downstream matters.
3. Choose the mode and press **Start**.
4. Put `/?lang=both` on the projector. Share the plain address for phones —
   each person picks French or English and their own text size, remembered on
   their device.

Keep the console open in front of you. It shows what the recogniser is hearing
in Arabic, so you can tell "the system is broken" apart from "he stopped
talking." Each line is tagged with how it was produced: gold for scripture from
the verse library, green for a matched script line, amber for off-script
fallback.

## Preparing a khutbah in advance

1. Paste the Arabic into the console, blank line between paragraphs.
2. Press **Split and translate**. Quotations are filled from the verse library
   and marked with a badge; everything else is machine translated once, now.
3. **Read it and fix what's wrong.** This review is the whole reason script
   mode exists. Verse lines are locked — to change one, edit
   `config/verses.json`.
4. Friday, choose "Follow the prepared khutbah" and start.

If the tracker loses him, click a line number to jump it. It recovers by itself
after a few seconds, but the manual jump is faster.

## Growing the verse library

```bash
node scripts/fetch-verses.js 2:153 65:2-3 103:1-3
node scripts/fetch-verses.js --surah 103
```

Pulls Uthmani Arabic plus the Hamidullah and Saheeh International translations,
merges into `config/verses.json`, and de-duplicates by reference. Run it ahead
of time — the library is read from disk at startup, so nothing external is
touched during the sermon.

Worth loading: whatever your imam quotes most, and the standard khutbah
openings. The bigger the library, the less scripture falls through to machine
translation.

## Tuning

| File | What it does |
| --- | --- |
| `config/verses.json` | Scripture and its established translations |
| `config/vocabulary.json` | Terms fed to the recogniser as context — scholars' names, formulaic phrases, transliterations. Cap 100. |
| `config/glossary.json` | Per-language find-and-replace after translation, for when the output is correct but conventionally wrong |

All three load at startup; restart after editing.

Thresholds, if you need them: `VerseMatcher` in `lib/arabic.js` defaults to
`0.62` — raise it if scripture is being detected in ordinary speech, which is
the failure that matters. `ScriptAligner` in `lib/aligner.js` defaults to
`0.42` — lower it if the app keeps falling back to live translation while he is
clearly reading.
---

## Putting it on a phone

The display installs to the home screen as an app — its own icon, full screen,
no browser bars. No app store, no $99, no review.

**One-time setup.** From the project folder:

```bash
node scripts/make-icons.js
```

That draws the app icons. Run it once.

**Then you need an HTTPS address**, because browsers only allow home-screen
install over a secure connection. The quickest way, free and with no account:

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

Leave `npm start` running in one terminal tab and that command in another. It
prints a public `https://....trycloudflare.com` address that works from any
phone, anywhere.

**On the phone:**

- **iPhone:** open the address in Safari — it must be Safari, Chrome on iOS
  can't do this — then tap Share and *Add to Home Screen*. The app prompts you.
- **Android:** open in Chrome and tap *Install* when it appears, or use the
  menu's *Add to Home screen*.

It then opens like any other app. Each person picks French, English or both,
and their choice and text size are remembered on their own device.

Over local wifi with no tunnel, the display still works at
`http://<laptop-ip>:3000` — people just can't install it to the home screen.
For a projector in the room, that's fine.

### What it does as an installed app

- Opens full screen with no browser chrome
- Keeps the screen awake through the khutbah
- Caches its shell, so it opens instantly and shows "Reconnecting" rather than
  a browser error page when the wifi drops
- Reconnects on its own when the network returns

The words themselves are never cached — they arrive live over the websocket.

### Changing the name or icon

The name under the home-screen icon comes from `short_name` in
`public/manifest.json`. Edit it, then bump `VERSION` at the top of
`public/sw.js` so phones that already installed it pick up the change.

For the icon, edit the colours or row lengths near the top of
`scripts/make-icons.js` and run it again.


---

## Things that will bite you

**Latency.** 2–4 seconds behind the speaker, and longer for the first line
after a pause. That's normal and readable.

**Flicker.** The audience display only ever shows finalised text. Interim
recognition results rewrite themselves constantly and are unreadable across a
hall; the console shows them so you can still see it's alive.

**Classical Arabic.** Recognisers are trained mostly on conversational speech.
The formal, heavily inflected register of a khutbah — and especially recited
Qur'an — is harder for them than everyday Arabic. This is the main reason the
verse library exists: recitation is where recognition is weakest and accuracy
matters most, so it's handled by matching rather than transcription.

**Code-switching.** If your imam moves between Arabic and French mid-sentence,
a monolingual Arabic model will drop the French. Deepgram has a multilingual
mode; test it against your recording before relying on it.

**Network loss.** You go dark. Keep a phone hotspot ready. To run fully
offline, replace `lib/asr.js` with a local `faster-whisper` server — the
interface is small, roughly "call `onTranscript` with `{text, isFinal}`."

**Cost.** Streaming bills per minute of audio including silence. Press **Stop**
when the khutbah ends.

---

## Layout

```
mixer → browser (control) → ws → server ─┬→ Deepgram        Arabic speech → text
                                         ├→ verse matcher   scripture → canonical FR/EN
                                         ├→ script aligner  [script mode]
                                         ├→ Claude/DeepL    everything else → FR + EN
                                         └→ ws → every display
```

| File | Role |
| --- | --- |
| `server.js` | Session state, websockets, the routing decision above |
| `lib/arabic.js` | Arabic normalisation, verse matching, segmentation |
| `lib/asr.js` | Deepgram streaming, plus the mock engine |
| `lib/translate.js` | Claude / DeepL / Google, both targets, glossary |
| `lib/aligner.js` | Script position tracking |
| `public/index.html` | The display |
| `public/control.html` | The operator console |
| `scripts/test-pipeline.js` | Verse matching and alignment tests |
| `scripts/make-icons.js` | Draws the home-screen icons |
| `public/manifest.json` | Home-screen name, icon and colours |
| `public/sw.js` | Offline shell and reconnect behaviour |
| `scripts/fetch-verses.js` | Grow the verse library |

## On a real network

For one room, run it on the laptop and let phones reach it over the venue wifi
at `http://<laptop-ip>:3000` (`ipconfig getifaddr en0` on macOS, `hostname -I`
on Linux).

Beyond that, put it behind a reverse proxy with TLS. Browsers refuse microphone
access on plain `http://` for anything but `localhost`, so the operator console
will not work over an insecure connection from another machine.
