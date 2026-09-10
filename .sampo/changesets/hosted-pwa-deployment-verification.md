---
npm/@mpgd/cli: minor
---

Add `mpgd target verify-deployment` for hosted Cloudflare Pages PWA
deployments. The command verifies that a deployment directory serves an
already-verified PWA artifact unchanged: every source file must exist with an
identical sha256 digest, the release evidence revision must recompute from
the real bytes, unrecognized files are rejected as cross-build contamination,
`_routes.json` must match one of the reviewed routing profiles
(`api-only` or `api-canonical-index`), and `_headers`/`_redirects` are parsed
and evaluated under the documented Cloudflare semantics (matching blocks apply
in order, duplicate headers comma-join, `!` removals clear the header) to
enforce the reviewed cache policy. Verification is read-only, writes JSON and
Markdown evidence, and exits non-zero on failure. PWA release primitives moved
from repo tooling into the package so the command works without a kit checkout.
