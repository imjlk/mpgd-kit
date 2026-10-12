---
npm/@mpgd/cli: minor
---

- The Microsoft Store submission preflight now checks the manifest's
  `start_url`, `scope`, and icon `src` with `normalizeRootRelativeRoute` from
  `@mpgd/platform/routes`: `.` followed by a route already in its normalized
  form. It now also refuses a URL whose path a client that percent-decodes it
  could read as another host, such as `./%2F%2Fevil.example/`. `@mpgd/platform`
  is now a dependency of the CLI.
- Generated games pass the game's Apps in Toss app name to
  `createAitSandboxBridge({ appName })` in `pnpm dev:ait`. It is
  `MPGD_AIT_APP_NAME`, else the `ait` target's `metadata.appName`, else the game
  name, the same name the wrapper's host bridge uses. Before, the sandbox
  defaulted to `mpgd-kit` and refused the game's own `intoss://<app>` share
  links.
