---
npm/@mpgd/platform: minor (Changed)
---

`assertNotificationDeployment` refuses an advertising sender name, contact, or opt-out line that is still a template placeholder (a `REPLACE-WITH-…` marker, an unreplaced `__TOKEN__`, a value in angle brackets, a reserved `example.com` address, or only `TODO`/`TBD`/`CHANGEME`/`PLACEHOLDER`/`XXX`), so a backend built from the starter's deployment file fails closed instead of sending advertising with an unusable sender line. `isNotificationPlaceholderText` exports the check.
