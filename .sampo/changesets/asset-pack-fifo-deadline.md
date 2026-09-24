---
npm/@mpgd/cli: patch
---

Use nonblocking POSIX reads for FIFO delivery manifests so a stalled writer cannot hold verification past its deadline. An observed empty writer disconnects promptly as an invalid manifest. Keep FIFO smoke writers owned by their tests and verify both stalled and streamed cases.
