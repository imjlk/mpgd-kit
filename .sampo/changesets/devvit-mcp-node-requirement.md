---
npm/@mpgd/cli: patch
---

The generated Devvit target README now says to run the optional Devvit MCP
server on Node 22 or 24. `@devvit/mcp` 0.0.27 pins `better-sqlite3` 11.9.1,
whose native build fails on Node 26, and every launcher on a machine shares one
npx cache, so the README shows a Node-pinned registration through mise.
