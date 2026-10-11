---
npm/@mpgd/platform: minor
---

`@mpgd/platform` adds the commerce v2 conformance runner as the new
`./commerce-conformance` subpath. `runCommerceConformanceVector` and
`runCommerceConformanceVectors` execute the RFC vector files against a
provider and report `{ vector, passed, failures: [{ path, expected, actual }] }`,
matching only the listed expectation fields. The subpath also exports the
in-memory reference pieces every vector needs and that B-phase provider tests
can compose: a fake clock, a fake store with its `CommerceProvider`
(scripted `requestPurchase` and `finishTransaction` answers, buffered
pre-listener events, unfinished purchase listing), a fake backend with a
scripted verify queue and an append-only ledger with server-push grants,
revocations, and ledger status reads, a `CommerceJournalStore` interface with
an in-memory journal that keeps every state revision, the reference
reconciler runtime implementing the RFC purchase lifecycle (derived keys for
discovered purchases, `IN_PROGRESS` serialization per product, client, host,
server, and none finish owners, ledger-driven revocation), and a reference
credit wallet with a wallet-backed provider implementing the credit lot spend
order, idempotent spends and grants, and credit-funded memberships with
idempotent per-period renewal and lapse. All fourteen vectors pass with the
reference provider; `options.createProvider` lets another provider run the
same files. The protocol version stays `2.0.0-draft.1`.
