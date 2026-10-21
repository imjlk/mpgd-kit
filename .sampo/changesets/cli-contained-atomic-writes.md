---
npm/@mpgd/cli: patch
---

`mpgd legal build` keeps legal sources and the generated site inside the project. A symlinked `artifacts` directory, a symlinked legal page such as `legal/privacy.html`, or any other symlink component on `legal-dir` or `out-dir`, is refused, including when the link target is also inside the project. The site is published by renaming a temporary directory created on the destination filesystem, so a crash cannot leave a truncated page and a mounted `artifacts` directory does not fail the rename with `EXDEV`.

`mpgd kit upgrade` re-checks the planned game root, manifests, and lockfiles for symlink components immediately before each write, including rollback, and publishes those writes by renaming a temporary file. A game directory or parent swapped for a symlink after planning is no longer followed, and a `package.json` or lockfile swapped for a same-bytes symlink is no longer followed.
