---
npm/@mpgd/analytics: minor (Changed)
---

`createBufferedAnalyticsSink()` now keeps only the most recent events: 1,000 by default (`defaultBufferedAnalyticsSinkCapacity`), or as many as the new `capacity` option sets (`0` keeps none). Before, it kept every event it was given for as long as the sink lived, so a game that created one at boot held every event of a long session in memory. Each event past the capacity drops the oldest; the kept events stay in order, and `events` is still one array that changes in place. The sink also gains `trackedCount`, which counts every event it accepted, including those it dropped: a running count that reads `events.length` stops at the capacity, so read `trackedCount` instead. A test that tracks more than 1,000 events into one sink passes a larger `capacity`, and an object written by hand as a `BufferedAnalyticsSink` needs a `trackedCount`.
