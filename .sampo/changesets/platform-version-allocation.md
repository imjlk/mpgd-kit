---
npm/@mpgd/cli: minor
npm/@mpgd/target-config: minor
---

Add opt-in platform version allocation policies and a read-only preview
command.

`@mpgd/target-config` gains `allocatePlatformVersions`,
`assertPlatformVersionLedger`, and `formatHostedPwaShellVersions`: pure
computations that separate the game SemVer, the shared release revision
label, Android/iOS upload counters, and the Microsoft Store numbers — either
the legacy independent four-part policy or the opt-in
`hosted-pwa-shell-revision-v1` schema where one shell revision derives both
package numbers (`2.0.<r>.0` / `1.0.<r>.0`, third component bounded to
65535). Existing immutable plans are revalidated and reused without
consuming numbers; provenance changes allocate the next revision instead of
mutating a plan; hosted-content-only Store work consumes no Store number.
Inputs are validated up front (final SemVer, full Git SHAs, SHA-256 config
digests, counter ceilings including the documented Android maximum of
2100000000), and failures never partially update inputs. Results are
candidates, not reservations.

`mpgd target preview-versions` previews a ledger allocation as JSON or a
human summary, exits non-zero on validation failure, and never modifies its
input files. Ledger schema 1 is rejected rather than auto-migrated, and
unknown version policies fail instead of falling back to a default.
