# Notifications live test

Everything in notifications v2 is covered by unit tests, the RFC's
conformance vectors, and an in-process Worker with a fake FCM. None of it
proves that a phone shows a push. This runbook is the first live run, made
repeatable: a game-services Worker on your machine sends through the real
Firebase Cloud Messaging (FCM) HTTP v1 API to a game on an Android
emulator, and you check each step from the permission dialog to the tap
that opens the game.

The kit gives you three things for it:

- `pnpm notifications:live env`: writes the Worker's env file from your
  game's catalog and your Firebase key, outside every git checkout.
- `pnpm notifications:live emulator`: checks the emulator and forwards the
  Worker's port to it.
- `pnpm notifications:live run`: the server half. It calls the Worker's
  notification routes as a test player, prints each answer, checks the
  status the contract expects, and runs the scheduler.

`pnpm notifications:live dry-run` runs the same driver against the Worker
in process with a fake FCM endpoint. CI runs it with the Worker's tests, so
the kit does not rot between live runs.

<!-- @link ../tools/notifications-live/driver.ts#runNotificationsLiveDriver The driver's steps and expected statuses. -->
<!-- @link ../apps/game-services-worker/src/notificationsHandler.ts#createNotificationsFetchHandler The session routes the driver calls. -->

## Ground rules

- **Your credentials stay on your machine.** The Firebase service-account
  key, `google-services.json`, and the env file are yours: keep them out of
  every repository, and never paste them into an issue, a PR, or an agent
  session. The kit reads the key only to write the env file (mode 0600), and
  refuses to write that file inside any git checkout or through a symbolic
  link. It never reads mise's configuration (`~/.config/mise`,
  `$XDG_CONFIG_HOME/mise`, `$MISE_CONFIG_DIR`).
- **Use a Firebase project for testing**, not the one your released game
  sends from, and test players only.
- **The driver refuses a Worker that is not on this machine**, unless you
  name its host with `--staging <host>` and the host has a test label
  (`staging`, `dev`, `test`, `qa`, `sandbox`, `preview`, ...), as in
  `game-services-staging.example.workers.dev`. It never runs against a
  production Worker, and it does not follow redirects.
- **Local development sessions are not authentication.** The Worker's
  `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS` flag accepts
  `Authorization: Bearer mpgd-dev.<playerId>.<sessionId>.<installationId>`
  from anyone who can reach it. Bind the Worker to `127.0.0.1` only.

> **Needs D1.** The local session flag and the starter's development
> session helper land in D1 (stable session-family id and local
> development notification sessions). Until it is merged, the Worker
> answers 404 on the session routes and `run` stops at
> `session-required` with that hint. Everything else on this page works
> today.

## What you need

