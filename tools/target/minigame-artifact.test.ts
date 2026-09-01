import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import type { GeneratedTargetIcons } from '../icons/types';
import {
  assembleMiniGameArtifact,
  assertDisjointMiniGameTargetOutputs,
  assertMiniGameArtifactOutputDirectory,
  assertMiniGameJavaScriptSafety,
  cleanupMiniGameArtifactBackup,
  miniGameArtifactEvidenceFileName,
  miniGameEffectiveTargetConfigFileName,
  miniGameIconManifestFileName,
  verifyMiniGameArtifactEvidence,
  writeMiniGameArtifactEvidence,
} from './minigame-artifact';
import { validatePlatformTargetsFile } from './validate-platform-targets';

const root = mkdtempSync(join(tmpdir(), 'mpgd-minigame-evidence-'));
const transactionRoot = mkdtempSync(join(tmpdir(), 'mpgd-minigame-transaction-'));
const budget = { mainBytes: 100_000, totalBytes: 100_000 } as const;
const expected = {
  artifactRoot: root,
  target: 'wechat',
  runtime: 'wechat-minigame',
  renderer: 'canvas',
  experimental: true,
  appVersion: '1.2.3',
  buildId: 'build-1',
  sourceGitSha: 'source-sha',
  kitGitSha: 'kit-sha',
  budget,
} as const;

