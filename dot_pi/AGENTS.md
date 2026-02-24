# PI CONFIG (DOTFILES)

This directory is the **source of truth** for your Pi config:
- Live path: `~/.pi`

## Critical Rules

- Keep paths portable (prefer `$HOME`, avoid hardcoded machine-specific paths).

## Purpose of This Directory

- `agent/` → Pi runtime/user config (auth + settings)

## Working Conventions for Pi Work

1. Read existing files before editing.
2. Make small, surgical edits when possible.
3. Preserve JSON/Markdown formatting and existing style.
4. Prefer additive changes over destructive rewrites.

## Common Files

- `agent/settings.json` — primary Pi behavior/settings
- `agent/auth.json` — authentication state (treat as sensitive)

## Validation Checklist (after edits)

- JSON is valid and minimally formatted.
- For TypeScript changes under `~/.pi/agent/`, run typecheck with the project config (not ad-hoc flags):
  - `cd "$HOME/.pi/agent" && pnpm exec tsc -p tsconfig.json --noEmit`