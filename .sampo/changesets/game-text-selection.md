---
npm/@mpgd/cli: minor
---

Generated Phaser games now disable text selection game-wide by default.
`mpgd.game.json` accepts a `ui.textSelection` setting (`'disabled'` default or
`'enabled'` to restore the browser default), validated with the rest of the
game config at build time. Input fields, textareas, and contenteditable
elements remain selectable, and `markSelectable`/`unmarkSelectable` utilities
re-enable selection for individual UI elements.
