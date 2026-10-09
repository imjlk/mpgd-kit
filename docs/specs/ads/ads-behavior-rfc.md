# Advertising behavior contract (RFC)

Status: **partially implemented proposal (AD2, shared runtime ownership, and registered claim routing)**. The versioned types,
validators, pure session transitions, compatibility facade, and vector runner
now exist in `@mpgd/platform/ads` and `@mpgd/platform/ads-conformance`.
The client decoder and independent server verifier registries now exist in
`@mpgd/game-services`; registered advertising routing accepts all existing
build targets. `@mpgd/game-runtime/presentation` and `/ads` now coordinate
full-screen ownership, separate native closure from backend settlement, retain
late observers, and inject caller deadlines and placement policy. Purchase
closure requires trusted native facts; business result statuses alone keep the
surface uncertain. AdMob now exposes its actual rewarded provider through the
Capacitor gateway and runs seven shared native-presentation vectors with an
injected native SDK. AIT/Verse8 fixtures, cross-provider ledger fixtures, and
starter assembly remain proposed work.
The full behavior described here is outside the enforced
[documentation evidence](../../DOCUMENTATION_EVIDENCE.md) scope until the
contract, runner, and real adapter fixtures land.
Baseline: `main@ce43de12`, 2026-10-08. Proposed protocol:
`mpgd.ads.v2`, version `2.0.0-draft.1`.

## Scope {#scope}

Start with rewarded and interstitial ads. Keep the existing package ownership:
`platform` owns contracts and provider-neutral conformance;
`game-runtime` owns execution and presentation coordination;
`game-services` owns claims, persisted recovery, and the backend ledger;
`target-config` owns game policy and deployment configuration;
SDK implementations stay in `adapters/*` and allowed host boundaries.

Banner attachment, a new advertising platform, and the Commerce v2 purchase
reconciler are follow-up work. Commerce v2 shares presentation ownership and
evidence-registration principles with this proposal, but its implementation
is not a prerequisite for advertising work.

## Existing behavior and gaps {#current-state}

- `AdAdapter` already hides SDK calls. Do not introduce another generic
  `showAd()` facade merely to rename those calls.
- `preload(): Promise<void>` does not promise readiness. Verse8 does no
  preparation; AIT treats configured unsupported or failed preloads as
  opportunistic. A resolved legacy preload cannot prove a prepared ad exists.
- `InterstitialAdResult` cannot distinguish display failure from a skip.
  AIT and Verse8 collapse failures into `skipped`.
- Client reward handling recognizes AdMob and Verse8 by name and schema in
  `admob-client-reward.ts`; journal validation repeats that dependency.
- Reward claims accept only `android | ios | ait | verse8`, and the worker
  selects verifiers partly by target. A client evidence registry alone cannot
  make another provider reachable.
- AIT's rewarded result uses `rewardGranted` for an SDK reward event and
  `ledgerEntryId` for a client-issued correlation id. These are not a backend
  grant. The existing claim still goes through backend verification.
- The action coordinator serializes purchases and rewarded claims until the
  complete service operation settles. Interstitials are outside it. AIT's
  group guard protects one ad group, rather than a shared purchase/ad surface.
- AIT's maximum-display timer resolves as shown and emits resume without a
  terminal native callback. AdMob instead retains uncertain SDK state and
  blocks another show. Neither behavior establishes a shared contract.
- AIT mixes ad pause/resume and page visibility in one lifecycle source.
  An ad ending must not clear a background or settings pause.

These observations are code-level baselines, not a claim that a collision has
been reproduced on a device.

## Readiness and policy {#readiness}

Provider availability and game policy are separate inputs. A show is permitted
only when the placement has the requested format, policy enables it, the
provider is supported and configured, any required user action is complete,
and no conflicting or uncertain presentation owns the surface.

The new preparation result distinguishes `ready`, `deferred`,
`unavailable`, and `failed`. `deferred` means the SDK prepares on demand;
it is a valid mode, not a failed implementation. `ready` is an observation
at that time, not a guarantee that the next show will succeed.

Unsupported, misconfigured, policy-disabled, and busy requests must not call
the SDK's display API. Provider-neutral reasons include `unsupported`,
`configuration-required`, `policy-disabled`, `action-required`,
`no-fill`, `busy`, `transient-failure`, and `outcome-unknown`.
An original SDK code may be retained as bounded diagnostic metadata. Games do
not branch on provider names or raw SDK codes.

## Presentation, eligibility, and grants {#results}

Track three independent observations:

