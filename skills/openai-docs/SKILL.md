---
name: openai-docs
description: Use when the user asks how to build with OpenAI products or APIs and needs up-to-date official documentation with citations, or when choosing the latest model for a use case. Uses WebFetch on developers.openai.com and platform.openai.com.
---

# OpenAI Docs

Provide authoritative, current guidance from OpenAI developer docs.

## Quick Start

- Use WebFetch to fetch pages from `https://developers.openai.com` and `https://platform.openai.com`.
- For model-selection or "latest model" questions, fetch `https://developers.openai.com/api/docs/guides/latest-model.md` first.
- Prefer official OpenAI domains; avoid speculation.

## Workflow

1. Clarify whether the request is general docs lookup, model selection, model upgrade, or API migration.
2. Fetch relevant pages from OpenAI developer docs.
3. Answer with concise citations and direct links to source pages.
4. Keep migration changes narrow and behavior-preserving.

## Quality Rules

- Treat OpenAI docs as the source of truth; avoid speculation.
- Do not invent pricing, availability, parameters, or API changes.
- Keep quotes short; prefer paraphrase with citations.
- If multiple pages differ, call out the difference and cite both.
- If docs do not cover the user's need, say so and offer next steps.
