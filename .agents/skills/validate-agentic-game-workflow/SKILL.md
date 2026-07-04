---
name: validate-agentic-game-workflow
description: Validate agent-facing game starter manifests, Codex agents, skills, and acceptance commands.
---

# Validate Agentic Game Workflow

Use this skill when changing `.codex/agents`, `.agents/skills`, `docs/AGENTIC_GAME_WORKFLOW.md`, or `examples/phaser-starter/agent`.

1. Verify every custom agent is narrow and boundary-aware.
2. Verify every skill has a YAML frontmatter `name` and `description`.
3. Verify starter manifest block ids are capability-named and generic.
4. Verify AIT workflow points agents to the apps-in-toss MCP before implementation.
5. Verify future platforms, such as Reddit Devvit, are described as adapter targets and not scene imports.
6. Run:
   - `pnpm validate:starter-workflow`
   - `pnpm check`
