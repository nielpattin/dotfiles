# SSH is local-only (not managed by chezmoi)

This dotfiles repo does **not** manage `~/.ssh`.

## Why

- SSH keys are machine-sensitive and high-risk.
- Avoid accidental key rotation, overwrite, or cross-machine leakage from config sync.

## New machine checklist

1. Install OpenSSH client.
2. Restore/import your SSH private keys from your secure backup process.
3. Restore/import your SSH config and known_hosts (optional but recommended).
4. Set strict permissions:
   - Linux/WSL: `chmod 700 ~/.ssh && chmod 600 ~/.ssh/*`
5. Verify access:
   - `ssh -T git@github.com`

## WSL local SSH bridge (optional)

If you use SSH to connect into WSL from Windows, keep that key local too:

- Windows key example: `~/.ssh/wsl_arch_ssh`
- WSL authorized key: `~/.ssh/authorized_keys`

Do **not** commit either file into this repo.
