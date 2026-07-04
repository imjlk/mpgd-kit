import { existsSync, readFileSync } from 'node:fs';

interface StarterAgentManifest {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly engine?: unknown;
  readonly targets?: unknown;
  readonly futureTargets?: unknown;
  readonly agentWorkflow?: {
    readonly brief?: unknown;
    readonly acceptance?: unknown;
    readonly mcp?: unknown;
  };
  readonly blocks?: unknown;
  readonly acceptance?: {
    readonly commands?: unknown;
  };
}

interface StarterBlock {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly entry?: unknown;
  readonly capabilities?: unknown;
  readonly gotchas?: unknown;
}

interface StarterMcpRequirement {
  readonly target?: unknown;
  readonly server?: unknown;
  readonly queries?: unknown;
}

const requiredFiles = [
  '.codex/config.toml',
  '.codex/agents/codebase-explorer.toml',
  '.codex/agents/phaser-scene-builder.toml',
  '.codex/agents/game-block-author.toml',
  '.codex/agents/platform-adapter-author.toml',
  '.codex/agents/apps-in-toss-integrator.toml',
  '.codex/agents/monetization-guard.toml',
  '.codex/agents/reviewer.toml',
  '.agents/skills/create-game-block/SKILL.md',
  '.agents/skills/evolve-phaser-starter/SKILL.md',
  '.agents/skills/add-platform-adapter/SKILL.md',
  '.agents/skills/validate-agentic-game-workflow/SKILL.md',
  'docs/AGENTIC_GAME_WORKFLOW.md',
  'examples/phaser-starter/AGENTS.md',
  'examples/phaser-starter/agent/brief.template.md',
  'examples/phaser-starter/agent/acceptance.md',
  'examples/phaser-starter/agent/game.manifest.json',
] as const;

const requiredAitQueries = [
  '웹뷰 개발',
  '인앱 결제',
  '인앱 광고',
  '샌드박스',
  '심사',
  '저장소',
] as const;

const failures: string[] = [];

for (const file of requiredFiles) {
  if (!existsSync(file)) {
    failures.push(`Missing starter workflow file: ${file}`);
  }
}

const existingFiles = new Set(requiredFiles.filter((file) => existsSync(file)));

for (const skillFile of requiredFiles.filter(
  (file) => file.endsWith('/SKILL.md') && existingFiles.has(file),
)) {
  validateSkillFrontmatter(skillFile);
}

for (const agentFile of requiredFiles.filter(
  (file) => file.startsWith('.codex/agents/') && existingFiles.has(file),
)) {
  validateAgentDefinition(agentFile);
}

const manifestPath = 'examples/phaser-starter/agent/game.manifest.json';
const manifest = existingFiles.has(manifestPath)
  ? readJson(manifestPath) as StarterAgentManifest
  : {};

assertString(manifest.id, `${manifestPath}: id`);
assertString(manifest.version, `${manifestPath}: version`);
assertEqual(manifest.engine, 'phaser-4', `${manifestPath}: engine`);
assertStringArray(manifest.targets, `${manifestPath}: targets`);
assertIncludes(manifest.targets, 'ait', `${manifestPath}: targets`);
assertIncludes(manifest.targets, 'web-preview', `${manifestPath}: targets`);
assertStringArray(manifest.futureTargets, `${manifestPath}: futureTargets`);
assertIncludes(manifest.futureTargets, 'reddit', `${manifestPath}: futureTargets`);

assertString(manifest.agentWorkflow?.brief, `${manifestPath}: agentWorkflow.brief`);
assertString(manifest.agentWorkflow?.acceptance, `${manifestPath}: agentWorkflow.acceptance`);
assertMcpRequirements(manifest.agentWorkflow?.mcp, `${manifestPath}: agentWorkflow.mcp`);
assertBlocks(manifest.blocks, `${manifestPath}: blocks`);
assertStringArray(manifest.acceptance?.commands, `${manifestPath}: acceptance.commands`);
assertIncludes(
  manifest.acceptance?.commands,
  'pnpm validate:starter-workflow',
  `${manifestPath}: acceptance.commands`,
);

