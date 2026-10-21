---
npm/@mpgd/platform: patch (Fixed)
---

Reject a credit spend whose debits do not cover the price. An absolute comparison of `1e-9` treated `sameCreditAmount(0, 1e-9)` as equal, so `planCreditDebits` and `createCreditCommerceProvider` accepted an empty wallet (and an empty debit list) as payment for a price of `1e-9`.

Coverage no longer forgives a shortfall of the whole price. Float noise may sit above the price, or a relative sliver under it that cannot be the price itself. `creditPriceMultiple` uses the same rule, so a gap of one tiny unit is not a whole multiple. Ordinary fractional amounts, including `0.1 + 0.2` and `0.7 + 0.1`, still spend.
