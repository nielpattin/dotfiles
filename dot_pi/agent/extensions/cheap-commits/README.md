# cheap-commits extension

AI-assisted commit generation for Pi, with cost-aware model selection and an interactive model picker.

## What this extension actually registers

This extension registers **one command**:

- `/cheap-commit`

It does **not** register separate `/commit` or `/commit-model` commands.

---

## Command usage

### `/cheap-commit`

Default behavior: generate commits using the configured model (or auto-selected cheapest model).

```bash
/cheap-commit
```

Equivalent to:

```bash
/cheap-commit generate
```

### `/cheap-commit generate [prompt...]`

Generate and stage commits with an optional custom task prompt.

```bash
/cheap-commit generate
/cheap-commit generate "Commit all current changes with conventional commit messages"
```

### `/cheap-commit model [provider/model]`

Configure the model used by `/cheap-commit generate`.

```bash
/cheap-commit model
/cheap-commit model openai/gpt-4o-mini
```

- With no argument, opens the interactive picker.
- With a single token argument, stores that model string directly.
- With multi-word input, opens the picker.

### `/cheap-commit help`

Currently a placeholder in code (no dedicated help output yet).

---

## Model picker controls

- `↑` / `↓` or `j` / `k`: navigate
- `n`: sort by model name (toggle asc/desc)
- `p`: sort by provider (toggle asc/desc)
- `c`: sort by cost (toggle asc/desc)
- `Enter` or `Space`: select
- `Esc` or `Ctrl+C`: cancel
- Type `[a-zA-Z0-9-_/.]`: fuzzy filter
- `Backspace`: delete one filter character

UI behavior from code:

- Overlay width: `100%`
- Max height: `35%` of terminal
- Anchor: `bottom-center`
- Models grouped by provider with separator rows

---

## Configuration

Config is managed by `@zenobius/pi-extension-config` with config name:

- `generate-commit-message`

### Config priority

1. Environment variables (prefix from config name)
2. Project config: `.pi/generate-commit-message.config.json`
3. Home config: `~/.pi/agent/generate-commit-message.config.json`
4. Built-in defaults

### Supported fields

```json
{
  "mode": "openai/gpt-4o-mini",
  "prompt": "Use the writing-git-commits skill to commit changes safely",
  "maxOutputCost": 1.0
}
```

- `mode` (`string`): model in `provider/model` format
- `prompt` (`string`): default prompt when no prompt arg is passed
- `maxOutputCost` (`number`): threshold used by cheap auto-selection (default `1.0`)

---

## Model selection logic (`generate`)

When running commit generation:

1. If `mode` exists in config, use it.
2. Otherwise auto-pick cheapest model.

Auto-pick flow:

1. Prefer token-priced models (exclude `$0/$0` request-priced models)
2. Keep models where `output <= maxOutputCost`
3. Rank by score: `input + (output * 2)`
4. If none match threshold, try cheap-name heuristic:
   - `mini|flash|nano|haiku|lite|micro|free`
5. If still none, pick cheapest token-priced model overall
6. If no token-priced models exist, fall back to request-priced models
7. If registry is empty, hard fallback:
   - `github-copilot/gpt-4o-mini`

---

## Agent selection logic

Commit work is delegated to a subagent with skill `writing-git-commits`.

Agent selection order:

1. Nearest project `.pi/agents` (walking up from current cwd)
2. User agents in `~/.pi/agent/agents`
3. Preferred names: `general`, `worker`, `default`, `scout`
4. Otherwise first discovered agent
5. Otherwise create fallback agent:
   - `~/.pi/agent/agents/commit-writer.md`

The generated task includes a repository guard so the subagent stays in the current repo unless explicitly asked to switch.

---

## Files in this extension

```text
dot_pi/agent/extensions/cheap-commits/
├── index.ts
└── README.md
```

---

## Notes

- The command sends a subagent-tool instruction via `pi.sendUserMessage(...)` with:
  - `agent`
  - `task`
  - `model`
  - `skill: "writing-git-commits"`
  - `clarify: false`
  - `agentScope: "both"`
  - `cwd`
- UI notifications show selected/configured model and formatted cost when available.