| Observation | Proposed states | Authority |
| --- | --- | --- |
| Presentation | `not-started | open | closed | unknown` | Provider's native/host signals |
| Reward eligibility | `eligible | not-earned | unknown | not-applicable` | Provider evidence; not a grant |
| Reward claim | `not-requested | pending | granted | rejected` | Backend ledger |

A closed interstitial is shown if display was observed. A rewarded ad can
close without an earned reward. An earned event does not prove closure.
A closed rewarded ad can have a pending claim. A grant can arrive after the
view is disposed.

A show result carries its invocation identity, normalized outcome/reason,
presentation observation, reward eligibility, and optional evidence. It never
contains a field implying that an SDK callback is a committed ledger entry.
Claim results carry an authoritative `ledgerEntryId` only after the backend
confirms the grant. Names and wire fields are finalized in AD2.

For delayed-reward providers, a dismissal without a reward may leave
eligibility unknown and a claim pending. Providers declare that behavior;
conformance must not force every dismissal into a terminal non-reward.

## Invocation and presentation ownership {#ownership}

One coordination scope above all screens owns the full-screen surface shared
by purchase, rewarded, and interstitial requests. SDK-specific native guards
remain as a defensive boundary; games cannot bypass common policy by calling
an uncoordinated provider through the gateway.

- A repeated rewarded request with the same key and identical input joins the
  existing operation and opens the SDK once. Reusing the key for another
  placement, format, or player is a conflict.
- An interstitial also has an explicit invocation identity. A caller can join
  that invocation; a separate impression needs a new identity.
- Other full-screen operations are rejected as busy while the surface is
  occupied. The initial policy does not queue or automatically retry displays.
- Provider events are correlated to the invocation. Duplicate or stale events
  cannot close or mutate another invocation.
- When native closure is confirmed, release that presentation's execution
  blocks and surface ownership even if reward verification remains pending.
  Keep financial idempotency/history and unresolved-claim policy independent.
  Releasing the surface does not erase the existing recovery guard.
- Execution ownership is per source: ad presentation, background, settings,
  and other callers release only their own blocks. Audio uses the same
  ownership discipline where the runtime exposes an audio channel.
- `AdProvider.presentationAudio` defaults to `requested`. A provider can select
  `started` when its host requires audio to continue until a native start
  observation. Simulation/input arbitration still begins at request time;
  native start adds a separate audio block. Unknown presentation quarantines
  audio, and a terminal native observation releases only that lease's blocks.

## Waiting, uncertainty, and teardown {#uncertainty}

A deadline ends caller waiting. It does not cancel the SDK or establish native
closure, non-reward, or a successful grant. If presentation might still exist,
publish `unknown` and keep the surface unavailable. An earlier observed
reward can remain eligible while closure is unknown.

Retain the minimal provider terminal observer while presentation is uncertain.
A later authoritative close can release only that invocation's ownership.
Provider reset may clear uncertainty only when it establishes native teardown;
disposing a game view or removing a callback is not proof of teardown.

View disposal detaches projections and UI listeners. It cannot discard an
in-flight claim or release a live native presentation. Durable reward recovery
uses the original invocation and never reopens advertising UI. Restarted
processes do not inherit a live in-memory view, but recover unresolved claims
from their persisted evidence and identity.

## Client normalization and server verification {#evidence}

Use two independent, explicit registries:

1. Client normalizers validate registered evidence envelopes and resolve a
   claim candidate, including any provider impression identity.
2. Server verifiers are deployment-owned trusted bindings. They authenticate
   evidence and bind it to the player, placement, invocation, deployment, and
   provider before writing the ledger.

Registering a client normalizer cannot register or authorize a server verifier.
Unknown schemas/providers fail closed. Missing or pending verification cannot
grant. One verified impression cannot grant twice under different client keys.

Provider identity is separate from build target and deployment configuration.
Remove advertising workflow allow-lists and target-name verifier branches in
favor of explicit permitted provider/deployment bindings. Keep build target
validation and packaging rules; this proposal does not make arbitrary client
target strings trusted.

Persist the selected evidence schema, provider identity, invocation identity,
and original claim binding so recovery uses the same rules. A missing
normalizer during recovery leaves the operation unresolved and cannot trigger
a new SDK display. Keep existing `admob-client-reward` exports available as
compatibility entrypoints when normalization moves to a neutral module.

## Conformance vectors {#vectors}

