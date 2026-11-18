/**
 * Live Translation — phone display for the Friday khutbah.
 *
 * Reads the same websocket the web display uses, so the server needs no
 * changes. The one thing a phone app needs that a web page doesn't is the
 * server's address: a browser already knows where it loaded from, an app
 * has to be told. That's the setup screen, asked once and remembered.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';

const C = {
  ink: '#14161a',
  parchment: '#f2ede3',
  recede: '#6f757e',
  rule: '#31363f',
  signal: '#7fa88b',
  warn: '#c98a3e',
  scripture: '#c7b285',
};

// Georgia on iOS, the platform serif on Android. Loading a web font would
// mean a splash delay on every launch for very little gain.
const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' });

const MAX_LINES = 4;
const STORAGE_HOST = 'sl-host';
const STORAGE_LANG = 'sl-lang';

/* ------------------------------------------------------------------ *
 * Address handling
 * ------------------------------------------------------------------ */

/**
 * People will type "192.168.1.42:3000", "localhost:3000" or paste a full
 * tunnel URL. Normalise all of it rather than making them get it exact.
 */
function normalizeHost(raw) {
  let s = (raw || '').trim().replace(/\s/g, '');
  if (!s) return null;

  s = s.replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === 'wss://' ? 'https://' : 'http://'));
  if (!/^https?:\/\//i.test(s)) {
    // A bare host with no port almost certainly means a public tunnel, which
    // is https. A host with a port is almost certainly a laptop on the wifi.
    s = (/:\d+$/.test(s) || /^localhost/i.test(s)) ? `http://${s}` : `https://${s}`;
  }

  s = s.replace(/\/+$/, '');
  return s;
}

function wsUrl(host) {
  return `${host.replace(/^http/i, 'ws')}/ws/display`;
}

/* ------------------------------------------------------------------ *
 * Setup screen
 * ------------------------------------------------------------------ */

function Setup({ initial, onSave, error }) {
  const [value, setValue] = useState(initial || '');

  return (
    <View style={s.setupWrap}>
      <Text style={s.setupTitle}>Live translation</Text>
      <Text style={s.setupBody}>
        Enter the address shown in the operator console.
      </Text>

      <TextInput
        style={s.input}
        value={value}
        onChangeText={setValue}
        placeholder="192.168.1.42:3000"
        placeholderTextColor={C.recede}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        onSubmitEditing={() => { Keyboard.dismiss(); onSave(value); }}
      />

      {error ? <Text style={s.setupError}>{error}</Text> : null}

      <Pressable
        style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
        onPress={() => { Keyboard.dismiss(); onSave(value); }}
      >
        <Text style={s.primaryBtnText}>Connect</Text>
      </Pressable>

      <Text style={s.setupHint}>
        On the mosque wifi this is the laptop's address with :3000 on the end.
        A tunnel address ending in trycloudflare.com works from anywhere.
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Display
 * ------------------------------------------------------------------ */

function Line({ line, lang, age }) {
  const text = line[lang];
  if (!text) return null;

  const isVerse = line.origin === 'verse';
  const isManual = line.origin === 'manual';

  // Older lines recede in both size and opacity. Either alone reads as a
  // rendering bug rather than depth.
  const sizes = [30, 21, 17, 15];
  const opacities = [1, 0.45, 0.19, 0.08];

  return (
    <View style={[s.lineWrap, isVerse && s.verseWrap]}>
      <Text
        style={[
          s.line,
          { fontSize: sizes[age] ?? 15, opacity: opacities[age] ?? 0.08 },
          isVerse && s.verse,
          isManual && s.manual,
        ]}
      >
        {text}
      </Text>
      {isVerse && line.ref ? (
        <Text style={[s.ref, { opacity: opacities[age] ?? 0.08 }]}>Qur'an {line.ref}</Text>
      ) : null}
    </View>
  );
}

function Display({ host, onChangeHost }) {
  useKeepAwake();

  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('connecting');
  const [lang, setLang] = useState('fr');
  const [showBar, setShowBar] = useState(true);

  const socketRef = useRef(null);
  const retryRef = useRef(0);
  const timerRef = useRef(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_LANG).then((v) => { if (v) setLang(v); });
  }, []);

  const pickLang = (v) => {
    setLang(v);
    AsyncStorage.setItem(STORAGE_LANG, v).catch(() => {});
  };

  const push = useCallback((line) => {
    if (!line.fr && !line.en) return;
    setLines((prev) => [...prev, line].slice(-MAX_LINES));
  }, []);

  useEffect(() => {
    aliveRef.current = true;

    const connect = () => {
      if (!aliveRef.current) return;

      let socket;
      try {
        socket = new WebSocket(wsUrl(host));
      } catch {
        setStatus('error');
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        retryRef.current = 0;
        setStatus('connected');
      };

      socket.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        switch (msg.type) {
          case 'hello':
            if (Array.isArray(msg.history)) setLines(msg.history.slice(-MAX_LINES));
            setStatus(msg.running ? 'live' : 'standby');
            break;
          case 'line':
            push(msg);
            setStatus('live');
            break;
          case 'session':
            setStatus(msg.running ? 'live' : 'ended');
            if (msg.running) setLines([]);
            break;
          case 'connection':
            setStatus(msg.ok ? 'live' : 'audio');
            break;
          case 'clear':
            setLines([]);
            break;
          default:
            break;
        }
      };

      socket.onerror = () => { try { socket.close(); } catch {} };

      socket.onclose = () => {
        if (!aliveRef.current) return;
        setStatus('reconnecting');
        retryRef.current = Math.min(retryRef.current + 1, 6);
        timerRef.current = setTimeout(connect, 400 * 2 ** retryRef.current);
      };
    };

    connect();

    return () => {
      aliveRef.current = false;
      clearTimeout(timerRef.current);
      try { socketRef.current?.close(); } catch {}
    };
  }, [host, push]);

  const statusText = {
    connecting: 'Connecting',
    connected: 'Connected',
    live: 'Live',
    standby: 'Standing by',
    ended: 'Ended',
    audio: 'Reconnecting to audio',
    reconnecting: 'Reconnecting',
    error: 'Cannot reach the server',
  }[status] || status;

  const dotColour =
    status === 'live' ? C.signal
    : status === 'reconnecting' || status === 'audio' || status === 'error' ? C.warn
    : C.recede;

  const visible = lines.filter((l) => l[lang]);

  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Pressable style={s.stagePress} onPress={() => setShowBar((v) => !v)}>
        {visible.length === 0 ? (
          <View style={s.idle}>
            <Text style={s.idleTitle}>Live translation</Text>
            <Text style={s.idleNote}>
              {status === 'live' ? 'Listening' : 'Waiting for the khutbah to begin'}
            </Text>
          </View>
        ) : (
          <ScrollView
            style={s.stage}
            contentContainerStyle={s.stageContent}
            showsVerticalScrollIndicator={false}
          >
            {visible.map((line, i) => (
              <Line
                key={line.id ?? i}
                line={line}
                lang={lang}
                age={visible.length - 1 - i}
              />
            ))}
          </ScrollView>
        )}
      </Pressable>

      {showBar ? (
        <View style={s.bar}>
          <View style={[s.dot, { backgroundColor: dotColour }]} />
          <Text style={s.status}>{statusText}</Text>

          <View style={s.spacer} />

          {['fr', 'en'].map((code) => (
            <Pressable
              key={code}
              onPress={() => pickLang(code)}
              style={({ pressed }) => [
                s.chip,
                lang === code && s.chipOn,
                pressed && s.pressed,
              ]}
            >
              <Text style={[s.chipText, lang === code && s.chipTextOn]}>
                {code === 'fr' ? 'FR' : 'EN'}
              </Text>
            </Pressable>
          ))}

          <Pressable
            onPress={onChangeHost}
            style={({ pressed }) => [s.chip, pressed && s.pressed]}
          >
            <Text style={s.chipText}>Server</Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */

export default function App() {
  const [host, setHost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_HOST)
      .then((v) => { if (v) setHost(v); })
      .finally(() => setLoading(false));
  }, []);

  const save = async (raw) => {
    const normalized = normalizeHost(raw);
    if (!normalized) {
      setError('Enter the address first.');
      return;
    }

    // Check the server is actually there before storing it, so a typo fails
    // here with a clear message rather than as a silent dead screen.
    try {
      const res = await fetch(`${normalized}/api/health`);
      if (!res.ok) throw new Error(String(res.status));
      await res.json();
    } catch {
      setError(`Nothing answered at ${normalized}. Check the address and that the laptop is running the app.`);
      return;
    }

    setError('');
    setHost(normalized);
    setEditing(false);
    AsyncStorage.setItem(STORAGE_HOST, normalized).catch(() => {});
  };

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
        <ActivityIndicator color={C.recede} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {!host || editing ? (
        <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
          <Setup initial={host} onSave={save} error={error} />
        </SafeAreaView>
      ) : (
        <Display host={host} onChangeHost={() => { setError(''); setEditing(true); }} />
      )}
    </SafeAreaProvider>
  );
}

