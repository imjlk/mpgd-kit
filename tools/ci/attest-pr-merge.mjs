import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { PR_BASE_SHA: base, PR_HEAD_SHA: head, PR_NUMBER: number,
  GITHUB_SHA: checkoutSha, GITHUB_OUTPUT: output, RUNNER_TEMP: temp } = process.env;
const sha = /^[a-f0-9]{40}$/;
if (![base, head, checkoutSha].every((value) => sha.test(value ?? '')) ||
    !/^\d+$/.test(number ?? '') || !output || !temp) {
  throw new Error('Missing or invalid PR CI attestation environment.');
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const [merge, firstParent, secondParent] = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
if (merge !== checkoutSha || firstParent !== base || secondParent !== head) {
  throw new Error(`PR checkout does not match event base/head: ${merge} ${firstParent} ${secondParent}`);
}
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
process.stdout.write(`PR CI attested base ${base}, head ${head}, tree ${tree}.\n`);
