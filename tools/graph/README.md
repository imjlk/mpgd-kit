# Graph presets and preflight

`tools/graph/` runs the `@ttsc/graph` code graph locally, without the MCP
server, so CI can check that the graph still answers a fixed set of
architecture questions about this repository.

- `tools/graph/local-graph-runtime.mjs` dumps the graph with the native
  `ttscgraph` binary for a `cwd`/`tsconfig` pair, loads it into the in-process
  graph application, and validates preset results.
- `tools/graph/run-graph-presets.mjs` (`pnpm graph:preflight`) runs every
  preset under `tools/graph/requests/` and fails the build when a preset's
  contract is not met. CI runs it in the `build-web-targets` job.
- `tools/graph/inspect-local-graph.mjs` (`pnpm graph:inspect --preset <name>`,
  `pnpm graph:dump`) prints a preset's raw answer or the dump for debugging.

## What a preset is

A preset is one `inspect_typescript_graph` request plus the contract that its
answer must satisfy. The request fields (`question`, `draft`, `review`,
`request`) are the same union the MCP tool accepts, so a preset doubles as a
worked example of how to ask the graph about that subsystem.

```json
{
  "name": "target-release",
  "description": "Target build, validation, smoke, and release manifest flow.",
  "namedEntrypoints": [
    { "name": "executeNativeTargetBuild", "file": "tools/target/native-build-execution.ts" },
    { "name": "verifyTargetArtifacts", "file": "tools/smoke/verify-target-artifacts.ts" }
  ],
  "tsconfig": "tsconfig.graph.json",
  "question": "What are the central target build, validation, smoke, and release manifest flows?",
  "draft": { "reason": "Use a tour because the target pipeline crosses several tool modules.", "type": "tour" },
  "request": { "type": "tour", "includeTests": true }
}
```

Optional `cwd` and `tsconfig` select the graph project; the default is the repo
root with `tsconfig.graph.json`. File paths in `namedEntrypoints` are relative
to that `cwd`, exactly as the graph reports them.

## The named-entrypoint rule

Every preset declares `namedEntrypoints`: the `{ name, file }` pairs its
question is actually about. For a tour the runtime derives
`request.reinterpretations` from that list, so the names the tour seeds and
the names the preflight asserts are one list. The preflight passes a preset
when

1. the envelope's `next.action` is `answer`,
2. the result has at least one anchor, and
3. every named entrypoint is cited somewhere in the result by a graph node id
   whose file and symbol name match the declaration (`tools/target/x.ts` and
   `executeNativeTargetBuild`, or `Owner.member` for a method).

Only the result's own answer surface is searched, and only each entry's own
id. For a tour that is `entrypoints`, flow starts, flow `reached` nodes, and
the `nearby`/`tests`/`answerAnchors` entries that carry an id; for details it
is `nodes`. Ids nested below those entries do not count: a details node's
`calls`/`types` lists and `ambiguous[].candidates` cite symbols the request did
not resolve, and edge anchors such as `calls foo` carry the call-site file and
no id at all. A symbol with the same name in another file does not match, a
member must be named as `Owner.member`, and an entry may pin `kind`
(`function`, `method`, `variable`, ...) to exclude a same-named declaration of
another kind in the same file. Named entrypoints point at the declaring file;
a barrel re-export is a different node and is not where the graph cites the
symbol.

Test files are not asserted. A tour cites tests through the `tests` anchors it
derives from the seeds (test coverage of the cited symbols), and test variable
names are neither stable nor seedable, so a preset that cares about test
coverage says so in its `description` and relies on the tour's own test
anchoring rather than on a named entrypoint.

The preflight does not check which directories the ranked anchors land in. A
tour ranks the whole graph by centrality, and the ranking shifts when unrelated
code is added, so a directory-prefix check (`expectedFiles`) failed on feature
PRs that never touched the preset's subject. Named entrypoints are seeded into
the tour by exact name and matched by exact name, which removes the directory
drift; whether the tour cites a seeded name is still the tour's decision (see
below), so keep the lists short and verify them. `expectedFiles` is rejected
if a preset still declares it.

