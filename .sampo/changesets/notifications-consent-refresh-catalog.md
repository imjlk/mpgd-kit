---
npm/@mpgd/catalog: patch (Changed)
---

The notification topic catalog validator checks the deployment's `consentRefresh` (RFC "Consent refresh"): under `kr` it reports one, since the Korean rules fix the refresh; elsewhere it reports a push lead longer than the notice lead or a notice lead as long as the interval, and requires the `notices` block, its topic mapped on every target that maps an advertising topic.
