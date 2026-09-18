---
npm/@mpgd/cli: minor
npm/@mpgd/phaser-assets: minor
---

Add `mpgd assets verify-delivery`, a local read-only pre-deployment check
for built asset pack artifacts: `--manifest <asset-pack-delivery.json>
--root <artifact-directory>`. The command validates the manifest against
the shared pack-format contract, resolves every referenced path under the
root (rejecting absolute paths, traversal, symlinks and non-regular
files), streams and SHA-256-verifies every referenced file, decodes each
ZIP archive through the same pure core that powers runtime delivery
(exposing a narrow `@mpgd/phaser-assets/archive-validation` entry), and
optionally checks static-host object limits (`--max-object-bytes`,
`--max-files`, `--max-total-bytes`) against the full root inventory —
distinguishing referenced integrity from deployment budget — and caps the
largest archive it will read with `--max-archive-bytes` (512 MiB by
default) plus decompression bounds `--max-entry-bytes` (256 MiB) and
`--max-expanded-bytes` (1 GiB) that are independent of the manifest's own
declared sizes, failing in the limits stage before reading or decoding
oversized declarations. Reports carry
per-stage failure codes; `--json` emits a machine-readable report
(followed by a trailing newline; the CLI framework prints a one-line
program banner before it) and failures exit non-zero. The check never
modifies inputs, extracts archives, or contacts a network.
