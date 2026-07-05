#!/usr/bin/env node

import { readCliArgs, runCreateGameCli } from '@mpgd/cli';

await runCreateGameCli(readCliArgs());
