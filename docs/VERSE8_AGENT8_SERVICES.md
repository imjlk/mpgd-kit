# Verse8 Agent8 Storage and Verified Leaderboards

`@mpgd/adapter-verse8` keeps the iframe client independent of the React-based
Agent8 browser SDK. A game may inject its own authenticated RPC wrapper for
cloud saves, while `@mpgd/adapter-verse8/agent8` supplies server-only helpers
for Agent8 user state and collections.

The default starter does not configure either integration. Keep cloud storage
and the generic leaderboard unavailable until the game owns the Agent8 server,
RPC authentication, and deployment lifecycle.

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

const storage = createVerse8Agent8StorageService();

export class Server {
  loadMpgdSave(input: { readonly key: string }) {
    return storage.load($sender.account, input, context);
  }

  saveMpgdSave(input: { readonly key: string; readonly value: unknown }) {
    return storage.save($sender.account, input, context);
  }
}
```

The helper stores versioned JSON values under `mpgdVerse8Storage`, serializes
updates per account, clones values across the boundary, rejects malformed
stored state, and applies bounded entry, value, and namespace-state limits.
Adjust the limits explicitly when a game has measured Agent8 storage quotas.

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

Agent8 global collections may be client-subscribable. The provider therefore
stores only public retained-entry fields plus SHA-256 identity digests. It does
not persist verification evidence or the raw history of non-retained attempts.
Board and attempt collection IDs are also derived from bounded digests rather
than raw game identifiers.

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
