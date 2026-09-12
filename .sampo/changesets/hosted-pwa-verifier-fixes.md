---
npm/@mpgd/cli: patch
---

Fix two correctness bugs in the hosted PWA deployment verifier's
`mpgd target verify-deployment` reference scan:

- External stylesheet checking never ran: the url()/@import pass iterated
  the normalized reference set before it was populated. Reference
  collection, normalization, stylesheet scanning, and the final existence
  check now run in that order, and chained `@import` files are followed
  with a visited set so circular imports terminate.
- `srcset` extraction re-scanned the raw attribute string and could read
  `srcset`-looking text out of unrelated attribute values such as
  `title='See srcset="./missing.png"'`, rejecting valid deployments.
  Attributes are now tokenized once per start tag and every attribute-
  driven check (resource names, srcset, style, srcdoc, meta refresh)
  shares that single parse, including the iframe srcdoc override guard.

Both regressions are covered by deployment smoke tests, including a
passing control case proving the failure comes from the stylesheet
reference check rather than stale release evidence.
