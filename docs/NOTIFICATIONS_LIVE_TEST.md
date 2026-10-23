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
  key and the env file are yours: keep them out of every repository, and
  never paste them into an issue, a PR, or an agent session.
  `google-services.json` is less sensitive but project-specific: keep the
  test game's repository local, or ignore the file there. The kit reads
  the key only to write the env file (mode 0600 on macOS and Linux; on
  Windows the file keeps your profile's permissions), and refuses to write
  that file inside any git checkout or through a symbolic link. It never reads mise's configuration (`~/.config/mise`,
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
  from anyone who can reach it. Bind the Worker to `127.0.0.1` only, and
  reach it as `localhost`/`127.0.0.1` (from the emulator: through
  `adb reverse`, or as `10.0.2.2`, the emulator's name for this machine).

> **Needs D1 (#431).** The local session flag
> (`MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS = "true"`, refused
> with `MPGD_STORE = "d1"`), the `mpgd-dev` token, the starter's
> development session (`VITE_MPGD_DEV_NOTIFICATION_SESSION`), and the
> `.gitignore` entries for `.dev.vars` land in D1. D1 also accepts the
> flag only for a local request host (`localhost`, `127.0.0.1`, `[::1]`,
> `*.localhost`, or the emulator's `10.0.2.2`); any other host answers 401.
> Until it is merged, the Worker answers 404
> on the session routes and `run` stops at `session-required` with that
> hint. Everything else on this page works today.

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
# target builds record the game's source revision
git init && git add -A && git commit -m "live push test game"
```

(`git commit` needs `user.name` and `user.email`; set them for the
repository with `git config` if your global configuration has none.)

The game installs the `@mpgd/*` packages from npm at the versions of this
checkout. If the checkout has unreleased notifications changes, the game
and the Worker you build here can differ; test a released kit, or create
the game with `--workspace --kit-path .` so it links this checkout.

Then, in the game:

1. Put `google-services.json` at
   `apps/mobile-capacitor/android/app/google-services.json`, and add that
   path to the game's `.gitignore`.
2. Replace `REPLACE-WITH-SENDER-PHONE-OR-ADDRESS` in
   `notifications/deployment.json` (a test value is fine for a local run).
   The Worker refuses the placeholder and answers 500
   `NOTIFICATIONS_CONFIGURATION_REQUIRED`.
3. For repeatable runs, remove `frequency` and `quietHours` from the
   `daily-ready` topic in `notifications/topics.json`. The starter sends it
   at most once a day and holds it from 21:00 to 08:00 in the player's zone
   (Asia/Seoul by default): with them, only the first push of the day
   arrives, and a run at night is deferred to the morning while every step
   still passes. This is a throwaway game; keep them in a real one.
4. Run `pnpm validate:notifications`.
5. In the game's `.env.local` (Vite reads it when the dev server starts),
   point the game at the local Worker and turn on the development session
   with a test player id (**needs D1 (#431)**):

   ```sh
   VITE_MPGD_GAME_SERVICES_URL=http://127.0.0.1:8787
   VITE_MPGD_DEV_NOTIFICATION_SESSION=live-1
   ```

   Use the same player id with `run` below: the device and the driver must
   be the same player. The starter uses the development session only on
   the Vite dev server in development mode, so the emulator runs the game
   through live reload ([section 4](#4-the-emulator)).

## 2. The Worker's env file

From the kit's checkout:

```sh
mkdir -p ~/.mpgd && chmod 700 ~/.mpgd
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
key's project differs from the Firebase project. After every catalog
change, write the file again (`--force`) and restart `wrangler dev`, which
reads it at start.

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

wrangler lists the variables (five, six with `--project-id`) as
`(hidden)`. The Worker logs once that it uses the memory store: consent
records, endpoints, and reminders live in this process and are gone when
you stop it.

D1 documents `pnpm --dir apps/game-services-worker dev --port 8787` with
`apps/game-services-worker/.dev.vars` (git-ignored by D1) for trying the
settings screen. Do not use it for this run: the Cloudflare Vite plugin
hands the Worker a new `env` object on every request, and the Worker keys
its notifications service and memory store by that object, so on the Vite
dev server the memory store keeps nothing from one request to the next
(the device's registration is gone before the driver's reminder). That is
a limitation of D1's local flow (raised for D1), not of this kit. The built
Worker above keeps one store for the life of the process. (`env --format
dev-vars` writes the `.dev.vars` form for that flow; `vite build` copies a
linked `.dev.vars` or `.env` to `dist/mpgd_game_services/`, so remove the
link before building. The `wrangler dev --env-file` run above ignores a
copy there.)
There is no store dump route;
the driver's reads (`GET /consent`, `GET /notices`) and the Worker log are
how you see the state. `wrangler dev` does not run crons on its own; the
driver runs the scheduler through `GET /cdn-cgi/handler/scheduled`.

Check the Worker before the device:

```sh
pnpm notifications:live run --player live-1 --no-scheduler
```

`providers` (with `android -> fcm`), `session-required`, and `session`
must pass. Until the device has registered, the run then warns at
`device-permission` and stops at `reminder-cancel` with
`permission-required`: that is expected here. Without D1 it stops earlier,
at `session-required` (404). (`--fcm-token-file <file>` registers a device
token for the driver's own session instead of relying on the app's
registration; use it only when you already have the app's FCM token, since
the starter does not print it.)

## 4. The emulator

Start the emulator, then forward the Worker's port to it, so the app
reaches `http://127.0.0.1:8787` on the device, and check it:

```sh
pnpm notifications:live emulator --app-id dev.example.livepush --reverse
```

It checks one device online and booted, Google Play services
(`com.google.android.gms`), the Play Store app, that the game is
installed, the `POST_NOTIFICATIONS` permission (API 33+), and
`adb reverse`. It reads through `adb`, sets only that one port forward, and
never grants a permission: the dialog must come from a tap in the game.
Before the game is installed, its `app` line fails; that is expected the
first time.

Install and run the game on the emulator with Capacitor's live reload, so
the game runs on the Vite dev server in development mode, the only place
the starter uses the development session (**needs D1 (#431)**). A build
without live reload gets one only when it is built in development mode
(`NODE_ENV=development vite build --mode development`). The Android target must be selected for the dev server,
or it serves the browser gateway, which has no notifications provider. The
live-reload page is served over http, so its calls to the http Worker are
not mixed content (a built bundle on `https://localhost` would be):

```sh
# in the game
pnpm exec mpgd target build android staging --targets-file ./mpgd.targets.json
APP_TARGET=android MPGD_CONFIG_TARGET=android \
  MPGD_PLATFORM_TARGETS_FILE=./mpgd.targets.json pnpm dev   # port 5173
adb reverse tcp:5173 tcp:5173
cd apps/mobile-capacitor
pnpm exec cap run android --live-reload --host 127.0.0.1 --port 5173
```

Then run the check again: no line should fail. Before the first tap
`notification-permission` warns, and on a "Google APIs" image
`google-play-store` warns too. Follow the app with
`adb logcat -v time Capacitor:V Capacitor/Console:V FirebaseMessaging:V '*:S'`
(the `emulator` command prints it for your serial).

## 5. The walkthrough

Keep the Worker log, `adb logcat`, and the emulator in view. Each row says
what to do, what to observe, and where.

| Step | Do | Observe |
| --- | --- | --- |
| Permission | Open the game's notification settings and tap *Turn on notifications* (알림 켜기). Allow the dialog. | The Android dialog appears only after the tap. Worker log: `POST /game-services/notifications/consent 200` (the granted report). |
| Register | Nothing: the runtime registers after the grant. | Worker log: `POST /game-services/notifications/endpoints 200`. logcat: no `FirebaseMessaging` error. |
| Consent | Turn the *Today's run reminder* (오늘의 플레이 알림, topic `daily-ready`) on in the settings screen. | Worker log: `POST .../consent 200`. The switch shows the backend record after it reloads. |
| Driver | `pnpm notifications:live run --player live-1` | `device-permission PASS` (the device's grant), then `topic-preference`, `reminder-cancel`, and `reminder` pass. |
| Scheduler send | Send the app to the background before the driver's wait ends (5 s; `--fire-in` sets it). | `scheduler PASS`: the reminder fired and nothing held its send. Worker log: no `Notifications: provider.rejected` or `provider.send` line. The push shows in the shade. |
| Open | Tap the push. | The game opens at the topic's route (`/?entry=continue` for `daily-ready`). Repeat with the app killed (cold start) and in the background (warm start). |
| Foreground | Run the driver again with the app in front. | The push is shown while the game is open (it needs `presentationOptions`, see the [Firebase setup](FIREBASE_NOTIFICATIONS.md#1-the-plugins)). |
| Notices (optional) | `pnpm notifications:live run --player live-1 --advertising 1` | `advertising-notice PASS`: the consent result notice is listed, recorded as shown, and gone. This records advertising consent for the test player. |

Each `run` uses new reminder keys. A run that stops, or a local run with
`--no-scheduler`, cancels the reminders it set and unregisters an endpoint
it registered, so no push arrives later. If you kept the topic's quiet
hours or daily cap ([section 1](#1-the-game)), `scheduler` fails when they
hold the send, and its check cancels the held send. `scheduler PASS` means
the reminder fired and nothing held its send; whether FCM delivered it is
in the Worker log and on the device.

`deliverNotification` is a service-binding RPC, not an HTTP route, so the
driver cannot call it on `wrangler dev`; the dry run covers it in process.
The scheduler path above uses the same delivery and provider code.

### When something fails

| Symptom | Cause and fix |
| --- | --- |
| `providers` fails with 404 | No `MPGD_NOTIFICATIONS_CATALOG`: start wrangler with `--env-file`. |
| `providers` fails with 500, or `android` has no provider | The catalog, deployment, or key does not validate (the Worker logs which once); a placeholder sender contact is the usual one. |
| `session-required` gets 404 | The session routes are off: the D1 flag is missing (or D1 is not merged yet). |
| `session` gets 401 | The Worker refused the session token: check `--player`, `--session`, `--installation` (letters, digits, `_`, `-`), and that `--worker` is a local host (D1 refuses development sessions on any other host, such as a LAN address). |
| `reminder-cancel` or `reminder` answers `permission-required` | No endpoint with a granted permission for this player: the device has not registered, or registered as another player. |
| `scheduler` fails: did not send | The reminder was not due when the scheduler ran (clock skew), quiet hours or the daily cap held the send, or the send waits to retry a provider failure (the Worker log names it). The check cancelled it. |
| No push, Worker log shows `Notifications: provider.rejected ... (configuration, <code>)` | FCM or Google refused the send's setup. A `TOKEN_*` code (such as `TOKEN_KEY_UNUSABLE` or `TOKEN_INVALID_GRANT`): the key is malformed, revoked, or deleted. `PERMISSION_DENIED`: the service account lacks the role that may send through FCM. Another code names FCM's own refusal. |
| No push, nothing logged | Quiet hours or the daily cap ([section 1](#1-the-game)); a token or network failure that is retried later (check that this machine reaches `oauth2.googleapis.com` and `fcm.googleapis.com`); or an emulator image without Play services (`emulator` reports it). |
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
session flag is refused there (**needs D1 (#431)**). The session binding is the
game's own identity Worker (the kit does not ship one), so a staging run
needs a test player's real session from it: the same `Authorization`
value the game sends. Give it to the driver through an environment
variable, read so it stays out of your shell history, never on the
command line (the driver refuses a development session for a deployed
Worker):

```sh
read -rs MPGD_LIVE_AUTHORIZATION && export MPGD_LIVE_AUTHORIZATION   # paste: Bearer ...
pnpm notifications:live run \
  --worker https://game-services-staging.example.workers.dev \
  --staging game-services-staging.example.workers.dev \
  --auth-env MPGD_LIVE_AUTHORIZATION
```

(A terminal line holds about 1,024 characters; for a longer token, set
the variable from a file you delete afterwards.)

The driver redacts the value from its output and skips the scheduler step:
the deployed cron sends the reminder within a minute of its time. A
passing staging run keeps the reminder, and an endpoint it registered with
`--fcm-token-file`, for that cron; ending the session removes the
endpoint.

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
  file: `rm ~/.mpgd/notifications-live.env`. If you linked a `.dev.vars`,
  remove the link and `apps/game-services-worker/dist/`, which may hold a
  copy.
- Keep the service-account key only as long as you test; delete the key in
  the Google Cloud console when the test project is done.
- `adb reverse --remove-all` clears the port forwards.

## What the dry run covers

`pnpm notifications:live dry-run` (and the Worker's tests in CI):

- the env file `env` writes, read back the way `wrangler dev --env-file`
  reads it (quotes, `$` signs, the key's line breaks), becomes the Worker's
  env;
- every driver step against the real Worker handler, with the
  `wrangler dev` scheduled route mapped to the Worker's scheduler
  (`runScheduledNotifications`, which the Worker's `scheduled` handler
  calls), one `deliverNotification` send through the service binding's
  answer, and the advertising notice;
- the FCM requests carry the device token and the catalog copy intact;
- the driver's output carries neither the session token, the device token,
  nor the key;
- a player without a device stops at `permission-required`, and a Worker
  without session routes stops at `session-required` with the fix.

It does not show that Google accepts the key, that a device receives the
push, or that a tap opens the game: that is this runbook.
