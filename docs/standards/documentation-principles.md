# Documentation principles

These are review obligations for user guides, not runtime behavior specs.

## Readiness levels {#readiness-levels}

Distinguish a shared type or conformance helper from an adapter implementation,
device verification, and release readiness. Do not promote one level into the
next without separate evidence.

## Failure and unsupported paths {#failure-paths}

Explain what callers should do when a capability is absent or an operation
fails after a positive availability read. A capability snapshot is not an
authorization or a guaranteed operation result.

## Execution context {#execution-context}

State where a command or example runs, what it validates, and what it cannot
validate. A local automated test must not be presented as a real-device check.
