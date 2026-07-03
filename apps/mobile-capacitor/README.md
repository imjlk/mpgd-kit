# MPGD Capacitor Shell

This shell receives the Phaser web build in `www/`.

Initial target builds copy web assets only. Native projects should be generated later with:

```sh
pnpm --dir apps/mobile-capacitor cap add android
pnpm --dir apps/mobile-capacitor cap add ios
```
