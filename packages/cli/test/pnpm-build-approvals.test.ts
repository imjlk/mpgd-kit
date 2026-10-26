import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { notificationsGameDependencies } from '../src/notifications-starter.js';
import {
  addAllowBuilds,
  allowBuildsPackageName,
  notificationsBuildApprovals,
  planNotificationsBuildApprovals,
} from '../src/pnpm-build-approvals.js';

/**
 * Every package with a `preinstall`, `install`, or `postinstall` script (or a
 * `binding.gyp`) that installing the notifications starter's packages brings
 * in. Recorded 2026-10-26 from a pnpm 11.7.0 install of firebase 12.19.0,
 * @capacitor-firebase/messaging 8.5.2, @capacitor-firebase/crashlytics 8.5.2,
 * @capacitor/local-notifications 8.3.1, and @capacitor/core 8.5.2 with no
 * allowBuilds, which stopped with
 * `ERR_PNPM_IGNORED_BUILDS Ignored build scripts: @firebase/util@1.15.3, protobufjs@7.6.6`
 * and matched a scan of every installed package.json. Redo it when the
 * starter's firebase version changes.
 */
const firebaseTree = {
  firebase: '12.19.0',
  buildScripts: {
    '@firebase/util': '1.15.3 postinstall: node ./postinstall.js',
    protobufjs: '7.6.6 postinstall: node scripts/postinstall',
  },
} as const;

function resolveTemplate(): string {
  const relative = path.join('packages', 'cli', 'templates', 'phaser-game', 'pnpm-workspace.yaml');
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    fileURLToPath(new URL('../../..', import.meta.url)),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0 && existsSync(path.join(root, relative))) {
      return path.join(root, relative);
    }
  }
  throw new Error(`Cannot locate ${relative} from ${candidates.join(', ')}.`);
}

// A firebase bump must redo the list above, and every listed script has a decision.
assert.equal(
  notificationsGameDependencies.firebase,
  firebaseTree.firebase,
  'the notifications starter moved firebase: redo the build-script list in this test',
);
assert.deepEqual(
  Object.keys(notificationsBuildApprovals).sort(),
  Object.keys(firebaseTree.buildScripts).sort(),
);

// A generated game's workspace already lists each one with the same decision,
// so `pnpm install` on a fresh notifications game passes under pnpm 11.
const template = readFileSync(resolveTemplate(), 'utf8');
assert.deepEqual(addAllowBuilds(template, notificationsBuildApprovals), { kind: 'covered' });
assert.match(template, /^ {2}'@firebase\/util': false$/mu);
assert.match(template, /^ {2}protobufjs: true$/mu);

assert.equal(allowBuildsPackageName('esbuild'), 'esbuild');
assert.equal(allowBuildsPackageName('nx@21.6.4 || 21.6.5'), 'nx');
assert.equal(allowBuildsPackageName('@firebase/util@1.15.3'), '@firebase/util');
assert.equal(allowBuildsPackageName('foo@git+ssh://git@example.com/org/foo.git'), 'foo');

// An older game workspace gets the missing entries right under the key, at
// its indentation, and keeps everything else, including its own decisions.
{
  const older = [
    '# Game workspace.',
    'packages:',
    "  - '.'",
    'allowBuilds:',
    '    esbuild: true',
    '    protobufjs: false',
    'overrides:',
    "  '@xmldom/xmldom': '0.9.12'",
    '',
  ].join('\n');
  const content = older.replace('allowBuilds:\n', "allowBuilds:\n    '@firebase/util': false\n");
  assert.deepEqual(addAllowBuilds(older, notificationsBuildApprovals), {
    kind: 'edited',
    content,
    added: ['@firebase/util'],
  });
  assert.deepEqual(addAllowBuilds(content, notificationsBuildApprovals), { kind: 'covered' });
}