### How tours seed named symbols

`@ttsc/graph` caps a tour at five seeds (`limit` above five is ignored). The
symbols listed in `request.reinterpretations` are resolved as handles: a name
the project declares exactly once resolves, an ambiguous or unknown name is
silently dropped. Resolved names take half of the seeds, ranked among
themselves; the other half comes from centrality, and the tour then traces up
to four flows from the top seed candidates. Whether a named symbol is cited is
therefore still the tour's choice, but it is a choice made among the names the
preset supplied rather than across the whole graph.

Consequences for preset authors:

- `request.reinterpretations` is derived from `namedEntrypoints` and is not
  written in checked-in presets. An explicit field is accepted only when it is
  exactly the derived list; anything else is rejected. Only ad-hoc request
  files without `namedEntrypoints` spell the list out themselves.
- Extra reinterpretation hints would compete with the named entrypoints for
  the named seeds: with the old 14-22 item hint lists, `bootstrapStarter`,
  `createGameServicesBackend`, and `withTargetAvailability` were displaced by
  higher-scoring hints and dropped out of their tours. That is why the list is
  derived rather than hand-maintained.
- Pick names that are declared once in the graph project. If a name is
  declared more than once, name the method or variable the question is about
  (`Owner.member`) or pick a different symbol.
- Keep the list short (three to five symbols) and composed of the public or
  script-level functions the question names: the build runner, the validator,
  the smoke entry, the handler factory. Interfaces and type aliases are not
  tour seeds and cannot be named entrypoints. Names beyond the two to three
  that win entrypoint seats are usually cited as flow starts or reached nodes;
  confirm each one with `pnpm graph:preflight` before relying on it.

Details presets (`request.type: "details"`) pin exact `file#name:kind` handles
and derive their named entrypoints (kind included) from them automatically, so
they only need `namedEntrypoints` if the asserted set should differ from the
handles. Ad-hoc request files passed to `pnpm graph:inspect --request` do not
need `namedEntrypoints` at all, and bare-name details handles in them are
simply not asserted; only checked-in presets are asserted.

## Adding a preset

1. Write the question and pick the request type as you would for the MCP tool
   (`tour` for a flow or orientation question, `details` for a known set of
   handles).
2. Choose the named entrypoints from the modules the question is about and
   confirm each name is unique with `pnpm graph:dump` or `pnpm graph:inspect`.
3. Add `tools/graph/requests/<name>.json` with `namedEntrypoints`; a tour
   needs no `request.reinterpretations`, the runtime derives it.
4. Run `pnpm test:tooling` (schema, on-disk existence, and drift tests) and
   `pnpm graph:preflight` (the real graph).
5. Optionally add a `graph:<name>` script in the root `package.json` for
   interactive use.

## Feature PRs and preflight failures

Feature PRs must not edit presets to make `pnpm graph:preflight` pass. If the
preflight fails on a PR, one of these is true:

- The PR renamed, moved, or removed a named entrypoint. Update the preset's
  `namedEntrypoints` to the new name or file in the same PR; that is a
  contract change the preset exists to surface.
- The PR introduced a second declaration of a named entrypoint's name, so the
  graph can no longer resolve the hint. Either rename the new symbol or qualify
  the preset entry (`Owner.member`).
- The graph dump itself failed (`ttscgraph dump` exit code, missing native
  binary). Fix the toolchain, not the preset.

Do not add reinterpretation hints, fold modules together, or change the
question to steer the ranking back toward a directory. If a preset's named
entrypoints genuinely no longer describe what the question is about, change
them in a tooling PR that says so.

## Tests

`tools/graph/run-graph-presets.test.mjs` runs the preset check against a
synthetic tour answer whose ranked anchors have all drifted out of the
preset's directories: it passes while the named entrypoints are cited and
fails, naming the missing symbol and file, when one is absent. It also covers
Windows path separators, edge anchors without ids, same-name symbols in other
files, details handle derivation, and the on-disk existence of every
checked-in preset's named entrypoints. `tools/graph-runtime.test.mjs` keeps the
request-shape checks. Both run under `pnpm test:tooling`.
