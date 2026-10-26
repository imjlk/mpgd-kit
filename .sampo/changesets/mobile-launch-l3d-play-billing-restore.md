---
npm/@mpgd/capacitor-play-billing: patch (Fixed)
---

A restore read (`getAvailablePurchases({ restore: true })`, the reconciler's Restore Purchases) lists every owned `purchased` entry of exactly one configured durable from `getPurchases`, acknowledged or not. The backend acknowledges a non-consumable at its first grant, so after a reinstall or on a new device it was never listed again and the new guest's Restore Purchases sent nothing. Acknowledged consumables, unmapped SKUs, and multi-line purchases stay filtered; recovery reads are unchanged.
