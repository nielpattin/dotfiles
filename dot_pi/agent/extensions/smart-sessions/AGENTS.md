# smart-sessions extension

Pi extension under `~/.pi/agent/extensions/smart-sessions`.

## Purpose

Auto-name sessions from the first real user prompt.

## Local decisions

- Keep extension as a single file (`index.ts`)
- Do not hardcode Anthropic-only model choice
- Use explicit provider mapping:
  - `openai-codex` -> `gpt-5.1-codex-mini`
  - `google-gemini-cli` -> `gemini-2.5-flash`
- Fall back to current model if mapped model is unavailable
- Do not overwrite names after first naming pass in a session

## Scope

- Trigger: first meaningful `input` event
- `/skill:<name> <prompt>` gets `[skill]` prefix
- slash commands are ignored (except `/skill:...`)
- Session metadata: `pi.setSessionName(...)`
- Background summarization: `complete(...)` from `@mariozechner/pi-ai`

## Maintenance notes

- Main file: `index.ts`
- Keep README in sync if model selection logic changes
- If adding dependencies, run `pnpm install` in this directory
