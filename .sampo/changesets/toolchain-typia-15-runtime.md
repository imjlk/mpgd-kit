---
npm/@mpgd/analytics: patch (Changed)
npm/@mpgd/bridge: patch (Changed)
npm/@mpgd/catalog: patch (Changed)
npm/@mpgd/platform: patch (Changed)
npm/@mpgd/target-config: patch (Changed)
---

The runtime `typia` dependency moves from 13.0.2 to 15.2.1, and the shipped validators are rebuilt with typia 15 through ttsc 0.34.2. typia 15 validators differ in three places. `MinLength`/`MaxLength` count code points instead of UTF-16 units: a catalog store-presence `name` (minimum 2) or `email` (minimum 3) that relies on a single astral character, such as one emoji, to reach its minimum is now refused. `Type<'int64'>` checks the range of a bigint. The `date-time` and `date` formats refuse a day the month does not have and a space for `T`. Those timestamps were already refused by the notifications validators, but the error now comes from typia (`invalid type on $input.<field>`) instead of the kit's `<field> must be RFC 3339` or `must be a date that exists`. In `@mpgd/platform`, the typia-free commerce contract follows typia 15's tag records. The committed commerce and notifications JSON Schemas also drop their duplicate `NonEmptyString.o1` and `PositiveInteger.o1` components and name the remaining `ReadonlyRecord…` variants `-oN` instead of `.oN`.