| Item | Where it goes | Notes |
| --- | --- | --- |
| A Firebase project for testing, with an Android app (and an iOS app for iOS) | Firebase console | The Android package id is your shell's `--app-id`. |
| `google-services.json` | `apps/mobile-capacitor/android/app/` in the game | See the [Firebase setup guide](FIREBASE_NOTIFICATIONS.md#3-android). |
| A service-account key (JSON) that may send through FCM | A file outside every repository, such as `~/.mpgd/firebase-live-test.json` | *Firebase Cloud Messaging API Admin* role ([Firebase setup](FIREBASE_NOTIFICATIONS.md#5-the-worker)). |
| An Android emulator image **with Google Play services** | Android Studio's Device Manager | A "Google APIs" or "Google Play" image, API 33 or later so the runtime permission dialog shows. An AOSP image has no Play services and FCM cannot deliver. |
| A game created with `--providers notifications` | Outside the kit's checkout | The kit's reference shell (`apps/mobile-capacitor`) bundles no notification plugin. |
| Optional: an iPhone, an APNs key uploaded to Firebase, and `GoogleService-Info.plist` | Apple Developer account, Firebase console, the iOS project | See [iOS](#ios). |

The kit's own checkout needs `pnpm install` and `pnpm build:packages`.

## 1. The game

Create a game outside the kit's checkout and its Capacitor shell once (see
[Getting started](NOTIFICATIONS.md#getting-started) and
[Game development](GAME_DEVELOPMENT.md)):

```sh
# from the kit's checkout
pnpm mpgd game create ~/mpgd-live/live-push --title "Live Push" \
  --providers notifications --kit-path .
cd ~/mpgd-live/live-push
pnpm install
pnpm exec mpgd target init capacitor --game . \
  --app-id dev.example.livepush --display-name "Live Push" \
  --providers notifications
```

Then, in the game:

1. Put `google-services.json` at
   `apps/mobile-capacitor/android/app/google-services.json`.
2. Replace `REPLACE-WITH-SENDER-PHONE-OR-ADDRESS` in
   `notifications/deployment.json` (a test value is fine for a local run).
   The Worker refuses the placeholder and answers 500
   `NOTIFICATIONS_CONFIGURATION_REQUIRED`.
3. Run `pnpm validate:notifications`.
4. Set the game's development session (D1's starter helper) to a test
   player id, such as `live-1`, and point the game at the local Worker with
   `VITE_MPGD_GAME_SERVICES_URL=http://127.0.0.1:8787`. Use the same player
   id with `run` below: the device and the driver must be the same player.

## 2. The Worker's env file

From the kit's checkout:

```sh
mkdir -p ~/.mpgd
pnpm notifications:live env \
  --game ~/mpgd-live/live-push \
  --service-account ~/.mpgd/firebase-live-test.json \
  --out ~/.mpgd/notifications-live.env
```

It validates the catalog against the deployment, checks that the key is a
service-account key (naming a missing field, never a value) and that its
project id is one the Worker's FCM sender accepts, and writes
`MPGD_STORE`, the local session flag, `MPGD_NOTIFICATIONS_CATALOG`,
`MPGD_NOTIFICATIONS_DEPLOYMENT`, and `FCM_SERVICE_ACCOUNT` to `--out` with
mode 0600. It refuses an `--out` inside a git checkout (a dotfiles
repository in your home counts), a symbolic link, and an existing file
unless you pass `--force`. `--project-id` writes `FCM_PROJECT_ID` when the
key's project differs from the Firebase project.

## 3. The Worker

`wrangler dev` on the Worker's sources does not run the typia transform the
kit's packages need, so serve the built Worker:

```sh
pnpm build:packages
pnpm --dir apps/game-services-worker build
pnpm --dir apps/game-services-worker exec wrangler dev \
  -c dist/mpgd_game_services/wrangler.json \
  --env-file ~/.mpgd/notifications-live.env \
  --ip 127.0.0.1 --port 8787
```

wrangler lists the five variables as `(hidden)`. The Worker logs once that
it uses the memory store: consent records, endpoints, and reminders live in
this process and are gone when you stop it. There is no store dump route;
the driver's reads (`GET /consent`, `GET /notices`) and the Worker log are
how you see the state. `wrangler dev` does not run crons on its own; the
driver runs the scheduler through `GET /cdn-cgi/handler/scheduled`.

Check the Worker before the device:

```sh
pnpm notifications:live run --player live-1 --no-scheduler
```

`providers` must pass with `android -> fcm`. Without D1 the run stops at
`session-required` (404).

## 4. The emulator

Start the emulator, then check it and forward the Worker's port, so the
app reaches `http://127.0.0.1:8787` on the device:

```sh
pnpm notifications:live emulator --app-id dev.example.livepush --reverse
```

It checks one device online and booted, Google Play services
(`com.google.android.gms`), the Play Store app, that the game is
installed, the `POST_NOTIFICATIONS` permission (API 33+), and
`adb reverse`. It reads through `adb`, sets only that one port forward, and
never grants a permission: the dialog must come from a tap in the game.

Install and run the game on the emulator with Capacitor's live reload, so
the game runs as a Vite development build (D1's development session helper
works only there) and can reach the Worker:

```sh
# in the game
pnpm exec mpgd target build android staging --targets-file ./mpgd.targets.json
pnpm dev                              # serves the game on port 5173
adb reverse tcp:5173 tcp:5173
cd apps/mobile-capacitor
pnpm exec cap run android --live-reload --host 127.0.0.1 --port 5173
```

Follow the app with
`adb logcat -v time Capacitor:V Capacitor/Console:V FirebaseMessaging:V '*:S'`
(the `emulator` command prints it for your serial).

## 5. The walkthrough

Keep the Worker log, `adb logcat`, and the emulator in view. Each row says
what to do, what to observe, and where.

| Step | Do | Observe |
| --- | --- | --- |
| Permission | Open the game's notification settings and tap *Turn on notifications* (알림 켜기). Allow the dialog. | The Android dialog appears only after the tap. Worker log: `POST /game-services/notifications/consent 200` (the granted report). |
| Register | Nothing: the runtime registers after the grant. | Worker log: `POST /game-services/notifications/endpoints 200`. logcat: no `FirebaseMessaging` error. |
| Consent | Turn the *daily-ready* reminder on in the settings screen. | Worker log: `POST .../consent 200`. The switch shows the backend record after it reloads. |
| Driver | `pnpm notifications:live run --player live-1` | `device-permission PASS` (the device's grant), then `topic-preference`, `reminder-cancel`, and `reminder` pass. |
| Scheduler send | Send the app to the background before the driver's wait ends (5 s; `--fire-in` sets it). | `scheduler PASS`: the scheduler took the reminder. Worker log: no `Notifications: provider.send` error. The push shows in the shade. |
| Open | Tap the push. | The game opens at the topic's route (`/?entry=continue` for `daily-ready`). Repeat with the app killed (cold start) and in the background (warm start). |
| Foreground | Run the driver again with the app in front. | The push is shown while the game is open (it needs `presentationOptions`, see the [Firebase setup](FIREBASE_NOTIFICATIONS.md#1-the-plugins)). |
| Notices (optional) | `pnpm notifications:live run --player live-1 --advertising 1` | `advertising-notice PASS`: the consent result notice is listed, recorded as shown, and gone. This records advertising consent for the test player. |

Each `run` uses new reminder keys, and a run that fails cancels the
reminders it left pending. Two things can hold a push back without a
failure: the starter's `daily-ready` has quiet hours from 21:00 to 08:00 in
the player's zone (Asia/Seoul by default), when the send is deferred, and a
cap of one a day (`frequency.maxPerDay`), so a second run the same day
sends nothing. For repeated runs, use a new `--player` (and the same id in
the game), or a test copy of the catalog without them.

`deliverNotification` is a service-binding RPC, not an HTTP route, so the
driver cannot call it on `wrangler dev`; the dry run covers it in process.
The scheduler path above uses the same delivery and provider code.

### When something fails

| Symptom | Cause and fix |
| --- | --- |
| `providers` fails with 404 | No `MPGD_NOTIFICATIONS_CATALOG`: start wrangler with `--env-file`. |
| `providers` fails with 500, or `android` has no provider | The catalog, deployment, or key does not validate (the Worker logs which once); a placeholder sender contact is the usual one. |
| `session-required` gets 404 | The session routes are off: the D1 flag is missing (or D1 is not merged yet). |
| `session` gets 401 | The Worker refused the session token: check `--player`, `--session`, `--installation` (letters, digits, `_`, `-`). |
| `reminder-cancel` or `reminder` answers `permission-required` | No endpoint with a granted permission for this player: the device has not registered, or registered as another player. |
| `scheduler` fails: still pending | The reminder was not due when the scheduler ran (clock skew), or the Worker restarted and lost its memory store. |
| No push, Worker log shows `provider.send` with an `FcmAccessTokenError` | The service account cannot mint a token for FCM: check its role and that the key is not revoked. |
| No push, no error | Quiet hours or the daily cap above; or the emulator image has no Play services (`emulator` reports it). |
| The app cannot reach the Worker | `adb reverse tcp:8787 tcp:8787` is missing, or the game's URL is not `http://127.0.0.1:8787`. |

## iOS

iOS needs the APNs key in Firebase, `GoogleService-Info.plist`, the Push
Notifications capability, and the AppDelegate wiring from the
[Firebase setup guide](FIREBASE_NOTIFICATIONS.md#4-ios). A physical iPhone
cannot reach `127.0.0.1` on your machine, and App Transport Security
refuses plain http, so run the iOS half against a test deployment
([Staging](#staging)) rather than `wrangler dev`. Check the cold-start tap
in particular (the [Firebase guide](FIREBASE_NOTIFICATIONS.md#6-check-it)
explains why).

## Staging

A deployed test Worker uses the D1 store, its real
`GAME_SERVICES_NOTIFICATIONS_AUTH` binding, and its own cron; the local
session flag is refused there. Give the driver a real session's
`Authorization` value through an environment variable, never on the
command line:

```sh
export MPGD_LIVE_AUTHORIZATION='Bearer ...'   # a test player's session
pnpm notifications:live run \
  --worker https://game-services-staging.example.workers.dev \
  --staging game-services-staging.example.workers.dev \
  --auth-env MPGD_LIVE_AUTHORIZATION
```

The driver redacts the value from its output and skips the scheduler step:
the deployed cron sends the reminder within a minute of its time.

## Later: Apps in Toss and Devvit

These are not part of this runbook yet; each needs what the kit cannot
supply:

- **Apps in Toss** functional messages: a console app with registered
  functional-message templates mapped in `targets.ait`, the partner API
  client certificate as the Worker's `AIT_PARTNER_MTLS` binding,
  `MPGD_AIT_NOTIFICATIONS`, an identity binding that answers each player's
  Toss user key (`GAME_SERVICES_NOTIFICATIONS_IDENTITY`), and a Toss test
  account in the sandbox app. The agreement sheet is opened from a tap in
  the mini-app; the Worker sends through the partner API.
- **Devvit** notifications: Reddit's approval of the app and its copy
  (keep `integrations.notifications` at `approval-required` until then), a
  test subreddit, a logged-in test account that opts in from the game, and
  `devvit playtest`; the Devvit server sends from its scheduler tasks, not
  through this Worker.

## Afterwards

- Stop `wrangler dev` (the memory store goes with it) and delete the env
  file: `rm ~/.mpgd/notifications-live.env`.
- Keep the service-account key only as long as you test; delete the key in
  the Google Cloud console when the test project is done.
- `adb reverse --remove-all` clears the port forwards.

## What the dry run covers

`pnpm notifications:live dry-run` (and the Worker's tests in CI):

- the env file `env` writes, read back the way `wrangler dev --env-file`
  reads it (quotes, `$` signs, the key's line breaks), becomes the Worker's
  env;
- every driver step against the real Worker handler, with the scheduler run
  through the same route as on `wrangler dev`, one `deliverNotification`
  send through the service binding's answer, and the advertising notice;
- the FCM requests carry the device token and the catalog copy intact;
- the driver's output carries neither the session token, the device token,
  nor the key;
- a player without a device stops at `permission-required`, and a Worker
  without session routes stops at `session-required` with the fix.

It does not show that Google accepts the key, that a device receives the
push, or that a tap opens the game: that is this runbook.
