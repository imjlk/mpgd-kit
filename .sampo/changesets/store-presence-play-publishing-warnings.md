---
npm/@mpgd/cli: patch (Changed)
---

`mpgd store presence plan --store google-play` warns, without blocking `apply`, when Play's default language listing would not meet Play's publishing requirements after the apply (Play's images plus the file's uploads and removals): no icon or no feature graphic, which Play needs to publish; fewer than 2 phone screenshots (Play needs at least 2 screenshots across device types to publish); or no 7-inch and no 10-inch tablet screenshots, which Play recommends. The warnings are printed as `warning` lines and carried in the plan's `warnings`; translations are not checked because they show the default language's graphics, and `apply` does not compute them. `store presence plan --json` prints the plan file (the same document `--out` saves) as one JSON document.
