---
npm/@mpgd/catalog: minor (Added)
---

The store presence file's `appStore` section takes `copyright` (the version's copyright line) and `review` (App Review contact, notes, and a demo account named by environment variables, never by value), read by `mpgd store release`. `assertStorePresence` checks the contact email and phone (with its country code), the 4,000-character notes limit, and that `demoAccount.nameEnv` and `passwordEnv` are distinct environment variable names. New exports: `AppStorePresenceReview`, `AppStorePresenceReviewContact` and `AppStorePresenceDemoAccount`.
