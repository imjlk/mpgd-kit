---
npm/@mpgd/platform: patch (Fixed)
---

Reject a credit spend whose debits do not cover the price. An absolute comparison of `1e-9` treated `sameCreditAmount(0, 1e-9)` as equal, so `planCreditDebits` and `createCreditCommerceProvider` accepted an empty wallet (and an empty debit list) as payment for a price of `1e-9`. A later relative `1e-9` of the price turned that same constant into one credit at a price of `1e9`, so a balance of `999,999,999` was accepted for `1,000,000,000`.

Coverage no longer forgives a shortfall that grows with the price. Float residue may sit a few units in the last place under the price, capped at an absolute `1e-9`, so a one-credit gap is never a payment. `creditPriceMultiple` uses the same rule. Ordinary fractional amounts, including `0.1 + 0.2` and `0.7 + 0.1`, still spend.
