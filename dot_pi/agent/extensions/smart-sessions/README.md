# smart-sessions

Pi extension to auto-name sessions from the first real prompt (including `/skill:<name> ...`).

## What it does

- Detects the first real prompt in a session
- Supports `/skill:<name> ...` and prefixes the name with `[skill]`
- Skips slash commands like `/model`, `/name`, etc.
- Sets immediate fallback name from the first 60 chars
- Summarizes prompt in background and updates session name

## Model selection logic

This version uses explicit provider mapping:

1. If current provider is `openai-codex` → use `gpt-5.1-codex-mini`
2. If current provider is `google-gemini-cli` → use `gemini-2.5-flash`
3. Otherwise (or if mapped model unavailable) → fall back to current active model

## Files

- `index.ts` — extension entrypoint
- `AGENTS.md` — local maintenance notes
- `package.json` — local extension metadata
- `tsconfig.json` — editor/type-checking settings

## Enable

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "+extensions\\smart-sessions\\index.ts"
  ]
}
```

Then run `/reload` in Pi.
