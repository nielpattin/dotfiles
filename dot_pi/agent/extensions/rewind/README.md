# Node Restore Extension

Restore files as you move through Pi conversation history.

This extension adds file snapshots so `/tree`, `/fork`, `/undo`, and `/redo` can restore code to specific points in the session.

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
3. Use `/tree` or `/fork` and pick a restore option.
4. Use `/undo` and `/redo` to move across checkpoint history.

---

## How snapshots work

Snapshots are stored as git refs under `refs/pi-checkpoints/`.

### Snapshot rules

1. **Session start**
   - Creates `checkpoint-resume-*` (fallback restore point)
2. **Each user turn**
   - Creates a user-node snapshot (`checkpoint-*`)
3. **Assistant completion**
   - Keeps exactly one latest assistant snapshot (`checkpoint-assistant-*`)
   - Old assistant snapshot is replaced
4. **Tool/result nodes**
   - No dedicated snapshot

---

## Restore behavior

### `/tree`

If selected node has a snapshot, menu is:

- `Keep current files`
- `Restore files to this node`
- `Cancel navigation`

If selected node has no snapshot, no restore menu is shown.

### `/fork`

Primary options:

- `Conversation only (keep current files)`
- `Restore files + conversation to selected node`
- `Restore files only to selected node (keep conversation)`

If selected node has no snapshot, `/fork` falls back to session start (`checkpoint-resume-*`).

---

## Undo / Redo

- `/undo` = previous checkpoint in current session timeline
- `/redo` = next checkpoint in current session timeline

Important:

- Undo/redo restore **files and tree position** together
- Timeline includes:
  - user-node checkpoints
  - latest assistant-node checkpoint
- Timeline excludes:
  - `checkpoint-resume-*` (resume is for `/fork` fallback only)

---

## What file restore does

- Restores worktree files from snapshot
- Preserves staged changes
- Does not auto-delete unrelated untracked files

If you want untracked cleanup:

```bash
git clean -fd
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
