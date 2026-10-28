---
npm/@mpgd/cli: patch (Fixed)
---

The generated game's Delete account entry no longer warns that a purchase is still being processed because of a journal record parked as another account's purchase (`isParkedForAnotherAccount` from `@mpgd/game-services`): such a record is not a purchase of this player in progress.
