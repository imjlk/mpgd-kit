---
npm/@mpgd/platform: minor (Changed)
---

Under the Korean advertising rules, `assertNotificationDeployment` refuses an advertising sender name, contact, or opt-out line that is still a common template marker (a `REPLACE-WITH-…` marker; a whole value that is an unreplaced `__TOKEN__`, `{{token}}`, `${token}`, `<token>`, or `[token]`; a reserved `example.com` address; or only `TODO`/`TBD`/`CHANGEME`/`PLACEHOLDER`/`XXX`), so a backend built from the starter's deployment file fails closed instead of sending advertising with an unusable sender line. `isNotificationPlaceholderText` and `notificationDeploymentPlaceholders` export the check, and `assertNotificationDeployment(input, { allowPlaceholders: true })` lets a validator report placeholders itself.
