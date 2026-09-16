---
npm/@mpgd/phaser-assets: minor
---

Add bounded ZIP pack decoding. The new `@mpgd/phaser-assets/archives` subpath
decodes the ZIP v1 delivery profile against the shared manifest contract under
explicit limits (archive/entry/total-expanded bytes, entry count, path length,
decode deadline, concurrency), counting inflated output while it is produced.
Archive and entry integrity is mandatory. The `archive-worker` subpath is an
application-deployed module worker entry; the client enforces one-outstanding-
entry backpressure, per-job cancellation with late-message protection and
distinct worker-crash/deadline statuses, never silently falling back to
main-thread decoding. The decode deadline is one absolute budget from slot
acquisition through returned-archive verification (queue wait excluded); the
worker receives only the unspent remainder, completion inside the cleanup
grace cannot turn a decided deadline into success, and cancellation shares a
single cooperative cleanup window. The worker-message boundary is hardened end to
end: worker buffers must be genuine ArrayBuffers in any realm (shared,
detached and forged buffers are rejected), every message field is captured
once through a guarded read that settles the job when a getter throws,
terminal statuses fix their failure codes (detailed codes only accompany
error statuses), and settled jobs release their worker reference after
best-effort termination. Adds a pinned `fflate` dependency for
DEFLATE.
