---
npm/@mpgd/cli: minor (Added)
---

Enable standalone Lite game generation with the independently versioned
`@mpgd/lite-shell` package. Record its version in the packed CLI manifest so
generation outside a Kit checkout never substitutes the CLI version. Validate
the shell's installed ESM and NodeNext declarations and exercise packed Lite
consumers in Windows acceptance.
