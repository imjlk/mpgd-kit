---
npm/@mpgd/cli: patch
---

The generated Devvit target README now registers the optional Devvit MCP
server with `mise --no-config exec node@22 -- npx -y @devvit/mcp@0.0.27`.
`@devvit/mcp` 0.0.27 depends on `better-sqlite3` 11.9.1, which ships prebuilt
binaries for Node 22 but not 24 and does not build on 26, and `--no-config`
keeps mise-managed environment out of the server. The README also gives the
plain `npx` form for hosts without mise.