if (failures.length > 0) {
  throw new Error(`Starter workflow validation failed:\n- ${failures.join('\n- ')}`);
}

console.log('Starter workflow validation passed.');

function validateSkillFrontmatter(path: string): void {
  const content = readText(path);
  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---/.exec(content);

  if (match?.groups === undefined) {
    failures.push(`${path}: missing YAML frontmatter.`);
    return;
  }

  const frontmatter = match.groups.frontmatter ?? '';
  if (!/^name: .+$/m.test(frontmatter)) {
    failures.push(`${path}: missing skill name.`);
  }
  if (!/^description: .+$/m.test(frontmatter)) {
    failures.push(`${path}: missing skill description.`);
  }
}

function validateAgentDefinition(path: string): void {
  const content = readText(path);

  for (const key of ['name', 'description', 'developer_instructions']) {
    if (!new RegExp(`^${key}\\s*=`, 'm').test(content)) {
      failures.push(`${path}: missing ${key}.`);
    }
  }
}

function assertMcpRequirements(input: unknown, label: string): void {
  if (!Array.isArray(input)) {
    failures.push(`${label} must be an array.`);
    return;
  }

  const aitMcp = input.find((entry): entry is StarterMcpRequirement => {
    return (
      typeof entry === 'object'
      && entry !== null
      && (entry as StarterMcpRequirement).target === 'ait'
      && (entry as StarterMcpRequirement).server === 'apps-in-toss'
    );
  });

  if (aitMcp === undefined) {
    failures.push(`${label} must include an Apps in Toss MCP requirement for ait.`);
    return;
  }

  assertStringArray(aitMcp.queries, `${label}.ait.queries`);
  for (const query of requiredAitQueries) {
    assertIncludes(aitMcp.queries, query, `${label}.ait.queries`);
  }
}

function assertBlocks(input: unknown, label: string): void {
  if (!Array.isArray(input) || input.length === 0) {
    failures.push(`${label} must be a non-empty array.`);
    return;
  }

  for (const [index, rawBlock] of input.entries()) {
    const blockLabel = `${label}[${index}]`;
    const block = rawBlock as StarterBlock;
    assertString(block.id, `${blockLabel}.id`);
    assertString(block.kind, `${blockLabel}.kind`);
    assertString(block.entry, `${blockLabel}.entry`);
    assertStringArray(block.capabilities, `${blockLabel}.capabilities`);
    assertStringArray(block.gotchas, `${blockLabel}.gotchas`);

    if (typeof block.id === 'string' && !/^[a-z]+(?:\.[a-z0-9-]+)+$/.test(block.id)) {
      failures.push(`${blockLabel}.id must be capability-named, received ${block.id}.`);
    }

    if (typeof block.id === 'string' && /mario|gradius|zelda|tetris|pokemon/i.test(block.id)) {
      failures.push(`${blockLabel}.id must not use copyrighted reference names.`);
    }
  }
}

function assertString(input: unknown, label: string): void {
  if (typeof input !== 'string' || input.length === 0) {
    failures.push(`${label} must be a non-empty string.`);
  }
}

function assertStringArray(input: unknown, label: string): void {
  if (
    !Array.isArray(input)
    || input.length === 0
    || input.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    failures.push(`${label} must be a non-empty string array.`);
  }
}

function assertIncludes(input: unknown, expected: string, label: string): void {
  if (!Array.isArray(input) || !input.includes(expected)) {
    failures.push(`${label} must include ${expected}.`);
  }
}

function assertEqual(input: unknown, expected: string, label: string): void {
  if (input !== expected) {
    failures.push(`${label} must be ${expected}.`);
  }
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readText(path)) as unknown;
  } catch (error) {
    failures.push(
      `${path}: failed to parse JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );

    return {};
  }
}
