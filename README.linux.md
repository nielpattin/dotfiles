# Dotfiles guide — Linux

Follow this file on Linux.

## 1) Install prerequisites (manual, explicit)

Install at minimum:

- `git`
- `chezmoi`
- `curl`
- `fish`
- `eza`
- `make`
- `gcc`
- `xdg-utils` (provides `xdg-open`, used by Pi visual HTML outputs)

Examples:

```bash
# Arch
sudo pacman -S --needed git chezmoi curl fish eza make gcc xdg-utils

# Debian/Ubuntu
sudo apt update
sudo apt install -y git chezmoi curl fish eza build-essential xdg-utils
```

Required secret key file:

- Path: `~/.config/chezmoi/key.txt`
- Content: your private age identity

## 2) First-time setup

```bash
chezmoi init git@github.com:nielpattin/dotfiles.git
chezmoi apply
```

## 3) Post-install checks

```bash
chezmoi status
chezmoi diff
```

Expected: no output.

Shell checks:

```bash
command -v fish
getent passwd "$USER" | cut -d: -f7
```

If your login shell is not fish:

```bash
chsh -s "$(command -v fish)"
```

Browser opener check (`xdg-open`, used by Pi visual HTML pages):

```bash
command -v xdg-open
```

WSL fallback if needed:

```bash
explorer.exe "$(wslpath -w ~/.agent/diagrams/<file>.html)"
```

## 4) Optional: Pi CLI via pnpm

If you want Pi from npm registry:

```bash
pnpm add -g @mariozechner/pi-coding-agent@latest
```

If pnpm complains about global bin directory, set this in fish:

```fish
set -Ux PNPM_HOME "$HOME/.local/share/pnpm"
fish_add_path $PNPM_HOME
exec fish
```

## 5) Daily update flow

```bash
cd ~/.local/share/chezmoi
git pull --ff-only
chezmoi diff
chezmoi apply
chezmoi status
```

## 6) Common operations

Import an existing unmanaged file into source:

```bash
chezmoi add ~/.config/<path>
chezmoi apply
```

Reconcile manual edits done in home back to source:

```bash
chezmoi re-add ~/.config/<path>
chezmoi apply
```

## 7) Security notes

- Never commit plaintext secrets.
- Never commit `~/.config/chezmoi/key.txt`.
- Keep `~/.ssh` local to the machine.
