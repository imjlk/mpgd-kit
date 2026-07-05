#!/usr/bin/env node

import { readCliArgs, runMpgdCli } from './index.js';

await runMpgdCli(readCliArgs());
