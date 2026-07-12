# Devvit Durable Post Operations

Use `@mpgd/adapter-devvit/server` when a server action or scheduler must avoid
blindly creating the same Reddit custom post again after a retry. The coordinator
records a stable operation identifier and canonical post data before it invokes
Reddit, then keeps uncertain outcomes in reconciliation instead of submitting a
replacement post.

This is a **duplicate-safe and ambiguity-safe** contract, not an exactly-once
delivery guarantee. Reddit may accept a request even when its response is lost,
and a process may stop after the remote side effect but before the durable result
is written. Repeating `execute` for an attempted operation therefore returns
`reconciliation-required`; an explicit recovery path must call `reconcile` and
must not call the submit function again.

## Server Boundary

The coordinator and its store contract are exported from the server-only entry:

```ts
import {
  createDevvitPostOperationCoordinator,
  defineDevvitPostOperation,
} from '@mpgd/adapter-devvit/server';

import { createPostOperationStore } from './postOperationStore';
```

The target wrapper's `postOperationStore.ts` is intentionally thin. It passes the
Devvit Redis client to `createDevvitRedisPostOperationStore`, while the operation
coordinator depends only on `DevvitDurableOperationStore`. Keep `@devvit/web/server`
imports inside `apps/target-devvit`; Phaser scenes and shared domain packages must
not import the Devvit SDK.

## Operation Definition

Define one operation contract for each post kind. The definition declares a stable
`operationType` plus runtime parsers for `payload` and `launch.params`. Each call
uses `{ appScope, subredditId }` as its scope and supplies a stable `operationId`
for the logical publication slot. Do not key durable state by a display name or
title. `subredditId` must be the canonical lowercase Reddit `t5_*` fullname so
one subreddit cannot accidentally receive two durable fences.

The coordinator builds the canonical `{ mpgd, launch, payload }` envelope. All
three sections become public, untrusted post data, so parsers must return only
strictly validated JSON values. The coordinator validates the marker, launch
metadata, Reddit `t3_*` receipt, and encoded byte size before advancing durable
state. Keep private content and authoritative records in their appropriate
server-side stores.

Create a coordinator with the Redis-backed store. Supply the remote side-effect
callback to `execute` and the bounded lookup callback to an explicit `reconcile`
call:

```ts
const definition = defineDevvitPostOperation({
  operationType: 'scheduled-publication',
  parsePayload: parsePublicPayload,
  parseLaunchParams: parsePublicLaunchParams,
});

const coordinator = createDevvitPostOperationCoordinator({
  definition,
  store: createPostOperationStore(),
});

const descriptor = {
  scope: { appScope: 'example-app', subredditId: 't5_example' },
  operationId: 'daily:2026-07-12',
  payload: { title: 'Daily challenge' },
  launch: { entry: 'play', params: { publication: '2026-07-12' } },
};

const result = await coordinator.execute({
  ...descriptor,
  publish: async ({ postData }) => publishCustomPost(postData),
});

if (result.status === 'reconciliation-required') {
  await coordinator.reconcile({
    ...descriptor,
    findCandidates: async () => listRecentCustomPosts(),
  });
}
```

`publishCustomPost` must resolve to `{ postId }`; `listRecentCustomPosts` must
resolve to bounded `{ postId, postData }[]` candidates. Consult the exported
TypeScript types for exact callback inputs. Keeping the definition next to the
server route or scheduler makes the Reddit boundary explicit without coupling the
reusable coordinator to one post schema.

## Retry And Reconciliation Rules

- Persist the prepared operation before the first Reddit API call.
- Treat every exception from a submission call as outcome-unknown unless the
  coordinator can prove that the call was never attempted.
- Repeating `execute` for an attempted operation returns
  `reconciliation-required`; it never submits again.
- An explicit recovery endpoint or scheduler calls `reconcile` with a bounded
  candidate lookup.
- Reconciliation accepts only a post whose full canonical envelope matches.
- A missing match or a failed scan remains reconciliation-required. A bounded
  listing that did not find the post is not proof that Reddit rejected it.
- Expiring reconciliation leases coordinate workers, but the durable attempt
  claim is the duplicate-safety boundary. Lease expiry never restores submit
  permission.
- Malformed or conflicting durable state fails closed. Do not overwrite it with a
  fresh operation.
- Keep operator diagnostics free of private post content and credentials.

The coordinator converts callback exceptions into stable reconciliation reasons.
If callback-specific diagnostics are required, record them inside the callback
without logging the canonical public payload or credentials.

Call `execute` for the initial operation or an ordinary retry, `read` to inspect
durable state without causing a remote side effect, and `reconcile` from an
explicit recovery endpoint or bounded scheduled task. Surface pending or
unresolved outcomes to operators instead of describing them as successful.

## Acceptance Cases

At minimum, cover first success, duplicate invocation, process interruption after
the durable claim, response loss after Reddit accepts the post, lease expiry with
concurrent reconciliation, recovery without a second submission, malformed
stored state and launch metadata, and isolation across application and subreddit
scopes.
