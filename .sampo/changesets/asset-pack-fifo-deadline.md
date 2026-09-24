---
npm/@mpgd/cli: patch
---

Use nonblocking POSIX reads for FIFO delivery manifests so a stalled writer cannot hold verification past its deadline. Bound the initial wait for a FIFO writer to one second, so an empty writer that disconnects between read polls is rejected as an invalid manifest instead of consuming the full verification budget. Keep FIFO smoke writers owned by their tests and verify both stalled and streamed cases.
