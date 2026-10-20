---
npm/@mpgd/cli: patch
npm/@mpgd/create-game: patch
---

`mpgd game create` and `pnpm create @mpgd/game` keep `$&`, `$'`, `` $` ``, and `$$` in a display title literal. Those sequences are no longer read as replacement patterns, so a title such as `Hit $&` no longer leaves `__GAME_TITLE__` in `notifications/topics.json` or injects the rest of a JSON file. Titles may also contain quotes and backslashes. Generated JSON escapes them, and single-quoted TypeScript titles escape quotes and backslashes, so the generated source still parses. Control characters and angle brackets are still refused.

The generated notification settings scene wraps the outcome strip to the same 840px column as the list and moves the list down when that strip wraps, so the English stale-night consent message stays on the 960x540 canvas.
