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
main-thread decoding. Adds a pinned `fflate` dependency for DEFLATE.
