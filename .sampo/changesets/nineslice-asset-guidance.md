---
npm/@mpgd/cli: patch
---

Generated games now document how to ship stretchable UI art for Phaser 4
`NineSlice`: untrimmed atlas frames carry `scale9Borders`, so scenes create
them with `this.add.nineslice(x, y, key, frame)` instead of hard-coding slice
insets. The workflow guide and `use-mpgd-kit` skill point to the optional
external slicewright tool for generating and checking that art.
