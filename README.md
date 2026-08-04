# Console

An AirConsole-compatible party-game platform. The browser on a TV or laptop is the shared game
screen; phones are the controllers. No installs on either side — open a room, players scan a QR
code or type a 4-character code, and the first player in picks the game.

## How it fits together

```
screen (index.html)                    phone (play.html?room=CODE)
  └─ createRoom() ──► Cloud Function     └─ claims a device slot (1, 2, 3…)
  └─ takes device slot 0                 └─ lowest connected slot = MASTER
  └─ follows the room's `home` URL       └─ master browses the store, picks a game
        └─ iframe + sdk.js                     └─ iframe + sdk.js
```

The session model is **AirConsole's**, so [their API docs](https://airconsole.github.io/airconsole-api/)
largely apply. Three ideas carry it:

- **Device slots.** Every device holds a number for the life of the room; the screen is always
  `0` (`AirConsole.SCREEN`). A device keeps its slot across disconnect and reconnect.
- **Location.** Each device records the URL it is on. "Who is in my game" is just "who shares my
  location", which is what makes `onConnect`/`onDisconnect` mean *entered or left this game*.
- **Derived master.** The master controller is the **lowest-numbered connected controller**,
  computed on read. There is no stored host field — when the master leaves, the next controller
  simply *is* the master, with no write, no race, and no migration step.

Navigation is the entire state machine: `navigateTo(url)` writes the room's `home` and every
device follows. The store is just another location, not a special "lobby phase".

One Firebase project, game-agnostic: it stores device slots, presence, and generic messages, and
has no idea which game is running. The screen runs the game loop; phones send input.

**The one deliberate difference from AirConsole:** it navigates the whole page to a game URL. We
load games in a sandboxed iframe and relay over `postMessage`, so a third-party game never
touches our Firebase session. Games cannot tell the difference — `sdk.js` is all they see.

## Layout

| Path | What it is |
| --- | --- |
| `public/index.html` | Screen: opens a room, renders the store, hosts the game frame fullscreen. |
| `public/play.html` | Phone: joins, acts as the store remote, hosts the controller frame fullscreen. |
| `public/sdk.js` | The one SDK every game includes. The only API a game codes against. |
| `public/relay.js` | Holds the Firebase connection; relays postMessage ⇄ RTDB. |
| `public/room.js` | Device slots, presence, derived master, navigation, messaging. |
| `public/session.js` | Shared shell logic: claim a slot, follow `home`, swap the game frame. |
| `public/qr.js` | Renders the join QR (encoder vendored in `public/vendor/`). |
| `public/games/tapwar/` | Test game: `screen.html` + `controller.html`. |
| `public/signup.html` | Catalog editor, behind email/password login + an `admin` claim. |
| `functions/index.js` | `createRoom` + the stale-room sweep. |
| `database.rules.json` | RTDB security rules. |
| `firestore.rules` | Catalog is world-readable, writable only by an `admin`-claim account. |

## Data

RTDB holds live state; Firestore holds the slow-moving catalog.

```
/rooms/{code}/
  home                       ← the URL every device follows. This IS the navigation state.
  createdAt                  ← written by createRoom; never client-writable
  uids/{uid}: slot           ← claim-once, so device ids survive a reconnect
  devices/{slot}/            ← slot 0 is always the screen
    location                 ← which URL this device is on
    connected                ← onDisconnect-managed
    joinedAt, nickname
    custom                   ← custom DeviceState: readable by every device
    playerNumber             ← set by setActivePlayers(), screen only
  messages/{id}              ← { from, to, data, at }; to: null is a broadcast

/games/{gameId}   name, description, minPlayers, maxPlayers, screenUrl, controllerUrl
```

There is deliberately **no host field**. `connected` is managed by RTDB `onDisconnect()`, so a
backgrounded tab or dropped wifi flips it immediately, and the derived master updates itself.

## Writing a game

A game is static files that only call the SDK. The API is AirConsole's:

```js
var airconsole = new AirConsole();

airconsole.onReady = function (code) {
  // Also fires onConnect for devices already here, and onCustomDeviceStateChange for
  // any that already published state — so late joiners self-sync.
  if (airconsole.getDeviceId() === AirConsole.SCREEN) airconsole.setActivePlayers();
};

airconsole.onConnect    = function (device_id) {};
airconsole.onDisconnect = function (device_id) {};
airconsole.onMessage    = function (device_id, data) {};

airconsole.message(AirConsole.SCREEN, { ... });   // to one device
airconsole.broadcast({ ... });                    // to everyone

airconsole.getControllerDeviceIds();
airconsole.getMasterControllerDeviceId();         // derived, not stored
airconsole.setCustomDeviceState({ ... });         // late-joiner-safe state
airconsole.navigateTo("/games/other/");           // move the whole room
airconsole.navigateHome();                        // back to the store
```

