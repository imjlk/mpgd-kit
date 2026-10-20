# Local integration corrections

`skills-lock.json` `computedHash` is the reviewed SHA-256 of this installed skill directory after the local corrections below, not the raw `npx skills` hash of upstream. `pnpm oneplay:skill:check` recomputes that digest (every regular file, CRLF normalized to LF, paths sorted with `en` localeCompare, each relative path then its bytes) and rejects a mismatch. It also rejects a refresh that drops the corrections below even if the lock hash is rewritten.

After `npx skills add ONE-store/onestore_web_sdk_skills`, reapply these corrections and update `computedHash` to the new reviewed hash before the drift check can pass. Do not adopt upstream text that tells the client to invent `developerPayload` or `requestId`.

## Corrections

- `references/game-template.html.txt` adds a shared game bootstrap and a mandatory game-owned purchase verification hook. That hook fails closed until the game supplies its authenticated backend. Tower uses the tested PlatformGateway implementation instead of this illustrative HTML.
- `references/sdk-context.md` treats PNS as a backup signal, not a delivery guarantee. Independently verify purchases through the server API.
- `SKILL.md` section 4, `references/checks.md` A12-1, `references/sdk-context.md`, and the HTML sample require a server-issued opaque developerPayload bound to an authenticated checkout intent. They do not accept an account key in that slot.
- The HTML sample obtains `developerPayload` from `issueCheckoutIntent()` and `requestId` from `issueRewardRequest()`. Both throw until the game implements the authenticated server endpoint. Client-generated request ids are not allowed.
- `references/checks.md` A10 and B6 require a server-issued `requestId` bound to the authenticated session, not merely a present `requestId`. There is no separate doctor runner in `tools/oneplay`; the drift check keeps this wording.

The payment checklist distinguishes transaction correlation from account mapping.
