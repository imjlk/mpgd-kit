---
npm/@mpgd/cli: patch
---

Make Devvit inline budget checks follow HTML attributes and JavaScript import
syntax instead of matching source text. Count inline style assets and distinct
query URLs, and reject unverifiable external first-load resources when an inline
budget is configured. Inspection reports external references without enforcing a
budget. Entries with base href must emit artifact-relative URLs instead.