// Quoted keys and comments inside the block count.
assert.deepEqual(
  addAllowBuilds(
    'allowBuilds:\n  # reviewed\n  \'@firebase/util\': false\n# kept\n  "protobufjs": true\n',
    notificationsBuildApprovals,
  ),
  { kind: 'covered' },
);
// A version-qualified entry reviews only that version (pnpm still stops on
// another one), and a bare entry next to it would override it: the game decides.
assert.deepEqual(
  addAllowBuilds(
    "allowBuilds:\n  '@firebase/util@1.15.2': true\n  protobufjs: true\n",
    notificationsBuildApprovals,
  ),
  { kind: 'unsupported', missing: ['@firebase/util'] },
);
// Forms the line scan cannot read in full are left to the game instead of
// risking a duplicate key: a value on its own line, a nested key at another
// indentation, a sequence.
for (const block of [
  "allowBuilds:\n  '@sentry/cli':\n    true\n  protobufjs: true\n",
  'allowBuilds:\n  esbuild: true\n    protobufjs: true\n',
  'allowBuilds:\n  - esbuild\n',
  // Inherited decisions: a merge key (here an inherited `protobufjs: false`
  // that an inserted `protobufjs: true` would override), an anchored or
  // aliased value, and a tagged one.
  'buildDecisions: &decisions\n  protobufjs: false\nallowBuilds:\n  <<: *decisions\n  esbuild: true\n',
  'allowBuilds:\n  esbuild: true\n  <<: [*a, *b]\n',
  "allowBuilds:\n  '@firebase/util': &deny false\n  protobufjs: *deny\n",
  'allowBuilds:\n  protobufjs: !!bool true\n',
]) {
  assert.equal(addAllowBuilds(block, notificationsBuildApprovals).kind, 'unsupported', block);
}
// A comment after the key and tab indentation are read.
assert.deepEqual(
  addAllowBuilds('allowBuilds: # reviewed\n\tesbuild: true\r\n', notificationsBuildApprovals),
  {
    kind: 'edited',
    content: "allowBuilds: # reviewed\r\n\t'@firebase/util': false\r\n\tprotobufjs: true\r\n\tesbuild: true\r\n",
    added: ['@firebase/util', 'protobufjs'],
  },
);
// A quoted top-level key is not parsed, so nothing is appended next to it.
for (const key of ['"allowBuilds"', "'allowBuilds'"]) {
  for (const value of ['\n  esbuild: true\n', ' { esbuild: true }\n']) {
    assert.equal(
      addAllowBuilds(`${key}:${value}`, notificationsBuildApprovals).kind,
      'unsupported',
    );
  }
}

// No allowBuilds yet: the block is appended; CRLF files stay CRLF.
assert.deepEqual(addAllowBuilds("packages:\r\n  - '.'\r\n", notificationsBuildApprovals), {
  kind: 'edited',
  content: "packages:\r\n  - '.'\r\nallowBuilds:\r\n  '@firebase/util': false\r\n  protobufjs: true\r\n",
  added: ['@firebase/util', 'protobufjs'],
});
// An empty key still takes block entries.
assert.deepEqual(addAllowBuilds('allowBuilds:\noverrides: {}\n', { esbuild: true }), {
  kind: 'edited',
  content: 'allowBuilds:\n  esbuild: true\noverrides: {}\n',
  added: ['esbuild'],
});

// A flow mapping is not rewritten; a workspace that never fails on builds is left alone.
assert.equal(
  addAllowBuilds('allowBuilds: { esbuild: true }\n', notificationsBuildApprovals).kind,
  'unsupported',
);
assert.deepEqual(addAllowBuilds('dangerouslyAllowAllBuilds: true\n', notificationsBuildApprovals), {
  kind: 'covered',
});
assert.deepEqual(addAllowBuilds('strictDepBuilds: false\n', notificationsBuildApprovals), {
  kind: 'covered',
});

// What `mpgd target init capacitor --providers notifications` plans.
{
  const missing = planNotificationsBuildApprovals(undefined);
  assert.equal(missing.content, undefined);
  assert.match(missing.warning ?? '', /no pnpm-workspace\.yaml/u);
  assert.match(
    missing.warning ?? '',
    /allowBuilds:\n {2}'@firebase\/util': false\n {2}protobufjs: true/u,
  );
  assert.match(
    planNotificationsBuildApprovals('allowBuilds: {}\n').warning ?? '',
    /form the initializer does not edit/u,
  );
  assert.deepEqual(planNotificationsBuildApprovals(template), {});
  assert.match(
    planNotificationsBuildApprovals("packages:\n  - '.'\n").content ?? '',
    /allowBuilds:\n {2}'@firebase\/util': false\n {2}protobufjs: true\n$/u,
  );
}

console.info('pnpm build approvals passed.');
