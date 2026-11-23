---
npm/@mpgd/cli: patch (Changed)
---

The Phaser and lite game templates now create their analytics sink with `createBufferedAnalyticsSink({ capacity: 100 })`, so a long session keeps only the latest 100 events in memory instead of every event. The sink is a debug buffer and sends nothing; the Phaser Play scene's event count now reads `trackedCount`, which still counts every event. An existing game that kept the template's `createBufferedAnalyticsSink()` keeps at most 1,000 events once it updates `@mpgd/analytics`; if it shows a count from `events.length`, switch it to `trackedCount` as the template did, or the count stops at that limit.
