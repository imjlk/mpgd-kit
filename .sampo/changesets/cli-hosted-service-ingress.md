---
npm/@mpgd/cli: patch (Fixed)
npm/@mpgd/game-services: minor (Added)
---

Allow hosted web and Microsoft Store PWA production targets to use a clean same-origin `/api` game-services path for an authoritative edge service binding. Keep absolute public HTTPS requirements for native and third-party runtimes, and reject protocol-relative, encoded, traversal, query and fragment paths.

Add the DOM-free `resolveGameServicesBaseUrl` composition helper and wire starter commerce/notification clients to resolve a hosted path against the actual browser origin before the existing absolute-URL authority checks. Invalid or native relative inputs remain fail-closed without a backend fallback.
