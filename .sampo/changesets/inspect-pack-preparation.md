---
npm/@mpgd/phaser-assets: minor
---

Add `delivery.inspectPreparation(packId)`: a read-only preparation cost
plan computed from the manifest snapshot and the current staging state —
dependency-ordered closure, per-pack cold artifact list (one object per
ZIP archive, one per files-delivery file), cold object count and
manifest body-bytes sum, ZIP packs already staged versus the ones a
prepare would stage, the additional staging reservation under the
current archive-plus-expanded policy, current/projected staging usage
against the budget with `fitsBudget`, and the current busy state. The
inspection starts nothing and reserves nothing; `prepare` runs the same
pure planner on live state so a stale inspection can never bypass
admission. Byte sums are overflow-checked, and an `accountingModel`
identifier pins what the reservation numbers cover (staging only — not
transport copies, decoder internals, decoded pixels or GPU resources).
