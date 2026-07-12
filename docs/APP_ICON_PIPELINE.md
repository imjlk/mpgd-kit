# App Icon Pipeline

mpgd games keep one required canonical app icon source in `mpgd.game.json`. The
kit validates that source and derives target artifacts with versioned icon
profiles instead of copying one resized file everywhere.

```json
{
  "brand": {
    "appIcon": {
      "source": "assets/brand/app-icon.png",
      "backgroundColor": "#f8fafc",
      "variants": {
        "maskable": "assets/brand/app-icon-maskable.png",
        "androidForeground": "assets/brand/app-icon-foreground.png",
        "monochrome": "assets/brand/app-icon-monochrome.png",
        "background": "assets/brand/app-icon-background.png"
      }
    }
  }
}
```

`source` is required and may be PNG or SVG. PNG input must be square and at
least 1024x1024. SVG input must have a square `viewBox` and be self-contained.
Scripts, event handlers, external images, external stylesheets, and external
URLs are rejected. Production validation also rejects SVG text so output does
not depend on an ambient font installation.

Configured optional fields must be non-empty strings. Unknown `appIcon`,
target override, and variant keys fail validation instead of silently falling
back to a different asset.

Legacy `brand.icon` and `brand.maskableIcon` fields are normalized with a
deprecation warning. New games should use `brand.appIcon`.

## Target Profiles

| Profile | Output contract |
| --- | --- |
| `web-preview` | 32, 192, and 512 PNG icons with alpha |
| `microsoft-pwa` | separate 192/512 `any` and opaque `maskable` PNG icons |
| `devvit` | 1024 PNG, no more than 500 KiB (512000 bytes), staged into the Devvit app root |
| `ait` | opaque, square 600 PNG for Apps in Toss console upload |
| `android` | adaptive foreground/background, optional monochrome, and legacy density icons |
| `ios` | opaque 1024 PNG connected to the single-size AppIcon asset catalog |

Generated files live under
`.mpgd/generated/icons/<canonical-sha>/<profile>/<target>`. They are disposable
build outputs and should not be committed. Target builds copy the required
files into web artifacts or wrapper/native staging locations. Native reference
shell resources are restored after the build.

Each target artifact embeds `mpgd-icon-manifest.json`. The release manifest
records its SHA-256, canonical source SHA-256, generator version, and target
profile version. Smoke verification rejects stale or mismatched evidence.

## Overrides And New Targets

Targets may select a profile and override rendering inputs without changing the
global canonical source contract:

```json
{
  "targets": {
    "microsoft-store": {
      "kind": "web",
      "gameApp": ".",
      "adapter": "browser",
      "output": "artifacts/microsoft-store",
      "icon": {
        "profile": "microsoft-pwa",
        "backgroundColor": "#ffffff",
        "source": "assets/brand/store-icon.png",
        "variants": {
          "maskable": "assets/brand/store-maskable.png"
        }
      }
    }
  }
}
```

An override source is recorded as `renderSource`; `canonicalSource` remains the
shared game source so release evidence makes the divergence explicit. To add a
new distribution target, add a versioned profile to
`tools/icons/profiles.ts`, map or configure its `icon.profile`, and add its
staging/verifier contract. Output sizes and paths belong to the profile, not to
each game config.

## Commands

From a generated game:

```sh
pnpm icons:generate
pnpm icons:verify
pnpm icons:inspect
```

The equivalent public CLI commands are:

```sh
mpgd game icons generate . --targets web-preview,microsoft-store
mpgd game icons verify . --targets reddit --profile production
mpgd game icons inspect .
```

Target builds generate and verify their selected profile automatically.

Apps in Toss remains a two-step release flow. Generate the 600x600 asset,
upload it in the Apps in Toss console, then set the returned HTTPS URL as the
AIT target's `icon.externalUrl`. Production AIT package builds fail until that
URL is configured; wrapper preview builds may use the local generated file.

## Platform References

- [Reddit Devvit Web configuration](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration)
- [Microsoft PWA icons](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/icon-theme-color)
- [Apps in Toss branding guide](https://developers-apps-in-toss.toss.im/design/miniapp-branding-guide)
- [Android adaptive icons](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)
- [Apple app icon configuration](https://developer.apple.com/documentation/xcode/configuring-your-app-icon/)
