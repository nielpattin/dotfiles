# Dotfiles Runbook (chezmoi + age)

This is the full, end-to-end workflow for this dotfiles repo.

It covers:
- first setup on a new machine
- daily sync/update flow
- adding/editing managed files
- encrypted secrets (cross-shell)
- commit/push flow
- common error prompts and fixes

---

## 0) Core model (important)

- **Source of truth**: chezmoi source repo  
  `~/.local/share/chezmoi`
- **Live files**: your home directory (`~`)
- You usually:
  1. edit files in `~` (or use `chezmoi edit`)
  2. sync back to source (`chezmoi re-add` / `chezmoi add`)
  3. commit/push source repo
  4. run `chezmoi apply`

---

## 1) Prerequisites

Install:
- `git`
- `chezmoi`
- `age`

You also need your **age private key** file available at:

`~/.config/chezmoi/key.txt`

> This key must never be committed.

---

## 2) First-time setup on a new machine

## 2.1 Clone/init dotfiles with chezmoi

```bash
chezmoi init git@github.com:nielpattin/dotfiles.git
```

## 2.2 Put age key in place

Create:

`~/.config/chezmoi/key.txt`

Paste your private age identity there.

## 2.3 Apply managed files

```bash
chezmoi apply
```

## 2.4 Verify clean state

```bash
chezmoi status
chezmoi diff
```

No output = clean.

---

## 3) Daily update flow (pull latest dotfiles)

```bash
cd ~/.local/share/chezmoi
git pull --ff-only
chezmoi apply
chezmoi status
```

---

## 4) Add or update normal dotfiles

### 4.1 Add a new file to management

```bash
chezmoi add ~/.somefile
```

Useful flags:
- `--template` for templated files
- `--encrypt` for sensitive files

### 4.2 You edited a managed target directly (very common)

Example: you changed `~/.config/mise/config.toml`.

When `chezmoi apply` says file changed since last write:
- choose `skip`
- then sync back:

```bash
chezmoi re-add ~/.config/mise/config.toml
chezmoi apply
```

---

## 5) Secrets workflow (cross-shell, automatic)

## 5.1 Canonical secret file

Managed target (edit this):

`~/.config/chezmoi/secrets.yaml`

Encrypted source in repo:

`dot_config/private_chezmoi/encrypted_secrets.yaml.age`

## 5.2 Edit secrets (recommended path)

```bash
chezmoi edit ~/.config/chezmoi/secrets.yaml
chezmoi apply
```

Use this shape:

```yaml
api:
  BRAVE_API_KEY: "..."
  JINA_API_KEY: "..."
  ANY_NEW_KEY: "..."
```

### Important
All keys under `api:` are now exported automatically (no template edits needed per new key).

## 5.3 Generated shell files

From `api:` keys, chezmoi generates:

- PowerShell: `~/Documents/PowerShell/secrets.ps1`
- Bash: `~/.bash_secrets`
- Fish: `~/.config/fish/conf.d/10-secrets.fish`

---

## 6) Verify secrets are loaded

## 6.1 PowerShell

```pwsh
if ($env:BRAVE_API_KEY) { "loaded len=$($env:BRAVE_API_KEY.Length)" } else { "NOT loaded" }
```

Reload profile if needed:

```pwsh
. $PROFILE
```

## 6.2 Bash (inheritance check from same pwsh session)

```pwsh
bash -lc 'if [ -n "$BRAVE_API_KEY" ]; then echo "loaded len=${#BRAVE_API_KEY}"; else echo "NOT loaded"; fi'
```

## 6.3 Fish

```fish
if test -n "$BRAVE_API_KEY"; echo "loaded"; else; echo "NOT loaded"; end
```

---

## 7) Bash/Fish loading behavior

- Fish auto-loads `~/.config/fish/conf.d/*.fish` (already handled).
- Bash may need this in `~/.bashrc`:

```bash
[ -f "$HOME/.bash_secrets" ] && . "$HOME/.bash_secrets"
```

PowerShell profile already loads `~/Documents/PowerShell/secrets.ps1`.

---

## 8) Commit + push workflow

```bash
cd ~/.local/share/chezmoi
git status --short

# stage what changed
git add <files>

git commit -m "chore(dotfiles): update ..."
git push
```

Quick sanity checks before push:

```bash
git status --short
chezmoi status
chezmoi diff
```

---

## 9) Common errors and exact fixes

## 9.1 "has changed since chezmoi last wrote it"

You changed target manually. Fix:

1. choose `skip` in prompt
2. run:

```bash
chezmoi re-add <target-path>
chezmoi apply
```

## 9.2 Secret scanner warnings during `re-add`

You may see warnings like "Detected Generic API Key".

- Best fix: use `chezmoi edit ~/.config/chezmoi/secrets.yaml` instead of manual edit + re-add.
- If you must re-add anyway:

```bash
chezmoi re-add ~/.config/chezmoi/secrets.yaml --secrets ignore
chezmoi apply
```

## 9.3 Warning: "config file template has changed, run chezmoi init"

Run:

```bash
chezmoi init --source ~/.local/share/chezmoi
```

Then check:

```bash
chezmoi status
chezmoi diff
```

---

## 10) Security rules

- Never commit plaintext secrets.
- Keep `~/.config/chezmoi/key.txt` out of git.
- Back up age key securely (password manager/offline backup).
- If key is lost, encrypted files in repo cannot be decrypted.

---

## 11) Useful commands cheat sheet

```bash
# current state
chezmoi status
chezmoi diff

# apply changes
chezmoi apply

# edit managed file safely
chezmoi edit ~/.config/chezmoi/secrets.yaml

# sync manual edits back to source
chezmoi re-add ~/.config/mise/config.toml
# or just re-add all changes
chezmoi re-add

# see source repo status
cd ~/.local/share/chezmoi && git status --short

# decrypt preview (debug)
chezmoi decrypt ~/.local/share/chezmoi/dot_config/private_chezmoi/encrypted_secrets.yaml.age
```
