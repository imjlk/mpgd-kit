---
npm/@mpgd/target-config: patch (Fixed)
---

`mountAdaptiveGameShell(...).destroy()` now restores the inline layout the shell wrote. It removes the pixel `left`/`top`/`width`/`height`, `right`/`bottom: auto` and rail `display` from the shell, stage and rails, or puts back the inline value each property had before mount. Before this fix those values stayed after teardown, so a fallback UI rendered into the stage after `destroy()` kept the last pixel box and did not follow rotation. A property the game changed after the shell's last write is left alone, and so is an element a newer controller has written since.
