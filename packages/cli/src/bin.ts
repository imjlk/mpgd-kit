#!/usr/bin/env node

import { mpgdCliNeedsForcedExit, readCliArgs, runMpgdCli } from './index.js';

await runMpgdCli(readCliArgs());

if (mpgdCliNeedsForcedExit()) {
  // Stalled threadpool filesystem work cannot be cancelled; only the
  // standalone binary may terminate the process to outrun it.
  process.exit(process.exitCode ?? 1);
}
