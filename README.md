# Dotfiles (chezmoi source)

This repository is the source of truth for your managed config files.

## Choose your OS guide

- Windows setup and workflow: [`README.windows.md`](./README.windows.md)
- Linux setup and workflow: [`README.linux.md`](./README.linux.md)

## Project policy

- This repo stores configuration files, templates, and documentation.
- This repo does **not** run hidden system bootstrap for you.
- System package installation is explicit and documented in OS guides.
- SSH is machine-local and intentionally unmanaged.

## Shared workflow

1. Edit source files in this repo (`~/.local/share/chezmoi`).
2. Review changes: `chezmoi diff`.
3. Sync to home: `chezmoi apply`.
4. Verify clean state: `chezmoi status`.

## For AI assistants

- Always edit source files in this repo, not generated files in home.
- Use OS-specific guide first (`README.windows.md` / `README.linux.md`).
- Do not add automatic bootstrap scripts without explicit user request.
- Keep changes focused on config and documentation.
