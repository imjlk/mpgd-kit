# Local integration corrections

The installed upstream skill lock records the upstream revision, not these local edits.
`references/game-template.html.txt` adds a shared game bootstrap and a mandatory game-owned
purchase verification/reconciliation hook (Kit review #398). After running `skills add`,
review and reapply these corrections if upstream has not incorporated them. The template
hook intentionally fails closed until the game supplies its authenticated backend.
Tower uses the tested PlatformGateway implementation instead of this illustrative HTML.

The payment checklist distinguishes transaction correlation from account mapping; PNS is a backup signal rather than a delivery guarantee.
