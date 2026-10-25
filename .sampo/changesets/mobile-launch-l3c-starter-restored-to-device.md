---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

The generated game's Restore Purchases control says "Restored to this device" (Korean: "이 기기로 구매를 복원했습니다") when the backend moved a purchase from an earlier guest of the same store account (a reinstall or a new device): `createStarterRestorePurchases` reports `moved` next to `granted`, and the template README explains restore transfers.