/* ------------------------------------------------------------------ */

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.ink },
  centre: { alignItems: 'center', justifyContent: 'center' },

  stagePress: { flex: 1 },
  stage: { flex: 1 },
  stageContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },

  lineWrap: { marginBottom: 14 },
  verseWrap: {
    borderLeftWidth: 2,
    borderLeftColor: C.scripture,
    paddingLeft: 12,
  },

  line: {
    fontFamily: SERIF,
    color: C.parchment,
    lineHeight: 36,
  },
  verse: { color: C.scripture, fontStyle: 'italic' },
  manual: { color: C.signal },

  ref: {
    color: C.scripture,
    fontSize: 11,
    letterSpacing: 1.2,
    marginTop: 6,
  },

  idle: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  idleTitle: { fontFamily: SERIF, fontSize: 28, color: C.parchment, marginBottom: 10 },
  idleNote: { fontSize: 13, color: C.recede, letterSpacing: 0.4 },

  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.rule,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  status: { color: C.recede, fontSize: 12 },
  spacer: { flex: 1 },

  chip: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.recede,
  },
  chipOn: { backgroundColor: C.parchment, borderColor: C.parchment },
  chipText: { color: C.recede, fontSize: 12 },
  chipTextOn: { color: C.ink },
  pressed: { opacity: 0.6 },

  setupWrap: { flex: 1, justifyContent: 'center', padding: 28 },
  setupTitle: { fontFamily: SERIF, fontSize: 30, color: C.parchment, marginBottom: 10 },
  setupBody: { color: C.recede, fontSize: 14, marginBottom: 22, lineHeight: 21 },

  input: {
    borderWidth: 1,
    borderColor: C.rule,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: C.parchment,
    fontSize: 16,
    marginBottom: 14,
  },

  setupError: { color: C.warn, fontSize: 13, marginBottom: 14, lineHeight: 19 },

  primaryBtn: {
    backgroundColor: C.signal,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: { color: C.ink, fontSize: 16, fontWeight: '500' },

  setupHint: { color: C.recede, fontSize: 12, lineHeight: 18, marginTop: 20 },
});
