---
npm/@mpgd/game-services: patch
---

Harden notifications delivery. FCM sets `android.collapse_key` and `apns-collapse-id` to the SHA-256 of the send key (64 bytes) so a replay after HTTP 200 collapses instead of showing a duplicate. Apps in Toss functional-message `baseUrl` must be `apps-in-toss-api.toss.im` unless `allowUnlistedHost` is set. Documented partner error codes (4095, 5004, 4034, 4010) are classified before a deployment's `agreementErrorCodes` or `recipientErrorCodes`, so a rate limit is not stored as an agreement denial.
