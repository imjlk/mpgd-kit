import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { devvitOutputCollisionPlugin } from './devvit-output-collisions';

// Resolve the wrapper's Vite major (Devvit currently uses Vite 7), not the
// kit root's Vite. Like the Vite CLI, honor Devvit's multi-environment builder.
const wrapperRequire = createRequire(join(process.cwd(), 'package.json'));
const { createBuilder }: typeof import('vite') = await import(
  pathToFileURL(wrapperRequire.resolve('vite')).href
);
const builder = await createBuilder(
  {
    mode: process.argv[2] ?? 'production',
    plugins: [devvitOutputCollisionPlugin()],
  },
  null,
);
await builder.buildApp();
