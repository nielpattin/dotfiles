# Dotfiles guide — Windows

Follow this file on Windows.

## 1) Install prerequisites (manual, explicit)

Use `winget`:

```powershell
winget install --id Git.Git -e
winget install --id twpayne.chezmoi -e
```

Required secret key file:

- Path: `~/.config/chezmoi/key.txt`
- Content: your private age identity

## 2) First-time setup

```powershell
chezmoi init git@github.com:nielpattin/dotfiles.git
chezmoi apply
```

## 3) Post-install checks

```powershell
chezmoi status
chezmoi diff
```

Expected: no output.

Optional checks:

```powershell
Test-Path "$HOME/Documents/PowerShell/Microsoft.PowerShell_profile.ps1"
Test-Path "$HOME/.pi/agent/settings.json"
```

## 4) Daily update flow

```powershell
cd ~/.local/share/chezmoi
git pull --ff-only
chezmoi diff
chezmoi apply
chezmoi status
```

## 5) Common operations

Import an existing unmanaged file into source:

```powershell
chezmoi add ~/.config/<path>
chezmoi apply
```

Reconcile manual edits done in home back to source:

```powershell
chezmoi re-add ~/.config/<path>
chezmoi apply
```

## 6) Security notes

- Never commit plaintext secrets.
- Never commit `~/.config/chezmoi/key.txt`.
- Keep `~/.ssh` local to the machine.