Draft vectors are in [the vectors directory](https://github.com/imjlk/mpgd-kit/tree/main/docs/specs/ads/vectors).
They run through the AD2 runner against test-only reference SDK and ledger
ports. This does not establish that real adapters pass them.

Each JSON file has `vector` (matching the file name), `protocol`
(`mpgd.ads.v2`), `version` (`2.0.0-draft.1`), a
`profile`, ordered `steps`, and `expect`. The profile describes supported
formats, configured placement, and immediate/delayed reward signals.
Missing expectation fields are not assertions.

Profiles may also specify `policyEnabled` (default true), `actionRequired`
(default false), and `preparation`. A step may carry an `expect`
checkpoint, checked immediately after that action. Expectations are stripped
before an action is passed to a driver. Separate `callerId` values track the
two callers joining a duplicate invocation. `outcomes` contain normalized
outcomes; rejection classes such as `busy` belong in `reasons`.
Client normalization failure leaves a claim `not-requested`, with a
separate `normalization: rejected` observation. Grant and recovery
assertions can check the exact authoritative `ledgerEntryId`.

Fixture defaults are player `test-player`, registered provider
`fixture-provider`, evidence schema `fixture.reward.v1`, and a 30,000 ms
caller deadline. Preparation defaults to `ready`. Steps are shorthand: the
runner fills the fixed player, a key derived from the invocation, and approved
placement context before calling typed ports. A `purchase` start uses the
fixture product `TEST_PRODUCT` and source `shop`; it exercises the shared
surface, not advertising format support. These defaults cannot synthesize an
SDK completion or a backend grant.

Actors:

| Actor | Actions |
| --- | --- |
| `game` | `prepare` observes preparation; `start` invokes without waiting for the show/claim to finish; `disposeView` detaches the selected view |
| `sdk` | `started`, `rewardEarned`, `closed`, and `failed` supply provider events |
| `backend` | `grant` or `reject` settles verification through the fake ledger |
| `clock` | `advance` runs the injected clock |
| `runtime` | `block`, `release`, and `recover` operate on owned execution blocks and persisted claims; `restart` drops runtime/view state while retaining the journal and ledger |

After each step, drain scheduled work until no immediate work remains; never
wait for an intentionally open presentation. Unscripted displays and grants
fail. Reads derive from fixture state. Profiles do not silently award a reward.
A script of SDK input is translated by each provider fixture into its actual
SDK callbacks/promises, then exercised through the real adapter. AIT fixtures
include the game proxy and host bridge. A normalized fake gateway alone is
insufficient.

Unsupported formats run the common negative scenario and do not have to pass
positive scenarios for that format. Every included provider also retains
its specific native load, consent, cleanup, and verification tests.

## Migration and PR sequence {#pr-plan}

| PR | Scope | Required evidence |
| --- | --- | --- |
| AD1 | This draft and scenario vectors | Valid JSON, consistent vector ids, docs checks; no changeset for docs only |
| AD2 | Pure ads contract, validators, conformance runner, reference provider, compatibility mapping | Reference passes vectors; malformed events/results rejected; old consumers still compile |
| AD3 | Shared presentation coordination and first real AIT fixture | Purchase/rewarded/interstitial arbitration; ownership, uncertainty, bridge round trip |
| AD4 | Verse8 and AdMob fixtures and normalization | Same applicable vectors through real adapters; consent/SSV-specific checks retained |
| AD5 | Client normalizer registry, server verification bindings, claim routing and recovery | Registered new provider reaches the ledger without editing common workflow; unknown/replayed evidence rejected |

AD3 and AD4 adapt SDK event interpretation, not SDK imports or scene-level
business policy. AD5 aligns with the Commerce v2 evidence-registration direction
without implementing its store reconciler. Preserve v1 signatures and exports
through compatibility adapters; adding a new value to an existing result
union can break exhaustive consumers and is not presumed source-compatible.
Every implementation PR changing a published contract carries a Sampo
changeset and runs the relevant package checks.

Run `pnpm check`, affected package tests and conformance, `validate:ads`,
`validate:target-config`, `validate:targets`,
`smoke:adapter-effective-config`, and affected web/AIT builds before release.
Record contract tests, artifact checks, and real platform verification
separately. A green fake-SDK runner does not certify live ad inventory.

After AD5, add a new provider as an extension test: provider, configuration,
server verifier, and SDK fixture should suffice. Build-target registration is
permitted; provider-name branches in common advertising workflow are not.
CrazyGames is a candidate for that follow-up, not part of AD1-AD5.

## References {#references}

- [Commerce v2 RFC](../commerce/commerce-v2-rfc.md)
- [Monetization recovery](../../MONETIZATION_RECOVERY.md)
- [Confirmed capability snapshot conformance](../platform-capability-snapshots.md)
- [Apps in Toss full-screen events](https://developers-apps-in-toss.toss.im/documentation/sdk/domains-api/ads/showfullscreenad)