try {
  write('game.js', "require('./runtime.js');\nrequire('./game.bundle.js');\n");
  write('game.json', '{"deviceOrientation":"landscape"}\n');
  write('project.config.json', '{"compileType":"game"}\n');
  write('runtime.js', 'globalThis.__MPGD_MINIGAME__ = true;\n');
  write('game.bundle.js', 'globalThis.__MPGD_GAME__ = true;\n');
  write(miniGameEffectiveTargetConfigFileName, '{"target":"wechat"}\n');
  write(miniGameIconManifestFileName, '{"schemaVersion":2}\n');
  write('assets/logo.png', Buffer.from([1, 2, 3]));

  const evidence = writeMiniGameArtifactEvidence(expected);
  assert.equal(
    evidence.files.some((file) => file.path === miniGameArtifactEvidenceFileName),
    false,
  );
  assert.equal(
    evidence.packageSize.totalBytes,
    sumArtifactBytes(),
    'evidence package size must include its own final bytes',
  );
  assert.deepEqual(verifyMiniGameArtifactEvidence(expected), evidence);

  write('assets/logo.png', Buffer.from([4, 5, 6]));
  assert.throws(() => verifyMiniGameArtifactEvidence(expected), /digest mismatch/u);
  write('assets/logo.png', Buffer.from([1, 2, 3]));
  assert.deepEqual(verifyMiniGameArtifactEvidence(expected), evidence);

  write('remote.js', "importScripts('https://cdn.example.test/remote.js');\n");
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /remote executable code reference/u,
  );
  rmSync(join(root, 'remote.js'));

  for (const extension of ['JS', 'cjs', 'mjs']) {
    const unsafeFile = `unsafe.${extension}`;
    write(unsafeFile, 'eval("untrusted")\n');
    assert.throws(
      () => assertMiniGameJavaScriptSafety(root, []),
      new RegExp(`Mini-game unsafe\\.${extension} contains forbidden eval`, 'u'),
    );
    rmSync(join(root, unsafeFile));
  }

  for (const functionConstructor of [
    'Function("return 1")()\n',
    '(Function)("return 1")()\n',
    'Function.call(null, "return 1")()\n',
    'new Function("return 1")()\n',
    'Function`return 1`\n',
  ]) {
    write('unsafe.js', functionConstructor);
    assert.throws(
      () => assertMiniGameJavaScriptSafety(root, []),
      /contains forbidden Function constructor/u,
    );
    rmSync(join(root, 'unsafe.js'));
  }
  for (const derivedConstructor of [
    'const F = (() => {}).constructor; F("return 1")();\n',
    'const first = (() => {}).constructor; const second = first; second("return 1")();\n',
    'const { constructor: F } = (() => {}); F("return 1")();\n',
    '(() => {}).constructor("return 1")();\n',
    'new (() => {}).constructor("return 1");\n',
    '(() => {}).constructor`return 1`;\n',
    '(() => {}).constructor.call(null, "return 1")();\n',
    'Reflect.apply((() => {}).constructor, null, ["return 1"])();\n',
    'const apply = Reflect.apply; '
      + 'apply((() => {}).constructor, null, ["return 1"])();\n',
    'const { apply } = Reflect; '
      + 'apply((() => {}).constructor, null, ["return 1"])();\n',
    'const construct = Reflect.construct; '
      + 'construct((() => {}).constructor, ["return 1"])();\n',
    'const { construct } = Reflect; '
      + 'construct((() => {}).constructor, ["return 1"])();\n',
    'Reflect.apply(...[(() => {}).constructor, null, ["return 1"]])();\n',
    'const invoke = Reflect.apply; const args = '
      + '[(() => {}).constructor, null, ["return 1"]]; invoke(...args)();\n',
    'Reflect.get(() => {}, "constructor")("return 1")();\n',
    'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), "constructor")'
      + '.value("return 1")();\n',
    'const box = { F: (() => {}).constructor }; box.F("return 1")();\n',
    'const box = { nested: { F: (() => {}).constructor } }; '
      + 'box.nested.F("return 1")();\n',
    'const constructors = [(() => {}).constructor]; constructors[0]("return 1")();\n',
    'const box = { F: (() => {}).constructor }; const alias = box; '
      + 'alias.F("return 1")();\n',
    'const box = {}; box.F = (() => {}).constructor; box.F("return 1")();\n',
    'const box = {}; box.F ??= (() => {}).constructor; box.F("return 1")();\n',
    'const box = { F: (() => {}).constructor }; const { F } = box; F("return 1")();\n',
    'function getF() { return (() => {}).constructor; } getF()("return 1")();\n',
    'const getF = () => (() => {}).constructor; getF()("return 1")();\n',
    'function getF() { return (() => {}).constructor; } const get = getF; '
      + 'get()("return 1")();\n',
    'function getF() { return (() => {}).constructor; } const box = { getF }; '
      + 'box.getF()("return 1")();\n',
    'function getF() { return (() => {}).constructor; } '
      + 'function invoke(factory) { return factory(); } invoke(getF)("return 1")();\n',
    '(() => (() => {}).constructor)()("return 1")();\n',
    'function getBox() { return { F: (() => {}).constructor }; } '
      + 'getBox().F("return 1")();\n',
    'function read(key) { return globalThis[key]; } read("Function")("return 1")();\n',
    'class Box { static getF() { return (() => {}).constructor; } } '
      + 'Box.getF()("return 1")();\n',
    'class Box { getF() { return (() => {}).constructor; } } '
      + 'new Box().getF()("return 1")();\n',
    'class Box { static getF = () => (() => {}).constructor; } '
      + 'Box.getF()("return 1")();\n',
    'const box = { getF() { return (() => {}).constructor; } }; '
      + 'box.getF()("return 1")();\n',
    'const key = "Fun" + "ction"; const F = globalThis[key]; F("return 1")();\n',
    'const key = getRuntimeKey(); const box = { F: globalThis[key] }; '
      + 'box.F("return 1")();\n',
  ]) {
    write('unsafe.js', derivedConstructor);
    assert.throws(
      () => assertMiniGameJavaScriptSafety(root, []),
      /contains forbidden dynamic-code constructor/u,
    );
    rmSync(join(root, 'unsafe.js'));
  }
  write('safe-constructor-metadata.js', 'const name = value.constructor.name; void name;\n');
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-constructor-metadata.js'));
  write('safe-function-container.js', 'const box = { F() { return 1; } }; box.F();\n');
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-function-container.js'));
  write(
    'safe-constructor-prototype.js',
    'function inspect(value) { return value; } inspect(value.constructor.prototype);\n',
  );
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-constructor-prototype.js'));
  write(
    'safe-computed-global-metadata.js',
    'const key = Symbol.for("telemetry"); function read() { return globalThis[key]; } void read;\n',
  );
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-computed-global-metadata.js'));
  write(
    'safe-constructor-return-metadata.js',
    'function readConstructor(value) { return Object.getPrototypeOf(value)?.constructor ?? null; } '
      + 'const name = readConstructor({})?.name; void name;\n',
  );
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-constructor-return-metadata.js'));
  for (const directWechatSdkAccess of [
    'wx.createImage();\n',
    'globalThis.wx.request({});\n',
    'globalThis["w" + "x"].createCanvas();\n',
    'const globalAlias = globalThis; globalAlias.wx.getWindowInfo();\n',
    'const { wx: sdk } = globalThis; sdk.createImage();\n',
  ]) {
    write('game.bundle.js', directWechatSdkAccess);
    assert.throws(
      () => assertMiniGameJavaScriptSafety(root, [], ['wx']),
      /game\.bundle\.js contains forbidden platform global wx/u,
    );
  }
  write('game.bundle.js', 'const wx = { createImage() { return {}; } }; wx.createImage();\n');
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, [], ['wx']));
  write('game.bundle.js', 'globalThis.__MPGD_GAME__ = true;\n');
  write('runtime.js', 'wx.createImage();\n');
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, [], ['wx']));
  write('runtime.js', 'globalThis.__MPGD_MINIGAME__ = true;\n');
  write('unsafe.js', 'const indirectEval = eval;\n');
  assert.throws(() => assertMiniGameJavaScriptSafety(root, []), /contains forbidden eval/u);
  rmSync(join(root, 'unsafe.js'));
  write('unsafe.js', 'const globalAlias = globalThis; globalAlias[getRuntimeKey()]();\n');
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden computed global call/u,
  );
  rmSync(join(root, 'unsafe.js'));
  write('safe-worker-check.js', "if (typeof importScripts === 'function') {}\n");
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-worker-check.js'));
  write('unsafe.js', "importScripts('https://cdn.example/code' + '.js');\n");
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden importScripts/u,
  );
  rmSync(join(root, 'unsafe.js'));
  const computedImportScripts = "globalThis['import' + 'Scripts']"
    + "('https://cdn.example/code' + '.js');\n";
  write('unsafe.js', computedImportScripts);
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden importScripts/u,
  );
  rmSync(join(root, 'unsafe.js'));
  write('unsafe.js', "globalThis['Fun' + 'ction']('return 1')();\n");
  assert.throws(() => assertMiniGameJavaScriptSafety(root, []), /contains forbidden Function/u);
  rmSync(join(root, 'unsafe.js'));
  write(
    'unsafe.js',
    "const { ['Fun' + 'ction']: dynamicFunction } = globalThis; dynamicFunction('return 1')();\n",
  );
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden (?:Function|computed destructuring)/u,
  );
  rmSync(join(root, 'unsafe.js'));
  write(
    'unsafe.js',
    "const { Function: DynamicFunction } = globalThis; DynamicFunction('return 1')();\n",
  );
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden Function destructuring/u,
  );
  rmSync(join(root, 'unsafe.js'));
  write(
    'unsafe.js',
    "const constructorName = 'Function'; globalThis[constructorName]('return 1')();\n",
  );
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden computed global call/u,
  );
  rmSync(join(root, 'unsafe.js'));
  write('safe-method.js', 'function invoke(member) { this[member](); }\n');
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-method.js'));
  write(
    'safe-shadowed-alias.js',
    'const globalAlias = globalThis; function invoke(member) { '
      + 'const globalAlias = { run() {} }; globalAlias[member](); }\n',
  );
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-shadowed-alias.js'));
  write('unsafe.js', 'const member = getRuntimeKey(); this[member]();\n');
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden computed global call/u,
  );
  rmSync(join(root, 'unsafe.js'));
  write('unsafe.js', 'globalThis[getRuntimeKey()]();\n');
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden computed global call/u,
  );
  rmSync(join(root, 'unsafe.js'));
  write('unsafe.js', "const globalAlias = globalThis; globalAlias.Function('return 1')();\n");
  assert.throws(() => assertMiniGameJavaScriptSafety(root, []), /contains forbidden Function/u);
  rmSync(join(root, 'unsafe.js'));
  write(
    'unsafe.js',
    'const firstAlias = globalThis; const secondAlias = firstAlias; '
      + 'secondAlias.eval("untrusted");\n',
  );
  assert.throws(() => assertMiniGameJavaScriptSafety(root, []), /contains forbidden eval/u);
  rmSync(join(root, 'unsafe.js'));
  write(
    'unsafe.js',
    'function run(globalAlias = globalThis) { globalAlias.Function("return 1")(); } run();\n',
  );
  assert.throws(() => assertMiniGameJavaScriptSafety(root, []), /contains forbidden Function/u);
  rmSync(join(root, 'unsafe.js'));
  write(
    'unsafe.js',
    'function run({ globalAlias = globalThis } = {}) { globalAlias.eval("x"); } run();\n',
  );
  assert.throws(() => assertMiniGameJavaScriptSafety(root, []), /contains forbidden eval/u);
  rmSync(join(root, 'unsafe.js'));
  write(
    'unsafe.js',
    'function run({ Function: DynamicFunction } = globalThis) { '
      + 'DynamicFunction("return 1")(); } run();\n',
  );
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden Function destructuring/u,
  );
  rmSync(join(root, 'unsafe.js'));
  for (const reflectiveGlobalRead of [
    'Reflect.get(globalThis, "Function")("return 1")();\n',
    'const get = Reflect.get; get(globalThis, "Function")("return 1")();\n',
    'const ReflectAlias = Reflect; const get = ReflectAlias.get; '
      + 'get(globalThis, "Function")("return 1")();\n',
    'const { get: lookup } = Reflect; lookup(globalThis, "eval")("x");\n',
    'const descriptors = Object.getOwnPropertyDescriptors; '
      + 'descriptors(globalThis).Function.value("return 1")();\n',
    'Reflect.get.call(null, globalThis, "Function")("return 1")();\n',
    'Reflect.get.apply(null, [globalThis, "Function"])("return 1")();\n',
    'Reflect.get.bind(null, globalThis, "Function")("return 1")();\n',
    'const g = globalThis; Object.getOwnPropertyDescriptor(g, "eval").value("x");\n',
    'globalThis.Reflect.getOwnPropertyDescriptor(globalThis, "importScripts").value("x");\n',
    'Object.getOwnPropertyDescriptors(globalThis).Function.value("return 1")();\n',
    'Reflect.get(globalThis, getRuntimeKey())("return 1")();\n',
    'const key = "Function"; Object.getOwnPropertyDescriptor(globalThis, key)'
      + '.value("return 1")();\n',
  ]) {
    write('unsafe.js', reflectiveGlobalRead);
    assert.throws(
      () => assertMiniGameJavaScriptSafety(root, []),
      /contains forbidden reflective global lookup/u,
    );
    rmSync(join(root, 'unsafe.js'));
  }
  write(
    'safe-reflective-read.js',
    'const record = { Function: "label" }; Reflect.get(record, "Function"); '
      + 'function read(scope) { const Reflect = { get() { return "safe"; } }; '
      + 'const get = Reflect.get; return get(scope, "safe"); } read({});\n',
  );
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-reflective-read.js'));
  write(
    'unsafe.js',
    'const globalAlias = window; const { Function: DynamicFunction } = globalAlias; '
      + 'DynamicFunction("return 1")();\n',
  );
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden Function destructuring/u,
  );
  rmSync(join(root, 'unsafe.js'));
  write('safe-label.js', "globalThis.label = 'Function';\n");
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-label.js'));
  write(
    'safe-property-names.js',
    'const record = { eval: false, Function: "label", importScripts() {} }; '
      + 'record.Function; Object.Function;\n',
  );
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-property-names.js'));
  write(
    'safe-bindings.js',
    'const { eval: localEval, Function: LocalFunction } = { eval: 1, Function: 2 }; '
      + 'void localEval; void LocalFunction;\n',
  );
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-bindings.js'));
  write('unsafe.js', 'globalThis.eval("untrusted");\n');
  assert.throws(() => assertMiniGameJavaScriptSafety(root, []), /contains forbidden eval/u);
  rmSync(join(root, 'unsafe.js'));
  for (const wrappedGlobalMember of [
    '(0, globalThis).Function("return 1")();\n',
    '(globalThis || {}).eval("untrusted");\n',
    '(useGlobal ? globalThis : {}).importScripts("remote.js");\n',
    '(0, globalThis)[getRuntimeKey()]();\n',
  ]) {
    write('unsafe.js', wrappedGlobalMember);
    assert.throws(
      () => assertMiniGameJavaScriptSafety(root, []),
      /contains forbidden (?:Function|eval|importScripts|computed global call)/u,
    );
    rmSync(join(root, 'unsafe.js'));
  }
  write('unsafe.js', 'this.Function("return 1")();\n');
  assert.throws(() => assertMiniGameJavaScriptSafety(root, []), /contains forbidden Function/u);
  rmSync(join(root, 'unsafe.js'));
  write(
    'safe-destructuring.js',
    "const input = { value: 1 }; const key = 'value'; const { [key]: value } = input; void value;\n",
  );
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-destructuring.js'));
  write('safe-canvas.js', "document.createElement('canvas');\n");
  assert.doesNotThrow(() => assertMiniGameJavaScriptSafety(root, []));
  rmSync(join(root, 'safe-canvas.js'));
  write('unsafe.js', "document['create' + 'Element']('script');\n");
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden script element creation/u,
  );
  rmSync(join(root, 'unsafe.js'));
  write('unsafe.js', "new globalThis['Wor' + 'ker']('worker-entry' + '.js');\n");
  assert.throws(
    () => assertMiniGameJavaScriptSafety(root, []),
    /contains forbidden Worker construction/u,
  );
  rmSync(join(root, 'unsafe.js'));

  const parsed = JSON.parse(
    readFileSync(join(root, miniGameArtifactEvidenceFileName), 'utf8'),
  ) as Record<string, unknown>;
  parsed.target = 'tiktok';
  write(miniGameArtifactEvidenceFileName, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.throws(() => verifyMiniGameArtifactEvidence(expected), /target mismatch/u);

  const projectRoot = join(transactionRoot, 'game');
  const artifactRoot = join(projectRoot, 'artifacts', 'wechat');
  const runtimeBundleRoot = join(transactionRoot, 'runtime-bundle');
  const gameBundleRoot = join(transactionRoot, 'game-bundle');
  const iconOutputRoot = join(transactionRoot, 'icons');
  const iconManifestPath = join(transactionRoot, 'icon-manifest.json');
  const effectiveTargetConfigSource = join(transactionRoot, 'effective-target.json');
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(runtimeBundleRoot, { recursive: true });
  mkdirSync(gameBundleRoot, { recursive: true });
  mkdirSync(iconOutputRoot, { recursive: true });
  writeFileSync(join(artifactRoot, 'sentinel.txt'), 'prior verified artifact');
  writeFileSync(join(runtimeBundleRoot, 'runtime.js'), 'globalThis.runtime = true;\n');
  writeFileSync(join(gameBundleRoot, 'game.bundle.js'), 'globalThis.game = true;\n');
  writeFileSync(iconManifestPath, '{"outputs":[]}\n');
  writeFileSync(effectiveTargetConfigSource, '{"target":"wechat"}\n');
  const collidingIconPath = 'icons/collision.png';
  mkdirSync(join(gameBundleRoot, dirname(collidingIconPath)), { recursive: true });
  writeFileSync(join(gameBundleRoot, collidingIconPath), 'bundle icon');
  writeFileSync(join(iconOutputRoot, 'collision.png'), 'generated icon');
  assert.throws(
    () => assembleMiniGameArtifact({
      artifactRoot,
      projectRoot,
      runtimeBundleRoot,
      gameBundleRoot,
      effectiveTargetConfigSource,
      generatedIcons: {
        manifestPath: iconManifestPath,
        outputDir: iconOutputRoot,
        manifest: { outputs: [{ path: collidingIconPath }] },
      } as unknown as GeneratedTargetIcons,
      writeProjectFiles(projectFilesRoot) {
        writeFileSync(
          join(projectFilesRoot, 'game.js'),
          "require('./runtime.js');\nrequire('./game.bundle.js');\n",
        );
        writeFileSync(join(projectFilesRoot, 'game.json'), '{}\n');
        writeFileSync(join(projectFilesRoot, 'project.config.json'), '{}\n');
      },
      target: 'wechat',
      runtime: 'wechat-minigame',
      appVersion: '1.2.3',
      buildId: 'build-1',
      sourceGitSha: 'source-sha',
      kitGitSha: 'kit-sha',
      budget,
    }),
    /artifact files collide at icons\/collision\.png/u,
  );
  rmSync(join(gameBundleRoot, 'icons'), { force: true, recursive: true });
  assert.equal(readFileSync(join(artifactRoot, 'sentinel.txt'), 'utf8'), 'prior verified artifact');
  assert.throws(
    () => assembleMiniGameArtifact({
      artifactRoot,
      projectRoot,
      runtimeBundleRoot,
      gameBundleRoot,
      effectiveTargetConfigSource,
      generatedIcons: {
        manifestPath: iconManifestPath,
        outputDir: iconOutputRoot,
        manifest: { outputs: [] },
      } as unknown as GeneratedTargetIcons,
      writeProjectFiles(stagingRoot) {
        writeFileSync(join(stagingRoot, 'game.js'), "require('./game.bundle.js');\n");
        writeFileSync(join(stagingRoot, 'game.json'), '{}\n');
        writeFileSync(join(stagingRoot, 'project.config.json'), '{}\n');
      },
      target: 'wechat',
      runtime: 'wechat-minigame',
      appVersion: '1.2.3',
      buildId: 'build-1',
      sourceGitSha: 'source-sha',
      kitGitSha: 'kit-sha',
      budget,
    }),
    /must load runtime\.js before game\.bundle\.js/u,
  );
  assert.equal(readFileSync(join(artifactRoot, 'sentinel.txt'), 'utf8'), 'prior verified artifact');
  assert.deepEqual(readdirSync(join(projectRoot, 'artifacts')), ['wechat']);

  const backupWarnings: string[] = [];
  assert.doesNotThrow(
    () => cleanupMiniGameArtifactBackup(
      '/artifact-backup',
      () => {
        throw new Error('locked by scanner');
      },
      (message) => backupWarnings.push(message),
    ),
  );
  assert.deepEqual(backupWarnings, [
    'The new mini-game artifact is active, but its prior backup could not be removed: '
      + '/artifact-backup (locked by scanner). Remove this backup manually.',
  ]);

  const validationRoot = join(transactionRoot, 'target-validation');
  const validationGameApp = join(validationRoot, 'game-app');
  const validationConfigPath = join(validationRoot, 'mpgd.targets.json');
  mkdirSync(validationGameApp, { recursive: true });
  writeFileSync(validationConfigPath, `${JSON.stringify({
    targets: {
      wechat: {
        kind: 'wechat-minigame',
        gameApp: 'game-app',
        adapter: 'wechat',
        output: 'artifacts/release-manifest.json',
        renderer: 'canvas',
        orientation: 'landscape',
        experimental: true,
        packageBudget: budget,
      },
    },
  }, null, 2)}\n`);
  assert.throws(
    () => validatePlatformTargetsFile(validationConfigPath),
    /Mini-game artifact output must not overlap generated output/u,
  );

  const resolveValidationPath = (path: string) => join(validationRoot, path);
  const miniGameTarget = {
    kind: 'wechat-minigame',
    gameApp: 'game-app',
    adapter: 'wechat',
    output: 'artifacts/wechat',
    renderer: 'canvas',
    orientation: 'landscape',
    experimental: true,
    packageBudget: budget,
  } as const;
  assert.doesNotThrow(
    () => assertDisjointMiniGameTargetOutputs({ wechat: miniGameTarget }, resolveValidationPath),
  );
  assert.throws(
    () => assertDisjointMiniGameTargetOutputs({
      wechat: miniGameTarget,
      tiktok: {
        ...miniGameTarget,
        kind: 'tiktok-minigame',
        adapter: 'tiktok',
        output: 'artifacts/wechat/nested',
      },
    }, resolveValidationPath),
    /Mini-game artifact outputs must not overlap/u,
  );
  assert.throws(
    () => assertDisjointMiniGameTargetOutputs({
      wechat: miniGameTarget,
      tiktok: {
        ...miniGameTarget,
        kind: 'tiktok-minigame',
        adapter: 'tiktok',
        output: 'artifacts/wechat/..backup',
      },
    }, resolveValidationPath),
    /Mini-game artifact outputs must not overlap/u,
  );
  assert.throws(
    () => assertDisjointMiniGameTargetOutputs({
      wechat: {
        ...miniGameTarget,
        output: 'artifacts/TARGET-CONFIG',
      },
    }, resolveValidationPath, [
      {
        name: 'effective target config output',
        path: resolveValidationPath('artifacts/target-config'),
      },
    ]),
    /Mini-game artifact output must not overlap generated output/u,
  );
  assert.throws(
    () => assertDisjointMiniGameTargetOutputs({
      wechat: {
        ...miniGameTarget,
        output: 'artifacts\\wechat',
      },
    }, resolveValidationPath),
    /must be a safe artifact-relative path/u,
  );
  if (sep === '/') {
    assert.throws(
      () => assertMiniGameArtifactOutputDirectory(
        resolveValidationPath('artifacts\\wechat'),
        validationRoot,
      ),
      /must be a dedicated artifacts\/ child/u,
    );
  }
  assert.throws(
    () => assertDisjointMiniGameTargetOutputs({ wechat: miniGameTarget }, resolveValidationPath, [
      {
        name: 'foreign-separator protected output',
        path: resolveValidationPath('artifacts\\wechat'),
      },
    ]),
    /Mini-game artifact output must not overlap generated output/u,
  );
  assert.throws(
    () => assertDisjointMiniGameTargetOutputs({
      wechat: {
        ...miniGameTarget,
        output: 'artifacts/target-config.',
      },
    }, resolveValidationPath),
    /must be a safe artifact-relative path/u,
  );
  assert.throws(
    () => assertDisjointMiniGameTargetOutputs({
      wechat: {
        ...miniGameTarget,
        output: 'artifacts/target-config',
      },
    }, resolveValidationPath, [
      {
        name: 'Windows-trimmed protected output',
        path: resolveValidationPath('artifacts/target-config.'),
      },
    ]),
    /Mini-game artifact output must not overlap generated output/u,
  );

  const fileOutput = join(validationRoot, 'artifacts', 'file-output');
  mkdirSync(dirname(fileOutput), { recursive: true });
  writeFileSync(fileOutput, 'not a directory');
  assert.throws(
    () => assertMiniGameArtifactOutputDirectory(fileOutput, validationRoot),
    /must only traverse directories/u,
  );
} finally {
  rmSync(root, { force: true, recursive: true });
  rmSync(transactionRoot, { force: true, recursive: true });
}

console.log('Mini-game artifact evidence tests passed.');

function write(path: string, contents: string | Buffer): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function sumArtifactBytes(): number {
  let total = 0;
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();

    if (directory === undefined) {
      throw new Error('Fixture traversal lost its directory.');
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        pending.push(path);
      } else {
        total += statSync(path).size;
      }
    }
  }

  return total;
}
