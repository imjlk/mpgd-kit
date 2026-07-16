# Verse8 Agent8 Storage and Verified Leaderboards

`@mpgd/adapter-verse8` keeps the iframe client independent of the React-based
Agent8 browser SDK. A game may inject its own authenticated RPC wrapper for
cloud saves, while `@mpgd/adapter-verse8/agent8` supplies server-only helpers
for Agent8 user state and collections.

The default starter does not configure either integration. Keep cloud storage
and the generic leaderboard unavailable until the game owns the Agent8 server,
RPC authentication, server-only secrets, authenticated encryption, and
deployment lifecycle.

## Agent8 context

Install the current compatible `@agent8/gameserver-node` package only in the
separate Agent8 server project. Adapt the platform globals structurally; the
mpgd package does not import the Agent8 runtime:

```ts
import type { Verse8Agent8ServiceContext } from '@mpgd/adapter-verse8/agent8';

const context: Verse8Agent8ServiceContext = {
  getUserState: (account) => $global.getUserState(account),
  updateUserState: (account, state) => $global.updateUserState(account, state),
  lock: (key, callback) => $lock(key, callback),
  getCollectionItems: (collectionId, options) =>
    $global.getCollectionItems(collectionId, options),
  addCollectionItem: (collectionId, item) =>
    $global.addCollectionItem(collectionId, item),
  updateCollectionItem: (collectionId, item) =>
    $global.updateCollectionItem(collectionId, item),
};
```

This contract uses the public Agent8 user-state, collection, and `$lock` APIs.
It intentionally does not combine collection filters with ordering and does not
depend on `startAfter`; those paths are not implemented consistently across the
current Agent8 runtime and published type surface.

## Cloud storage

Bind every remote call to `$sender.account`; never accept an account from the
browser payload:

```ts
import { createVerse8Agent8StorageService } from '@mpgd/adapter-verse8/agent8';

const storage = createVerse8Agent8StorageService({
  persistenceSecret: serverOnlyStorageIndexSecret,
  codec: gameOwnedAuthenticatedEncryptionCodec,
});

export class Server {
  loadMpgdSave(input: { readonly key: string }) {
    return storage.load($sender.account, input, context);
  }

  saveMpgdSave(input: { readonly key: string; readonly value: unknown }) {
    return storage.save($sender.account, input, context);
  }
}
```

Agent8 global user state is client-subscribable, including by account. The
helper therefore refuses to provide a plaintext default: `persistenceSecret`
HMACs account/slot identifiers, and `codec` must use authenticated encryption
with a server-only key, fresh nonce, and the supplied account/key as associated
data. Base64, reversible encoding, hashing, or client-held keys are not safe
codecs. The helper stores only versioned opaque envelopes under
`mpgdVerse8Storage`, serializes updates per account, rejects malformed state,
and applies bounded entry, plaintext-value, and namespace-state limits. Keep
old decryption keys available through `keyId` during rotation, and adjust limits
only after measuring Agent8 quotas.

Wrap those game-owned remote methods at the adapter boundary:

```ts
import { createVerse8PlatformGateway } from '@mpgd/adapter-verse8';

const gateway = createVerse8PlatformGateway({
  agent8Storage: {
    load: (input) => gameOwnedAgent8Client.call('loadMpgdSave', input),
    save: (input) => gameOwnedAgent8Client.call('saveMpgdSave', input),
  },
});
```

`cloudSave` becomes true only when `agent8Storage` is present. Once configured,
remote errors propagate and the adapter never falls back to local storage;
silently splitting progress between local and cloud state would be unsafe.
The static Verse8 target metadata therefore remains `local`: it describes the
default starter, not an optional server deployment. After constructing the
gateway, call `await gateway.getCapabilities()` and gate cloud-save UI and
behavior on the returned `cloudSave` value rather than treating the effective
target config as proof that Agent8 RPC is present.

## Verified leaderboard boundary

Use a game-specific submission type that identifies an authoritative attempt.
Do not expose a generic client score recorder:

