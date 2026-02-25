# PI CONFIG (DOTFILES)

This directory is the **source of truth** for your Pi config:
- Repo path: `~/.local/share/chezmoi/dot_pi`
- Live path: `~/.pi`
- Managed via chezmoi from your dotfiles repo

## Critical Rules

- **Do not make long-lived config changes in `~/.pi` directly.**
- Make tracked changes in `~/.local/share/chezmoi/dot_pi`.
- Sync source → home with `chezmoi apply`.
- Keep paths portable (prefer `$HOME`, avoid machine-specific absolute paths).

## Purpose of This Directory

- `agent/` → Pi runtime/user config (settings, keys, package config)
- `agent/extensions/` → local Pi extensions
- `agent/skills/` → local Pi skills
- `agent/themes/` → custom theme files

## Working Conventions for Pi Work

1. Read existing files before editing.
2. Make small, surgical edits when possible.
3. Preserve JSON/Markdown formatting and existing style.
4. Prefer additive changes over destructive rewrites.
5. Reuse existing extension/skill patterns before adding new structures.
6. After source edits, run `chezmoi apply` to update `~/.pi`.

## Common Files

- `agent/settings.json` — primary Pi behavior/settings
- `agent/auth.json` — authentication state (sensitive; usually not tracked)
- `agent/keybindings.json` — keybinding customizations
- `agent/modes.json` — mode definitions
- `agent/package.json` — extension/skill workspace dependencies
- `agent/tsconfig.json` — TypeScript project config for Pi local code

## Validation Checklist (after edits)

- JSON is valid and minimally formatted.
- No secrets were added to tracked files.
- For TypeScript changes under `dot_pi/agent/`, run:
  - `cd "$HOME/.local/share/chezmoi/dot_pi/agent" && pnpm exec tsc -p tsconfig.json --noEmit`
- Preview/apply sync:
  - `chezmoi diff`
  - `chezmoi apply`
- Confirm expected result in live path (`~/.pi`).
