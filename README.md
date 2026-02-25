# Dotfiles Runbook (chezmoi + age)

End-to-end workflow for this repo.

Covers:
- first setup on a new machine
- daily sync/update flow
- adding new config files
- importing existing live files when needed
- encrypted secrets
- commit/push flow
- common fixes

---

## 0) Core model (important)

- **Source of truth**: `~/.local/share/chezmoi`
- **Live files**: your home directory (`~`)

### Default workflow (this repo)
1. Make changes directly in source (`~/.local/share/chezmoi`)
2. Review with `chezmoi diff`
3. Sync to home with `chezmoi apply`
4. Commit/push source repo changes

### When to use `add` / `re-add`
- Use `chezmoi add <target>` only if a file already exists in `~` and you want to import it into source.
- Use `chezmoi re-add <target>` only if a managed target in `~` was manually changed and must be reconciled back to source.

---

## 1) Prerequisites

Install:
- `git`
- `chezmoi`

Age private key file must exist at:

`~/.config/chezmoi/key.txt`

> Never commit this key.

---

## 2) First-time setup on a new machine

### 2.1 Init from repo

```bash
chezmoi init git@github.com:nielpattin/dotfiles.git
```

### 2.2 Place age key

Create:

`~/.config/chezmoi/key.txt`

Paste your private age identity.

### 2.3 Apply managed files

```bash
chezmoi apply
```

### 2.4 Verify clean state

```bash
chezmoi status
chezmoi diff
```

No output = clean.

---

## 3) Daily update flow

```bash
cd ~/.local/share/chezmoi
git pull --ff-only
chezmoi diff
chezmoi apply
chezmoi status
```

---

## 4) Add or update normal dotfiles

### 4.1 New file/config (preferred)

Create it directly in source with chezmoi naming:
- `~/.config/foo/bar.toml` → `dot_config/foo/bar.toml`
- `~/.pi/agent/settings.json` → `dot_pi/agent/settings.json`

Then:

```bash
cd ~/.local/share/chezmoi
chezmoi diff
chezmoi apply
```

### 4.2 Import an existing live file (only when needed)

If file already exists in `~` and is not in source yet:

```bash
chezmoi add ~/.config/foo/bar.toml
chezmoi diff
chezmoi apply
```

Useful flags:
- `--template` for templated files
- `--encrypt` for sensitive files

### 4.3 Managed target changed manually in `~`

If `chezmoi apply` reports target changed since last write:

1. choose `skip`
2. reconcile back to source:

```bash
chezmoi re-add <target-path>
chezmoi apply
```

---

## 5) Secrets workflow

### 5.1 Canonical source file

Encrypted source in repo:

`dot_config/private_chezmoi/encrypted_secrets.yaml.age`

### 5.2 Add/update secrets

Update encrypted secrets in source, then apply.

Expected structure:

```yaml
api:
  BRAVE_API_KEY: "..."
  JINA_API_KEY: "..."
  ANY_NEW_KEY: "..."
```

All keys under `api:` are exported automatically by templates.

### 5.3 Generated shell files

From `api:` keys, chezmoi renders:
- PowerShell: `~/Documents/PowerShell/secrets.ps1`
- Bash: `~/.bash_secrets`
- Fish: `~/.config/fish/conf.d/10-secrets.fish`

Do not edit generated outputs directly.

---

## 6) Verify secrets are loaded

### 6.1 PowerShell

```pwsh
if ($env:BRAVE_API_KEY) { "loaded len=$($env:BRAVE_API_KEY.Length)" } else { "NOT loaded" }
```

Reload profile if needed:

```pwsh
. $PROFILE
```

### 6.2 Bash (from same pwsh session)

```pwsh
bash -lc 'if [ -n "$BRAVE_API_KEY" ]; then echo "loaded len=${#BRAVE_API_KEY}"; else echo "NOT loaded"; fi'
```

### 6.3 Fish

```fish
if test -n "$BRAVE_API_KEY"; echo "loaded"; else; echo "NOT loaded"; end
```

---

## 7) Commit + push workflow

```bash
cd ~/.local/share/chezmoi
git status --short
chezmoi status
chezmoi diff

git add <files>
git commit -m "chore(dotfiles): update ..."
git push
```

---

## 8) Common errors and fixes

### 8.1 "has changed since chezmoi last wrote it"

You changed a managed target in `~` manually.

Fix:
1. choose `skip`
2. run:

```bash
chezmoi re-add <target-path>
chezmoi apply
```

### 8.2 Secret scanner warning during `re-add`

Prefer source-first encrypted updates. If you must re-add secrets anyway:

```bash
chezmoi re-add ~/.config/chezmoi/secrets.yaml --secrets ignore
chezmoi apply
```

### 8.3 "config file template has changed, run chezmoi init"

```bash
chezmoi init --source ~/.local/share/chezmoi
chezmoi status
chezmoi diff
```

---

## 9) Security rules

- Never commit plaintext secrets.
- Never commit `~/.config/chezmoi/key.txt`.
- Back up age key securely.
- If key is lost, encrypted repo files cannot be decrypted.

---

## 10) Command cheat sheet

```bash
# source repo
cd ~/.local/share/chezmoi

# inspect + apply
chezmoi status
chezmoi diff
chezmoi apply

# import existing live file to source
chezmoi add ~/.config/<path>

# reconcile manual target change back to source
chezmoi re-add ~/.config/<path>

# git
git status --short
git add <files>
git commit -m "chore(dotfiles): ..."
git push
```
