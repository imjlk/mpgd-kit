---
npm/@mpgd/adapter-ait: patch (Fixed)
---

Provide a shared AIT WebView authority fetch helper that calls injected native fetch without a dependency-object receiver, preventing valid purchase-grant requests from failing before reaching the server on iOS.
