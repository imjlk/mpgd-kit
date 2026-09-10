---
npm/@mpgd/i18n: patch
---

Align the i18n toolchain with the workspace TypeScript 7.0.2 standard.
`@inlang/paraglide-js` moves from 2.20.2 to 2.25.1, which compiles the
inlang project under TypeScript 7; the local `typescript` devDependency
pin of 5.9.3 (kept for the pre-7 paraglide compiler) is no longer needed.
Generated paraglide output is unchanged.
