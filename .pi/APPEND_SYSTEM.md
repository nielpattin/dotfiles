# Project-specific Pi instructions (chezmoi repo only)

- This directory is the chezmoi source repo: `~/.local/share/chezmoi`.
- Edit source files in this repo first, then sync with `chezmoi apply`.
- Never use force flags with chezmoi.
- If `chezmoi apply` needs force/conflict bypass, stop and ask the user.
- Use `./tmp` for downloads/clones/extractions.
- For Pi config changes, edit `dot_pi/` in this repo (not live `~/.pi`) unless explicitly requested.
