import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const resultKeys = [
  ['prepare', 'PREPARE_RESULT'],
  ['docs-validation', 'DOCS_RESULT'],
  ['test-focused', 'FOCUSED_RESULT'],
  ['test-browser', 'BROWSER_RESULT'],
  ['compile-tools', 'COMPILE_RESULT'],
  ['test-prepared', 'PREPARED_RESULT'],
  ['build-web-targets', 'WEB_TARGETS_RESULT'],
  ['build-android', 'ANDROID_RESULT'],
  ['build-ios', 'IOS_RESULT'],
  ['build-ait', 'AIT_RESULT'],
  ['build-devvit', 'DEVVIT_RESULT'],
];

export function expectedCoverage(env) {
  const flag = (name) => {
    if (env[name] !== 'true' && env[name] !== 'false') {
      throw new Error(`prepare did not classify ${name}: ${env[name] ?? 'missing'}`);
    }
    return env[name] === 'true';
  };
  const docs = flag('DOCS_VALIDATION');
  const metadata = flag('METADATA_ONLY');
  const docsOnly = flag('DOCS_ONLY');
  const prepared = flag('RUN_PREPARED');
  const native = flag('RUN_NATIVE');
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(env.EVENT_NAME)) {
    throw new Error(`Unexpected event: ${env.EVENT_NAME ?? 'missing'}`);
  }
  if (native && (env.EVENT_NAME !== 'pull_request' || prepared || metadata || docsOnly)) {
    throw new Error('Native-only coverage conflicts with the other CI scopes');
  }
  const result = Object.fromEntries(resultKeys.map(([name]) => [name, 'skipped']));
  result.prepare = 'success';
  result['docs-validation'] = docs ? 'success' : 'skipped';
  if (metadata || docsOnly) return result;

  if (prepared) {
    result['test-browser'] = 'success';
    for (const name of [
      'compile-tools', 'test-prepared', 'build-web-targets',
      'build-android', 'build-ios', 'build-ait', 'build-devvit',
    ]) result[name] = 'success';
  } else if (native) {
    result['test-focused'] = 'success';
    result['build-android'] = 'success';
    result['build-ios'] = 'success';
  } else {
    result['test-browser'] = 'success';
    if (env.EVENT_NAME === 'pull_request') result['test-focused'] = 'success';
  }
  return result;
}

export function verifyCoverage(env) {
  const expected = expectedCoverage(env);
  const mismatches = resultKeys.flatMap(([name, key]) => {
    const actual = env[key] ?? '';
    return actual === expected[name] ? [] : [`${name} should be ${expected[name]}, got ${actual || 'missing'}.`];
  });
  return { expected, mismatches };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { expected, mismatches } = verifyCoverage(process.env);
    const summary = [
      '### Required CI coverage',
      '| Job | Expected | Actual |',
      '| --- | --- | --- |',
      ...resultKeys.map(([name, key]) => `| ${name} | ${expected[name]} | ${process.env[key] || 'missing'} |`),
    ].join('\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    else process.stdout.write(`${summary}\n`);
    for (const message of mismatches) process.stderr.write(`::error::${message}\n`);
    if (mismatches.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}
