---
npm/@mpgd/catalog: minor (Changed)
---

The runtime `typia` dependency moves from 13.0.2 to 15.2.1, and the shipped validators are rebuilt with typia 15 through ttsc 0.34.2. A game that runs its own typia transform over `@mpgd/catalog` types now needs typia 15.2 or later, because typia 15's tag records emit runtime helpers that typia 13 does not have. `MinLength` counts code points instead of UTF-16 units. A store-presence `name` (minimum 2) or `email` (minimum 3) that reaches its minimum only through a single astral character, such as one emoji, is now refused. Topic-copy errors keep their `expected (string & MinLength<1>)` text.
