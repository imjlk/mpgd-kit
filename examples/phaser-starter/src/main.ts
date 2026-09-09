import './styles.css';

import gameProjectConfig from '../mpgd.game.json';

import { bootstrapStarter } from './bootstrap';
import { installTextSelectionPolicy, resolveTextSelectionMode } from './platform/textSelection';

installTextSelectionPolicy(
  resolveTextSelectionMode((gameProjectConfig as { readonly ui?: unknown }).ui),
);

await bootstrapStarter();
