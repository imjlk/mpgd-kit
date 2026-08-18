---
npm/@mpgd/adapter-browser: minor (Added)
---

Add a bounded WebView2 message bridge for native Microsoft Store catalog, purchase, ownership,
and User Collections ID operations. Native StoreContext hosts can now reuse the browser commerce
adapter without logging, persisting, or returning Store credentials, and without granting
purchases from client callbacks. The identity request sends its short-lived service ticket only to
the trusted native host operation that creates the User Collections ID.
