---
npm/@mpgd/cli: patch (Fixed)
---

Google Play submissions and promotions no longer fail on a track that already has a completed release. A new `completed` release now replaces the track's `completed` release, as well as any `inProgress` or `halted` rollout, instead of sending both and getting "Only one completed release is allowed." A staged rollout still keeps the `completed` release and a draft still replaces only an older draft. A `completed` release older than the one it would replace is now refused before anything is uploaded. `deploy submit` also recovers when the recorded edit is closed: on a 404 or failedPrecondition it reads the live track in a new edit and marks the release committed when the track already holds this version code and artifact, or submits it in the new edit otherwise.
