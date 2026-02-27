# Dotfiles

## OVERVIEW
This repo is the chezmoi source for the user’s Windows environment (`~/.local/share/chezmoi`).
Primary payload: Pi config (`~/.pi`), opencode config (`~/.config/opencode`), shared skills, and shell/secrets templates.

## STRUCTURE
| Path | Purpose |
|---|---|
| `README.md` | Full runbook (bootstrap, sync, secrets, recovery) |
| `.chezmoi.toml.tmpl` | age encryption config + key identity path |
| `.chezmoiexternal.toml` | external git-managed assets (opencode plugin) |
| `.chezmoiignore` | excludes runtime/build/machine-specific state |
| `.gitignore` | repo-local ignores (includes `tmp/` scratch workspace) |
| `tmp/` | throwaway workspace for downloads/clones/extractions during agent tasks |
| `Documents/PowerShell/` | generated PowerShell secret loader template |
| `dot_agents/skills/` | shared skill library mirrored to `~/.agents/skills` |
| `dot_config/` | maps to `~/.config/*` (opencode/nvim/fish/mise/etc.) |
| `dot_config/opencode/` | largest config surface; custom agents/commands/plugins |
| `dot_pi/` | maps to `~/.pi` (agent settings/extensions/skills/themes) |
| `.pi/` | local Pi runtime state in source working tree (not target mapping) |

## WHERE TO LOOK
| Task | Location | Notes |
|---|---|---|
| First-time machine setup | `README.md` | Canonical bootstrap + apply flow |
| Daily sync/apply workflow | `README.md` | `git pull --ff-only` + `chezmoi apply` |
| Encryption/key config | `.chezmoi.toml.tmpl` | age recipient + `~/.config/chezmoi/key.txt` identity |
| Secret include/exclude policy | `.chezmoiignore` | Runtime/auth/session paths intentionally excluded |
| External plugin pin/source | `.chezmoiexternal.toml` | `git-repo` source + branch/pull args |
| Pi runtime config | `dot_pi/agent/settings.json` | extensions/skills/packages/model defaults |
| Pi-specific repo guidance | `dot_pi/AGENTS.md` | Scoped Pi notes (keep minimal) |
| Opencode-specific guidance | `dot_config/opencode/AGENTS.md` | Scoped opencode notes |

## CONVENTIONS (PROJECT-SPECIFIC)
- Source of truth is this chezmoi source repo; home directory is generated target.
- Default flow: modify files in this repo, then run `chezmoi apply` to sync to `$HOME`.
- Temporary external work (downloads/clones/extracts) must happen under `./tmp` only.
- For `curl`/`wget`, `gh repo clone`, and `uvx github-dlr https://github.com/<user>/<repo>` operations, set destination/workdir to `./tmp`.
- New tracked config/file: create it directly in source (`dot_*` path) rather than creating it in `~` first.
- Prefer this root `AGENTS.md` for shared rules; add/expand nested `AGENTS.md` only for truly directory-specific constraints.
- Use `chezmoi add <target>` only when importing an already-existing file from `~` into source.
- Use `chezmoi re-add <target>` only when a managed target in `~` was changed manually and must be reconciled back to source.
- Naming follows chezmoi mapping (`dot_*` → hidden targets under `$HOME`).
- SSH material is intentionally unmanaged by chezmoi in this repo; keep `~/.ssh` local per machine.
- Secrets model:
  - Canonical source file: `dot_config/private_chezmoi/encrypted_secrets.yaml.age`
  - Generated shell secret files are templates; do not modify generated output directly.
- Encryption is age-based; private key path is fixed at `~/.config/chezmoi/key.txt`.
- `.chezmoiignore` intentionally drops runtime/cache/session/state paths (Pi/opencode/system noise).

## ANTI-PATTERNS (THIS PROJECT)
- Modifying generated secret loader outputs directly (`private_secrets.ps1.tmpl`, `private_dot_bash_secrets.tmpl`, fish secret template).
- Committing plaintext secrets or the age private key.
- Committing runtime/session artifacts intentionally ignored by policy (`.pi/agent/sessions`, caches, local state).
- Running `curl`, `uvx github-dlr`, repo clones, or other fetch/extract commands directly into repo root or managed `dot_*` paths.
- Adding machine-specific absolute paths in templates when `$HOME`-portable pathing is possible.

## COMMANDS
```bash
# work from source repo
cd ~/.local/share/chezmoi

# inspect + sync to home
chezmoi status
chezmoi diff
chezmoi apply

# temporary external work area (downloads/clones)
mkdir -p tmp
cd tmp

# import existing live file -> source (when needed)
chezmoi add ~/.config/<path>

# reconcile manual target change -> source (when needed)
chezmoi re-add ~/.config/<path>

# repo sync
git pull --ff-only
git status --short
git add <files>
git commit -m "chore(dotfiles): ..."
git push
```