```ts
import {
  createVerse8Agent8LeaderboardBoundary,
} from '@mpgd/adapter-verse8/agent8';

interface CompleteRankedRun {
  readonly runId: string;
}

const leaderboard = createVerse8Agent8LeaderboardBoundary<CompleteRankedRun>({
  context,
  persistenceSecret: serverOnlyLeaderboardPersistenceSecret,
  async verifySubmission({ account, submission }) {
    const completion = await attemptCoordinator.verifyCompletion({
      account,
      runId: submission.runId,
    });

    return completion === null
      ? null
      : {
          definition: completion.leaderboardDefinition,
          attempt: completion.verifiedLeaderboardAttempt,
        };
  },
});

export class Server {
  completeRankedRun(command: CompleteRankedRun) {
    return leaderboard.submit($sender.account, command);
  }

  getRankedPage(input: {
    readonly leaderboardId: string;
    readonly limit?: number;
    readonly cursor?: string;
  }) {
    return leaderboard.getSnapshot($sender.account, input);
  }
}
```

The verifier must reconstruct completion from server-owned state. Returning the
client's score, time, participant, or evidence without independent validation
does not make it authoritative. The boundary rejects a verified participant
that differs from the authenticated account and injects that account into
snapshot reads.

The provider preserves the shared `VerifiedLeaderboardService` semantics:
definition conflicts and attempt-ID collisions fail closed, writes serialize
per board, retained entries use deterministic score/time/UTF-16 attempt-ID
ordering, and retries preserve their original retention decision. The exported
`createVerse8Agent8VerifiedLeaderboardProvider()` is a lower-level server-only
provider for an already-authoritative coordinator; never expose its trusted
recorder directly to a game client.

Retained-entry writes include a transient public `pendingDecision` containing
only the response and its keyed digest. Every board operation must durably
write or validate the private attempt marker and clear that pending value
before it can continue, so a marker interruption cannot let a later attempt
replace the entry before the original decision is recoverable.

Agent8 global collections may be client-subscribable. The provider therefore
stores only public retained-entry fields plus HMAC-SHA-256 identity digests. It
does not persist verification evidence or the raw history of non-retained
attempts. Public board collection IDs use bounded SHA-256 digests; private
attempt-decision collection IDs and integrity markers require the stable
server-only `persistenceSecret`, so predictable attempt IDs do not reveal those
records. Use a high-entropy secret of at least 32 UTF-8 bytes, keep it out of
client bundles and source control, and retain it across deployments.

Pages use the shared versioned opaque cursor. Internally, the adapter loads at
most `maximumParticipants + 1` retained entries from the board-specific
collection, rejects an oversized board, and applies the contract's exact
JavaScript ordering and cursor slice on the server. The default participant cap
is 1,000 and can be lowered for a game with tighter runtime limits. This avoids
filter-plus-order and indexed-string limits while preserving 512-character
attempt IDs. Cursors remain continuation hints, not credentials, and separate
page requests have weak snapshot consistency if the leaderboard changes
between them.

The generic Verse8 `PlatformGateway.leaderboard` and target feature remain
disabled. This service is a game-server verified leaderboard, not a Verse8
native leaderboard API.

## Structured-server acceptance

Run `pnpm smoke:verse8-agent8-acceptance` in mpgd-kit before handing off changes
to this integration. The harness invokes the real leaderboard boundary with an
ephemeral runtime secret and an in-memory structural Agent8 context. It proves
blank-account rejection, game-owned completion rejection, malformed structured
attempt rejection, authenticated participant matching, verified recording, and
account-scoped snapshot reads.

The same run creates a fresh game through the CLI and verifies that its Verse8
build/smoke commands and target metadata produce the expected effective target:
`verse8-web`, local storage by default, and no generic/native leaderboard. It
also rejects generated personal MCP, environment, credential, and auth-state
files. This is a deterministic contract check, not a deployed-server probe;
production endpoints, persistence secrets, encryption keys, and authentication
must remain runtime-injected in the separate game-owned Agent8 server.
