---
name: skill-creator
description: Create or update an OpenCode skill. Use when the user wants to create a new skill (or update an existing skill) that extends OpenCode capabilities with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

This skill provides guidance for creating effective skills for OpenCode.

## About Skills

Skills are modular, self-contained folders that extend OpenCode capabilities by providing specialized knowledge, workflows, and tools.

### Skill Locations

OpenCode discovers skills from these paths:

- Project config: `.opencode/skills/<name>/SKILL.md`
- Global config: `~/.config/opencode/skills/<name>/SKILL.md`

### Anatomy of a Skill

```
skill-name/
└── SKILL.md (required)
    ├── YAML frontmatter metadata (required)
    │   ├── name: (required, 1-64 chars)
    │   ├── description: (required, 1-1024 chars)
    │   ├── license: (optional)
    │   ├── compatibility: (optional)
    │   └── metadata: (optional, string-to-string map)
    └── Markdown instructions (required)
```

### Naming Rules

- 1-64 characters
- Lowercase alphanumeric with single hyphen separators
- Must not start or end with `-`
- Must not contain consecutive `--`
- Directory name must match the skill name in frontmatter

Regex: `^[a-z0-9]+(-[a-z0-9]+)*$`

### Frontmatter

Only these fields are recognized:
- `name` (required) — the skill name
- `description` (required) — primary triggering mechanism; describe what the skill does and when to use it
- `license` (optional) — SPDX license identifier (e.g., MIT)
- `compatibility` (optional) — typically "opencode"
- `metadata` (optional) — string-to-string map for extra info
- Unknown fields are ignored.

## Skill Creation Process

1. Understand the skill with concrete examples.
2. Plan the skill structure and content.
3. Create `<name>/SKILL.md` with proper frontmatter and body.
4. Test the skill by having an agent use it on a real task.
5. Iterate based on usage.

## Writing Guidelines

- Use imperative/infinitive form.
- Keep the body concise — the context window is shared.
- Default assumption: the agent is already smart; only add context it doesn't already have.
- Prefer concise examples over verbose explanations.
- Keep SKILL.md body under 500 lines when possible.

## Progressive Disclosure

Keep SKILL.md lean. For larger skills, split content into referenced files within the skill directory and reference them from SKILL.md.

## Example

```
---name: pr-reviewdescription: Review pull requests for code quality, security, and style issues. Use when asked to review a PR or check code before merging.---
## What I do
- Review code changes for bugs and style issues
- Check for security vulnerabilities
- Suggest improvements

## Workflow
1. Read the diff or PR description
2. Analyze changes for issues
3. Report findings with file paths and line numbers
```
