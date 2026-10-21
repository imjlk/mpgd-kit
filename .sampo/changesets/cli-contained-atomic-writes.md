---
npm/@mpgd/cli: patch
---

`mpgd legal build` keeps legal sources and the generated site inside the project. A symlinked `artifacts` directory, or any other symlink component on `legal-dir` or `out-dir`, is refused, including when the link target is also inside the project. The site is published by renaming a temporary directory, so a crash cannot leave a truncated page.

`mpgd kit upgrade` re-checks manifests and lockfiles for symlink components immediately before each write, including rollback, and publishes those writes by renaming a temporary file. A `package.json` or lockfile swapped for a same-bytes symlink after planning is no longer followed.
