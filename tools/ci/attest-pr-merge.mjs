import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const shaPattern = /^[a-f0-9]{40}$/;

/**
 * Attest the exact merged tree that PR CI tested.
 *
 * The pull_request event's base.sha is frozen when the PR is opened, so it
 * goes stale as soon as the base branch moves. GitHub still builds the merge
 * ref against the current base tip, so the attested base is the merge
 * commit's first parent, and it must be a commit of the event's base branch.
 */
export function attestPrMerge(env, git) {
  const {
    PR_BASE_REF: baseRef,
    PR_HEAD_SHA: head,
    PR_NUMBER: number,
    GITHUB_SHA: checkoutSha,
    GITHUB_OUTPUT: output,
    RUNNER_TEMP: temp,
  } = env;
  if (![head, checkoutSha].every((value) => shaPattern.test(value ?? '')) ||
      !/^\d+$/.test(number ?? '') || !output || !temp ||
      typeof baseRef !== 'string' || baseRef.length === 0 || baseRef.startsWith('-')) {
    throw new Error('Missing or invalid PR CI attestation environment.');
  }
  // Git decides which branch names are valid (release@v1, release+v1, ...);
  // only reject what git itself refuses so a legal base branch cannot fail CI.
  try {
    git('check-ref-format', '--branch', baseRef);
  } catch {
    throw new Error(`Invalid PR base branch name: ${baseRef}`);
  }

  const [merge, firstParent, secondParent, ...extraParents] =
    git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
  if (merge !== checkoutSha || secondParent !== head || extraParents.length > 0 ||
      !shaPattern.test(firstParent ?? '')) {
    throw new Error(`PR checkout does not match event head: ${merge} ${firstParent} ${secondParent}`);
  }

  const baseTip = git('rev-parse', `refs/remotes/origin/${baseRef}`);
  if (!shaPattern.test(baseTip)) {
    throw new Error(`Could not resolve the base branch ${baseRef}.`);
  }
  try {
    git('merge-base', '--is-ancestor', firstParent, baseTip);
  } catch {
    throw new Error(`PR checkout base ${firstParent} is not a commit of ${baseRef} (${baseTip}).`);
  }

  const base = firstParent;
  const tree = git('rev-parse', 'HEAD^{tree}');
  const artifactName = `ci-tested-pr${number}-${base}-${head}-${tree}`;
  writeFileSync(join(temp, 'ci-tested-merge.json'), `${JSON.stringify({
    schemaVersion: 1,
    prNumber: Number(number),
    base,
    head,
    tree,
    merge,
  }, null, 2)}\n`);
  appendFileSync(output, `artifact_name=${artifactName}\n`);
  return { artifactName, base, baseTip, head, merge, tree };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const result = attestPrMerge(process.env, git);
  const staleNote = result.base === result.baseTip
    ? ''
    : ` (base branch has since moved to ${result.baseTip})`;
  process.stdout.write(
    `PR CI attested base ${result.base}, head ${result.head}, tree ${result.tree}${staleNote}.\n`,
  );
}
