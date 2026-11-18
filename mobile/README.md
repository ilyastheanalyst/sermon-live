# Live Translation — phone app

The khutbah display as a real app on your phone, running through Expo Go.
No App Store, no Apple Developer account, no $99.

It reads the same websocket the web display uses, so **the server needs no
changes**. Keep running `npm start` in the `sermon-live` folder exactly as
before; this is just another client connecting to it.

---

## One important constraint before you start

Expo Go on iPhone is currently capped at **SDK 54** — the SDK 55 build has been
waiting on Apple's approval since May 2026 with no timeline. So the project
must be created against SDK 54 or your phone won't run it.

`create-expo-app` asks which you want. **Choose the App Store compatible
version**, not the latest.

---

## Setup

Do this from your home folder, not inside the `sermon-live` folder — this is a
separate project.

**1. Create the project.**

```bash
cd ~/Downloads
npx create-expo-app sermon-live-app --template blank
```

When it asks about the SDK version, pick the **App Store compatible** option.

**2. Add the three packages it needs.**

```bash
cd sermon-live-app
npx expo install @react-native-async-storage/async-storage expo-keep-awake react-native-safe-area-context
```

Use `npx expo install`, not `npm install` — it picks versions that match your
SDK instead of the newest ones, which is the usual cause of a blank screen.

**3. Replace two files** with the ones from this folder: `App.js` and
`app.json`. Overwrite what the scaffold created.

**4. Start it.**

```bash
npx expo start
```

A QR code appears in the terminal.

**5. On your phone:** install **Expo Go** from the App Store, then point the
Camera app at the QR code and tap the banner. On Android, scan it from inside
Expo Go.

Your phone and laptop must be on the same wifi for the QR code to work.

---

## First run

The app asks for the server address, once, and remembers it.

- **Same wifi as the laptop:** the laptop's address with the port — something
  like `192.168.1.42:3000`. Find it with `ipconfig getifaddr en0` on the
  laptop.
- **From anywhere:** a tunnel address, like
  `brave-cat-sings.trycloudflare.com`. Run
  `cloudflared tunnel --url http://localhost:3000` on the laptop to get one.

Type it however you like — with or without `http://`, with or without a
trailing slash. It sorts that out. It also checks the server actually answers
before saving, so a typo tells you immediately instead of leaving you on a
dead screen.

To change it later, tap **Server** in the bottom bar.

## Using it

- **FR / EN** in the bottom bar switches language. Your choice is remembered.
- **Tap the screen** to hide or show the bar.
- The screen stays awake while the app is open.
- If the wifi drops it reconnects on its own, backing off so it doesn't hammer
  the server.

Scripture appears in gold italic with its reference, the same as the web
display — served from established translations, never machine translated.

---

## When something is wrong

**"Nothing answered at ..."** on the setup screen — the address is wrong, the
laptop isn't running `npm start`, or the phone is on a different wifi. The
error names the address it tried, so check that first.

**QR code won't scan** — phone and laptop must be on the same network. On a
network that blocks devices from seeing each other (common on guest wifi), run
`npx expo start --tunnel` instead.

**Blank white screen after it loads** — nearly always a package version that
doesn't match the SDK. Run `npx expo install --fix` and restart.

**"Project is incompatible with this version of Expo Go"** — the project was
created against a newer SDK than your Expo Go. Delete the folder and scaffold
again, choosing the App Store compatible version.

---

## What this is and isn't

This runs through Expo Go, which is Expo's own app. That's why it needs no
Apple account and costs nothing — you're not publishing anything, you're
loading your project into an app that's already approved.

It also means your phone needs Expo Go installed, and the laptop needs to be
running `npx expo start` for the app to load. For testing and for a small group
who don't mind that, it's ideal.

Putting it on the App Store as its own app is a different job: a $99/year Apple
Developer account, a review process, and a publicly hosted backend, since an
app downloaded by a stranger can't reach a laptop on your wifi. Worth doing
only once you know you're keeping this.

The `package.json` here lists the versions this was written against, for
reference. Prefer `npx expo install` over copying it.
