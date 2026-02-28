# Rewind Extension

# NOT WORKING YET - IN DEVELOPMENT

Restore files as you move through Pi conversation history.

This extension adds file snapshots so `/tree`, `/undo`, `/redo`, and `/checkpoint-list` can restore code to specific points in the current session.

## Requirements

- Pi agent `v0.52.2` or later
- A Git repository (snapshots are stored as git refs) 
- Need 1 commit base for snapshots (can be an empty commit)

---

## Configuration

```json
{
  "nodeRestore": {
    "silentCheckpoints": false
  }
}
```

- `nodeRestore.silentCheckpoints`:
  - `false` (default): show checkpoint count in footer
  - `true`: hide checkpoint count in footer

---

## Quick start

1. Open Pi in a Git repo.
2. Ask Pi to edit files.
3. Use `/tree` and pick a restore option when needed.
4. Use `/undo`, `/redo`, or `/checkpoint-list` to move across checkpoint history.

---

## How snapshots work

Snapshots are stored as git refs under `refs/pi-checkpoints/`.

### Snapshot rules

1. **Each user turn**
   - Creates a user-node snapshot (`checkpoint-*`) **only when repo tree changed**
2. **Assistant completion**
   - Creates an assistant-node snapshot (`checkpoint-assistant-*`) **only when repo tree changed**
   - Keeps only the newest assistant snapshot for the session
   - Read-only turns (no file changes) do not create user or assistant checkpoints
3. **Tool/result nodes**
   - No dedicated snapshot

### Tree checkpoint markers

- Entries with checkpoints get numbered tree labels:
  - `rewind:U1`, `rewind:U2`, ... (user checkpoints)
  - `rewind:A1`, `rewind:A2`, ... (assistant checkpoints)
- Extension does not overwrite existing custom labels

---

## Restore behavior

### `/tree`

If selected node has a snapshot, menu is:

- `Keep current files`
- `Restore files to this node`
- `Cancel navigation`

If selected node has no snapshot, no restore menu is shown.

---

## Undo / Redo

- `/undo` = previous checkpoint in current session timeline
- `/redo` = next checkpoint in current session timeline

Important:

- Undo/redo restore **files and tree position** together
- Timeline includes:
  - user-node checkpoints
  - latest assistant-node checkpoint

### Checkpoint picker

- `/checkpoint-list` shows numbered checkpoints for current session (e.g. `U2`, `A2`)
- Each row includes time + truncated text preview from that node
- Pick one entry to restore files and jump tree to that checkpoint node

### Clear checkpoints for current session

- `/clear-checkpoint` deletes rewind refs for the active Pi session only
- Also resets in-memory rewind state/cursor immediately

---

## What file restore does

- Restores worktree files from snapshot
- Does not auto-stage files during restore
- Does not auto-delete unrelated untracked files

If you want untracked cleanup:

```bash
git clean -fd
```

---

## Test script (single Bun test file)

```bash
cd ~/.local/share/chezmoi/dot_pi/agent
bun test extensions/rewind/rewind.test.js
```


---

## Useful commands

### List checkpoints

```bash
git for-each-ref --format='%(refname)' refs/pi-checkpoints/
```

### Delete all checkpoints (bash)

```bash
git for-each-ref --format='%(refname)' refs/pi-checkpoints/ | while read -r ref; do git update-ref -d "$ref"; done
```

### Delete all checkpoints (PowerShell)

```powershell
git for-each-ref --format='%(refname)' refs/pi-checkpoints/ | ForEach-Object { git update-ref -d $_ }
```

---

## Troubleshooting

- **No restore menu in `/tree`**: selected node has no snapshot.
- **Undo/redo says no older/newer checkpoint**: you’re already at timeline edge.
- **Behavior looks stale after update**: restart Pi to reload extension code.

---

## Uninstall

1. Remove extension folder:

```bash
rm -rf ~/.pi/agent/extensions/rewind
```

PowerShell:

```powershell
Remove-Item -Recurse -Force ~/.pi/agent/extensions/rewind
```

2. Remove extension from `~/.pi/agent/settings.json`.
3. Optionally delete `refs/pi-checkpoints/*`.