Prefer `setCustomDeviceState()` over `broadcast()` for anything a late joiner needs: custom
state is replayed to devices that arrive afterwards, a broadcast is not.

Rules: never import Firebase, never assume how you were loaded, keep the folder
self-contained. Add the game to the catalog from `/signup.html`.

## Running it

```bash
pnpm install
pnpm --dir functions install   # functions installs separately; Firebase deploys it standalone
pnpm dev                       # http://localhost:3000
```

`pnpm dev` is a plain static server for `public/` — **no emulators**. Pages talk to the live
Firebase project, so what you see is what players get, and rooms you create are real rooms.

Cloud Functions run in the cloud, so `createRoom` and the admin functions only work once
deployed:

```bash
pnpm deploy:functions   # after editing functions/
pnpm deploy:hosting     # after editing public/
pnpm deploy:rules       # after editing firestore.rules or database.rules.json
pnpm deploy             # everything
```

Tests do use the emulators (that's the point — they must not touch live data), which need
**JDK 21+**; the scripts pin `JAVA_HOME` themselves:

```bash
pnpm test          # rules (33) + room lifecycle (22) + admin auth (27)
```

`pnpm seed` writes a baseline catalog straight to the live project. It's the one thing still
needing Google Application Default Credentials — separate from your Firebase CLI login, so the
CLI can look fine while these are broken, surfacing as `invalid_grant`. Fix with
`gcloud auth application-default login`, or skip it and use `/signup.html` instead.

## Editing the catalog

Open **`/signup.html`** and sign in with email and password. That one page is both the account
screen and the catalog editor: sign in and you get the catalog, with no admin claim you get told
so.

Admins are ordinary Firebase Auth accounts carrying an `admin: true` custom claim.
`firestore.rules` checks that claim on every write to `/games`, so the page talks to Firestore
directly — no local server, no gcloud credentials.

**The first admin:** while no admin exists, the sign-up tab shows a "claim admin access"
checkbox. Tick it, create your account, and you own the catalog. From then on the checkbox is
gone and `claimFirstAdmin` refuses every later claim — including someone calling the function
directly with the page bypassed, which is what the tests actually assert. Further admins are
added by email ("Grant admin"), which requires an existing admin.

Enable **Email/Password** in Firebase console → Authentication → Sign-in method before first use;
it's off by default. Anonymous must stay enabled too — that's how players join.

## Playing across devices

The dev server binds `0.0.0.0` on port **3000**, so phones on the same wifi can reach it. Open
the catalog on the big screen using the machine's **LAN IP**, not localhost — e.g.
`http://192.168.1.12:3000`; the server prints the right address on startup.

The QR encodes `location.origin`, so a screen opened at the LAN IP produces a join URL phones
can actually resolve. Opening it at `localhost` produces a QR that only works on that one
machine.

## Notes

- The QR encoder is the `qrcode` package bundled to one self-contained ESM file by
  `scripts/build-vendor.sh`, so the shell loads no third-party code at runtime. It is
  vendored rather than hand-written because a subtly wrong QR renders fine and scans not at
  all — `scripts/` includes a decode test for exactly this reason.
- Room codes come from a 29-character alphabet with ambiguous glyphs (I/1, O/0, S/5, B/8)
  removed, generated with crypto randomness and claimed via an RTDB transaction.
- Game iframes are sandboxed to `allow-scripts`, so they get a null origin and cannot reach
  into the shell; the relay authenticates them by `event.source` identity.
- Gen-2 callable functions are Cloud Run services, and Cloud Run **denies unauthenticated
  invocation by default**. The browser then gets a 403 from Google Frontend before the
  function runs, which surfaces misleadingly as a CORS error (*"No 'Access-Control-Allow-Origin'
  header is present"*) — a rejected request has no CORS headers to return. Fix with
  `./scripts/allow-public-invoke.sh`, which `pnpm deploy:functions` now runs automatically.
  It only lets requests *reach* the functions; each one still checks `request.auth` or the
  `admin` claim itself. Re-run it after adding a new callable.
- `vercel.json` pins `Content-Type: application/manifest+json` on `/manifest.webmanifest`.
  Some CDNs serve `.webmanifest` as `octet-stream`, which makes the browser ignore the
  manifest and silently refuse to install the PWA. It stays revalidating so an icon or name
  change ships without waiting out a cache. Note that `vercel.json` is schema-validated and
  rejects unknown keys, so this can't be explained in a `"//"` comment beside the rule.
- `functions/package.json` carries two dependencies nothing imports. Don't prune either:
  - `@firebase/app` — `firebase-admin`'s RTDB path pulls in `@firebase/database-compat`,
    which declares it as a *peer* dependency. npm auto-installs peers, pnpm doesn't, and
    without it the runtime fails with `Cannot find module '@firebase/app'`.
  - `@google-cloud/functions-framework` — the Cloud Functions buildpack injects this
    automatically for npm projects but refuses to for pnpm ones, failing the deploy build.
