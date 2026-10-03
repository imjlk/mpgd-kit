import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attestPrMerge } from './attest-pr-merge.mjs';

const merge = 'a'.repeat(40);
const base = 'b'.repeat(40);
const head = 'c'.repeat(40);
const tip = 'd'.repeat(40);
const tree = 'e'.repeat(40);

function createEnvironment() {
  const temp = mkdtempSync(join(tmpdir(), 'attest-pr-merge-'));
  return {
    PR_NUMBER: '259',
    PR_BASE_REF: 'main',
    PR_HEAD_SHA: head,
    GITHUB_SHA: merge,
    GITHUB_OUTPUT: join(temp, 'output.txt'),
    RUNNER_TEMP: temp,
  };
}

function createGit({ parents = [merge, base, head], baseTip = base, ancestors = [base], baseRef = 'main' } = {}) {
  return (...args) => {
    const command = args.join(' ');
    if (args[0] === 'check-ref-format' && args[1] === '--branch') {
      if (args[2] === baseRef) {
        return args[2];
      }
      throw new Error('exit 1');
    }
    if (command === 'rev-list --parents -n 1 HEAD') {
      return parents.join(' ');
    }
    if (command === `rev-parse refs/remotes/origin/${baseRef}`) {
      return baseTip;
    }
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      if (ancestors.includes(args[2]) && args[3] === baseTip) {
        return '';
      }
      throw new Error('exit 1');
    }
    if (command === 'rev-parse HEAD^{tree}') {
      return tree;
    }
    throw new Error(`unexpected git ${command}`);
  };
}

test('attests the merge commit base when it is the current base tip', () => {
  const env = createEnvironment();
  const result = attestPrMerge(env, createGit());
  assert.equal(result.base, base);
  assert.equal(result.artifactName, `ci-tested-pr259-${base}-${head}-${tree}`);
  const attestation = JSON.parse(readFileSync(join(env.RUNNER_TEMP, 'ci-tested-merge.json'), 'utf8'));
  assert.deepEqual(attestation, { schemaVersion: 1, prNumber: 259, base, head, tree, merge });
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), `artifact_name=${result.artifactName}\n`);
});

test('attests the merged base even after the base branch moved past it', () => {
  const env = createEnvironment();
  const result = attestPrMerge(env, createGit({ baseTip: tip, ancestors: [base, tip] }));
  assert.equal(result.base, base);
  assert.equal(result.baseTip, tip);
});

test('rejects a merge whose first parent is not on the base branch', () => {
  const env = createEnvironment();
  const forged = 'f'.repeat(40);
  assert.throws(
    () => attestPrMerge(env, createGit({ parents: [merge, forged, head], baseTip: tip, ancestors: [base, tip] })),
    /is not a commit of main/,
  );
});

test('rejects a checkout whose head or shape does not match the event', () => {
  const env = createEnvironment();
  assert.throws(() => attestPrMerge(env, createGit({ parents: [merge, base, tip] })), /does not match event head/);
  assert.throws(() => attestPrMerge(env, createGit({ parents: [merge, base, head, tip] })), /does not match event head/);
  assert.throws(() => attestPrMerge(env, createGit({ parents: [head, base, head] })), /does not match event head/);
});

test('accepts any base branch name that git itself accepts', () => {
  const env = createEnvironment();
  const result = attestPrMerge({ ...env, PR_BASE_REF: 'release@v1' }, createGit({ baseRef: 'release@v1' }));
  assert.equal(result.base, base);
});

test('rejects an invalid environment', () => {
  const env = createEnvironment();
  assert.throws(() => attestPrMerge({ ...env, PR_BASE_REF: '../evil' }, createGit()), /Invalid PR base branch name/);
  assert.throws(() => attestPrMerge({ ...env, PR_BASE_REF: '-evil' }, createGit()), /invalid PR CI attestation environment/);
  assert.throws(() => attestPrMerge({ ...env, PR_BASE_REF: '' }, createGit()), /invalid PR CI attestation environment/);
  assert.throws(() => attestPrMerge({ ...env, PR_HEAD_SHA: 'abc' }, createGit()), /invalid PR CI attestation environment/);
  assert.throws(() => attestPrMerge({ ...env, PR_NUMBER: 'x' }, createGit()), /invalid PR CI attestation environment/);
});
