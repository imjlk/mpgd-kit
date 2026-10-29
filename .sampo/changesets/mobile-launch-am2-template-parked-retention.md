---
npm/@mpgd/cli: patch (Changed)
---

The generated game's purchase journal (`src/platform/monetizationJournal.ts`) bounds records parked as another account's purchase, which it kept forever as open records: they leave 30 days after their last write (the parking or the player's last Restore Purchases resend, `parkedRetentionMs`), at most the 20 most recently written are kept across every player of the install (`maxParkedRecords`), and the byte budget may drop them before granted purchases. Dropping one cannot lose a grant; at worst the purchase is verified once more and parked again. Every other open record is still kept, and the document format is unchanged, so older and newer games read each other's journals.
