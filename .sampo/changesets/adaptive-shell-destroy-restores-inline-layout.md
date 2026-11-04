---
npm/@mpgd/target-config: patch (Fixed)
---

`mountAdaptiveGameShell(...).destroy()` now restores the inline layout the shell wrote. It removes the pixel `left`/`top`/`width`/`height`, `right`/`bottom: auto` and rail `display` from the shell, stage and rails, or puts back the inline value each property had before mount. `base.css` now insets the stage to fill the shell, so after teardown the stage follows the viewport instead of collapsing; the shell writes `right`/`bottom: auto` on the stage and rails while mounted. Before this fix those values stayed after teardown, so a fallback UI rendered into the stage after `destroy()` kept the last pixel box and did not follow rotation. A property the game changed after the shell's last write is left alone, and an element another live controller still writes, such as a shell shared by two stages, keeps its layout.
