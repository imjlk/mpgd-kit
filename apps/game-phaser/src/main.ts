import './styles.css';

import { createGame } from './runtime/createGame';
import { installPlatform } from './platform/installPlatform';
import { detectRuntime } from './platform/runtimeDetector';

const runtime = detectRuntime();
const platform = await installPlatform(runtime);

createGame({
  mountId: 'game',
  platform,
});
