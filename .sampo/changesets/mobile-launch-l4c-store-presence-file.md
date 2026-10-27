---
npm/@mpgd/catalog: minor (Added)
---

New store presence file schema for the app's own store page (`StorePresence`, validated by `assertStorePresence(input)`): per Google Play language the title (30), short description (80), full description (4,000), YouTube promo video and graphics (icon, feature graphic, phone, 7-inch and 10-inch tablet screenshots), Play contact details, and per App Store locale the name (2-30), subtitle (30), description, keywords (100 bytes), promotional text, what's new, support, marketing and privacy policy URLs and screenshot sets for the 6.9", 6.5" and 6.3" iPhone and 13" iPad displays. A screenshot set is a list (add what the store lacks) or `{ files, complete: true }` (make the store match). `readStoreImageInfo(bytes)` reads a PNG or JPEG header (format, pixel size, alpha) without decoding, and `assertStorePresenceImage(slot, info, byteLength, label)` checks one image against the store's size, format and alpha rules. Existing files are unchanged.
