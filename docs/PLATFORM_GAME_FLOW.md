# Shared Platform Game Flow

`mpgd-kit` models game intent once and lets each target supply the strongest
platform integration it can safely support. Phaser scenes consume normalized
identity, launch, share, and notification contracts; they do not import target
SDKs.

## Client boundary

`PlatformGateway` keeps the existing `identity.getPlayer()` API and adds
optional integration contracts:

- `identity.getSession()` distinguishes guest, platform-anonymous, and
  authenticated identities from local, platform-asserted, and server-verified
  trust.
- `identity.requestUpgrade()` describes why a game needs stronger identity and
  whether the platform expects a reload.
- `presentation.getLaunchIntent()` normalizes home, daily, practice,
  free-play, continue, leaderboard, and friend-challenge entry.
- `presentation.requestGameSurface()` lets an inline host request a game
  surface while fullscreen targets return `already-fullscreen`.
- `sharing.share()` and `sharing.readInboundShare()` separate outbound viral
  behavior from inbound routing.
- `notifications` manages user subscription state only. It never sends a push.

These groups are optional so existing adapters remain source compatible.
Callers must read the target runtime integration state before showing a CTA and
must still handle an operation returning `unavailable`.

`ShareResult.completion` separates proof that a platform share surface was
`presented` from proof that sharing `completed`. The field is optional so
existing adapters and games remain compatible; a legacy `status: 'shared'`
result without it normalizes to `completed`. New integrations that only open a
share sheet must return `completion: 'presented'`, and callers should use
`resolveShareCompletion()` or `isShareCompleted()` instead of treating every
`shared` status as a confirmed completion.

## Availability is a state

Target config keeps the existing boolean monetization gates and adds separate
integration readiness states:

- `available`
- `disabled`
- `approval-required`
- `configuration-required`
- `unsupported`

This distinction is important for capabilities that exist in an SDK but cannot
run until a console setting, server exchange, native implementation, or platform
allowlist is ready. Missing integration config normalizes to safe disabled or
unsupported defaults.

### Capability snapshots stay live

`getCapabilities()` returns a complete snapshot of the adapter's current
provider state. Each call returns a fresh object; callers may retain or freeze a
snapshot without mutating later reads. Bridge-backed adapters also re-query the
bridge on every call, and `withTargetAvailability()` applies target-config
masking to that latest response instead of permanently caching the first one.

This matters when a native service finishes initialization, a remote provider
becomes unavailable, or an optional server boundary is installed after startup.
Games should re-read capabilities at the point where availability matters and
must still handle the operation failing after a positive snapshot.

`@mpgd/platform/capability-conformance` exports a provider-neutral runner for
adapter and target-wrapper fixtures. The repository smoke suite applies it to
raw and target-configured gateways for web preview, Microsoft Store, Verse8,
Android, iOS, Apps in Toss, and Reddit. It verifies the exact boolean shape,
snapshot isolation, target identity, target masking, and live provider
transitions without importing platform SDKs into the shared package.

The checked-in targets intentionally describe current kit readiness, not the
desired end state. For example, Apps in Toss sharing is available through
`getTossShareLink` plus the native share sheet, while notification subscription
remains configuration-required. Reddit notification subscription remains
approval-required, and its inline-to-expanded and client-side share effects
remain configuration-required until the target wrapper installs those client
entry points.

## Identity reconciliation belongs on the server

An identity upgrade can reload a platform surface. Save the guest snapshot and
a handoff nonce before requesting the upgrade, then call the game-services
progress link service after the server has resolved the authoritative player.

The default merge policy is monotonic:

- completed ids are unioned;
- best times keep the lowest valid value;
- best scores keep the highest valid value;
- the newest active-progress snapshot wins, with the server winning timestamp
  ties;
- entitlements, rewards, and leaderboard claims are not part of the guest
  snapshot and are never promoted by this merge.

The progress store owns atomic deduplication by idempotency key and handoff
nonce. `createProgressLinkService()` also requires two server-owned checks: a
handoff verifier binds an issued, unexpired nonce to the guest and authoritative
player, while a progress verifier accepts or rejects client best-time and
best-score claims according to the game's validation rules. Inputs are bounded
before recursive normalization. Production stores must implement the same
deduplication guarantee transactionally and return semantically consistent
results.

## Share data is untrusted

`challengeToken`, `puzzleId`, and referral data only select an entry flow. They
must not grant rewards, assert a player identity, or establish an authoritative
score. Challenge tokens should be signed and checked by the game server before
use.

The browser adapter uses Web Share and then a clipboard fallback. Apps in Toss
uses a Toss share link before opening its native share sheet. Mobile and Reddit
bridge contracts are present, but target config exposes their current setup
state instead of pretending an unwired SDK call is available.

`presentDevvitShareSheet()` in `@mpgd/adapter-devvit/web` wraps Devvit's
`showShareSheet()` effect and returns `shared + presented`; Devvit does not
provide a callback proving that the user finished sharing. Games may show an
"opened" state after this result, but must not record a completed share from it.

## Notifications are split at the trust boundary

The platform adapter can inspect or request a topic subscription. Actual
delivery uses a server-only `NotificationDeliveryProvider`. The delivery
service requires a durable ledger with claim-token fencing and a provider whose
`deliverIdempotently()` implementation durably binds the full normalized request
to its idempotency key. The provider must deduplicate concurrent calls and
survive process restarts, using a platform idempotency key or durable outbox.
The included in-memory ledger is a test helper, not a production default.

Delivery leases recover crashed workers, ambiguous provider failures retain the
claim, and only `NotificationDeliveryNotSentError` permits an immediate release.
Absolute notification links require an explicit trusted-origin allowlist. These
contracts together prevent duplicate external sends; a provider that violates
the idempotency contract cannot make that guarantee.

Provider credentials, platform recipient identifiers, message templates, and
delivery authority stay on the server. Apps in Toss functional messages also
require campaign/template configuration and partner-server mTLS. Reddit push
notifications remain a gated capability until the app is approved.

## Deliberately deferred

This contract layer does not add game-specific mode placement, puzzle
difficulty, a daily-content scheduler, a Reddit inline preview UI, rewarded
referrals, App Mention triggers, or Realtime. Those belong in downstream games
or target wrappers after the integration state becomes available.

Primary platform references:

- [Apps in Toss user key](https://developers-apps-in-toss.toss.im/user-hash-key/develop.md)
- [Apps in Toss share link](https://developers-apps-in-toss.toss.im/bedrock/reference/framework/%EA%B3%B5%EC%9C%A0/getTossShareLink.md)
- [Apps in Toss notification agreement](https://developers-apps-in-toss.toss.im/bedrock/reference/framework/%EC%9D%B8%ED%84%B0%EB%A0%89%EC%85%98/requestNotificationAgreement.md)
- [Devvit view modes and entry points](https://developers.reddit.com/docs/capabilities/server/launch_screen_and_entry_points/view_modes_entry_points)
- [Devvit logged-out sharing](https://developers.reddit.com/docs/guides/logged-out-users)
- [Devvit notifications](https://developers.reddit.com/docs/capabilities/notifications/notifications-overview)
