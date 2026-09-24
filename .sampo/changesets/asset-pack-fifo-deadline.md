---
npm/@mpgd/cli: patch
---

Use nonblocking POSIX reads for FIFO delivery manifests so a stalled writer cannot hold verification past its deadline. Keep the timeout smoke writer owned by the test and verify that a streamed manifest still succeeds.
