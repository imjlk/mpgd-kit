---
npm/@mpgd/game-services: patch (Fixed)
---

Keep the operation client declarations independent of catalog schema and DOM
types. Headless TypeScript consumers can check `@mpgd/game-services/operations`
with `lib: ["ES2022"]`, no ambient Node types, and `skipLibCheck: false`.
