---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

The generated game's Restore Purchases control says "Restored to this device" (Korean: "이 기기로 구매를 복원했습니다") when the backend granted this player a purchase another guest of the same store account made or holds (a reinstall, a new device, a second device), and "This purchase is already in use on the maximum number of devices" (Korean: "이 구매는 이미 허용된 최대 기기 수에서 사용 중입니다") when the backend's holder limit refused it. `createStarterRestorePurchases` reports `restoredHere` and `atHolderLimit`; the template README explains restore sharing.
