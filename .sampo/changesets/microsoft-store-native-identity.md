---
npm/@mpgd/adapter-browser: minor
---

Add a bounded WebView2 message bridge for native Microsoft Store player sign-in, catalog,
purchase, and ownership operations. Native StoreContext hosts can now reuse the browser commerce
adapter without granting purchases from client callbacks. The sign-in contract keeps the Microsoft
ID token, publisher ticket, and User Collections ID inside the trusted native host and returns only
a short-lived game-scoped session to web content.
