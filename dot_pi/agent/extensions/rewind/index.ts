/**
 * Rewind extension - git-based file restoration for current-session history and tree navigation.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { exec as execCb } from "child_process";
import { readFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execAsync = promisify(execCb);

const REF_PREFIX = "refs/pi-checkpoints/";
const BEFORE_RESTORE_PREFIX = "before-restore-";
const ASSISTANT_CHECKPOINT_PREFIX = "checkpoint-assistant-";
const MAX_CHECKPOINTS = 100;
const STATUS_KEY = "restore";
const CHECKPOINT_LABEL_PREFIX = "rewind:";
const LEGACY_CHECKPOINT_LABEL_USER = "rewind:user";
const LEGACY_CHECKPOINT_LABEL_ASSISTANT = "rewind:assistant";
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

let cachedSilentCheckpoints: boolean | null = null;

function getSilentCheckpointsSetting(): boolean {
  if (cachedSilentCheckpoints !== null) {
    return cachedSilentCheckpoints;
  }
  try {
    const settingsContent = readFileSync(SETTINGS_FILE, "utf-8");
    const settings = JSON.parse(settingsContent);
    cachedSilentCheckpoints = settings.nodeRestore?.silentCheckpoints === true;
    return cachedSilentCheckpoints;
  } catch {
    cachedSilentCheckpoints = false;
    return false;
  }
}

/**
 * Sanitize entry ID for use in git ref names.
 * Git refs can't contain: space, ~, ^, :, ?, *, [, \, or control chars.
 * Entry IDs are typically alphanumeric but we sanitize just in case.
 */
function sanitizeForRef(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, "_");
}

function isManagedCheckpointLabel(label: string | undefined): boolean {
  if (!label) return false;
  if (label === LEGACY_CHECKPOINT_LABEL_USER || label === LEGACY_CHECKPOINT_LABEL_ASSISTANT) return true;
  return /^rewind:[UA]\d+$/.test(label);
}

function formatCheckpointTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
  return new Date(timestamp).toLocaleTimeString();
}

export default function (pi: ExtensionAPI) {
  // Snapshot per entry ID (user + assistant nodes that have checkpoints)
  const checkpoints = new Map<string, string>();
  let repoRoot: string | null = null;
  let isGitRepo = false;
  let sessionId: string | null = null;
  let latestAssistantSnapshot: { entryId: string; checkpointId: string } | null = null;

  // Pending checkpoint: worktree state captured at turn_start, waiting for turn_end
  // to associate with the correct user message entry ID
  let pendingCheckpoint: { commitSha: string; timestamp: number } | null = null;
  // Current undo/redo cursor in the checkpoint timeline.
  let historyCursorCheckpointId: string | null = null;
  // Skip one tree restore prompt when navigation is triggered by /undo or /redo.
  let skipNextTreeRestorePrompt = false;
  
  /**
   * Update the footer status with checkpoint count
   */
  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (getSilentCheckpointsSetting()) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } else {
      const theme = ctx.ui.theme;
      const count = checkpoints.size;
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "◆ ") + theme.fg("muted", `${count} checkpoint${count === 1 ? "" : "s"}`));
    }
  }
  
  function getSessionEntries(sessionManager: any): any[] {
    const entries = sessionManager.getEntries?.();
    if (Array.isArray(entries)) {
      return entries.filter((entry) => typeof entry?.id === "string");
    }

    const leafId = sessionManager.getLeafId?.();
    const branch = sessionManager.getBranch?.(leafId);
    if (Array.isArray(branch)) {
      return branch.filter((entry) => typeof entry?.id === "string");
    }

    return [];
  }

  function buildSanitizedEntryIdLookup(sessionManager: any): Map<string, string> {
    const lookup = new Map<string, string>();
    for (const entry of getSessionEntries(sessionManager)) {
      const sanitized = sanitizeForRef(entry.id);
      if (!lookup.has(sanitized)) {
        lookup.set(sanitized, entry.id);
      }
    }
    return lookup;
  }

  function resolveEntryIdFromSanitized(sessionManager: any, sanitizedEntryId: string): string | null {
    const lookup = buildSanitizedEntryIdLookup(sessionManager);
    return lookup.get(sanitizedEntryId) ?? null;
  }

  function buildCheckpointBadgeMap(checkpointIds: string[]): Map<string, string> {
    const sorted = [...new Set(checkpointIds)].sort((a, b) => {
      const timestampDiff = extractCheckpointTimestamp(a) - extractCheckpointTimestamp(b);
      return timestampDiff !== 0 ? timestampDiff : a.localeCompare(b);
    });

    const badges = new Map<string, string>();
    let userCount = 0;
    let assistantWithoutUserCount = 0;

    for (const checkpointId of sorted) {
      if (checkpointId.startsWith(ASSISTANT_CHECKPOINT_PREFIX)) {
        const assistantNumber = userCount > 0 ? userCount : ++assistantWithoutUserCount;
        badges.set(checkpointId, `A${assistantNumber}`);
        continue;
      }

      userCount += 1;
      badges.set(checkpointId, `U${userCount}`);
    }

    return badges;
  }

  function truncatePreviewText(text: string, maxLength = 56): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (!compact) return "(no text)";
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
  }

  function getEntryPreviewText(sessionManager: any, entryId: string | null): string {
    if (!entryId) return "unknown";

    const entry = sessionManager.getEntry?.(entryId);
    if (!entry) {
      return entryId.slice(0, 8);
    }

    if (entry.type !== "message") {
      return `(${entry.type})`;
    }

    const role = entry.message?.role;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];

    for (const item of content) {
      if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
        return truncatePreviewText(item.text);
      }
    }

    if (typeof role === "string" && role.length > 0) {
      return `(${role})`;
    }

    return "(message)";
  }

  function syncCheckpointLabels(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    const sessionManager = ctx.sessionManager as any;
    const entries = getSessionEntries(sessionManager);
    const lookup = buildSanitizedEntryIdLookup(sessionManager);
    const badgeMap = buildCheckpointBadgeMap([...checkpoints.values()]);
    const activeCheckpointEntryIds = new Set<string>();

    for (const [sanitizedEntryId, checkpointId] of checkpoints.entries()) {
      const rawEntryId = lookup.get(sanitizedEntryId);
      if (!rawEntryId) continue;

      const badge = badgeMap.get(checkpointId);
      if (!badge) continue;

      const desiredLabel = `${CHECKPOINT_LABEL_PREFIX}${badge}`;
      const currentLabel = sessionManager.getLabel?.(rawEntryId) as string | undefined;

      // Don't override user-managed labels.
      if (currentLabel && !isManagedCheckpointLabel(currentLabel) && currentLabel !== desiredLabel) {
        continue;
      }

      if (currentLabel !== desiredLabel) {
        pi.setLabel(rawEntryId, desiredLabel);
      }
      activeCheckpointEntryIds.add(rawEntryId);
    }

    for (const entry of entries) {
      const currentLabel = sessionManager.getLabel?.(entry.id) as string | undefined;
      if (!isManagedCheckpointLabel(currentLabel)) continue;
      if (activeCheckpointEntryIds.has(entry.id)) continue;
      pi.setLabel(entry.id, undefined);
    }
  }

  /**
   * Reset all state for a fresh session
   */
  function resetState() {
    checkpoints.clear();
    repoRoot = null;
    isGitRepo = false;
    sessionId = null;
    latestAssistantSnapshot = null;
    pendingCheckpoint = null;
    historyCursorCheckpointId = null;
    skipNextTreeRestorePrompt = false;
    cachedSilentCheckpoints = null;
  }

  /**
   * Rebuild checkpoint map from existing git refs.
   * Supports:
   * - User format: `checkpoint-{sessionId}-{timestamp}-{entryId}`
   * - Assistant format: `checkpoint-assistant-{sessionId}-{timestamp}-{entryId}`
   */
  async function rebuildCheckpointsMap(exec: ExecFn, currentSessionId: string): Promise<void> {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--sort=-creatordate",  // Newest first - we keep first match per entry
        "--format=%(refname)",
        REF_PREFIX,
      ]);

      const refs = result.stdout.trim().split("\n").filter(Boolean);

      for (const ref of refs) {
        // Get checkpoint ID by removing prefix
        const checkpointId = ref.replace(REF_PREFIX, "");

        // Skip non-checkpoint refs (before-restore, resume)
        if (!checkpointId.startsWith("checkpoint-")) continue;
        if (checkpointId.startsWith("checkpoint-resume-")) continue;

        // Assistant-node format: checkpoint-assistant-{sessionId}-{timestamp}-{entryId}
        const assistantMatch = checkpointId.match(/^checkpoint-assistant-([a-f0-9-]{36})-(\d+)-(.+)$/);
        if (assistantMatch) {
          const refSessionId = assistantMatch[1];
          const entryId = assistantMatch[3];
          if (!refSessionId || !entryId) continue;

          // Keep only newest assistant snapshot for this session.
          if (refSessionId === currentSessionId && !latestAssistantSnapshot) {
            latestAssistantSnapshot = { entryId, checkpointId };
            checkpoints.set(entryId, checkpointId);
          }
          continue;
        }

        // User-node format: checkpoint-{sessionId}-{timestamp}-{entryId}
        const newFormatMatch = checkpointId.match(/^checkpoint-([a-f0-9-]{36})-(\d+)-(.+)$/);
        if (newFormatMatch) {
          const refSessionId = newFormatMatch[1];
          const entryId = newFormatMatch[3];
          if (!refSessionId || !entryId) continue;

          // Only load checkpoints from the current session, keep newest (first seen)
          if (refSessionId === currentSessionId && !checkpoints.has(entryId)) {
            checkpoints.set(entryId, checkpointId);
          }
          continue;
        }

      }

    } catch {
      // Silent failure - checkpoints will be recreated as needed
    }
  }

  async function findBeforeRestoreRefName(exec: ExecFn, currentSessionId: string): Promise<string | null> {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--sort=-creatordate",
        "--count=1",
        "--format=%(refname)",
        `${REF_PREFIX}${BEFORE_RESTORE_PREFIX}${currentSessionId}-*`,
      ]);

      const refName = result.stdout.trim();
      return refName || null;
    } catch {
      return null;
    }
  }

  async function ensureGitRepo(exec: ExecFn): Promise<boolean> {
    if (isGitRepo) return true;
    try {
      const result = await exec("git", ["rev-parse", "--is-inside-work-tree"]);
      isGitRepo = result.stdout.trim() === "true";
    } catch {
      isGitRepo = false;
    }
    return isGitRepo;
  }

  async function getRepoRoot(exec: ExecFn): Promise<string> {
    if (repoRoot) return repoRoot;
    const result = await exec("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = result.stdout.trim();
    return repoRoot;
  }

  /**
   * Capture current worktree state as a git commit (without affecting HEAD).
   * Uses execAsync directly (instead of pi.exec) because we need to set
   * GIT_INDEX_FILE environment variable for an isolated index.
   */
  async function captureWorktree(): Promise<string> {
    const root = await getRepoRoot(pi.exec);
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-node-restore-"));
    const tmpIndex = join(tmpDir, "index");

    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      await execAsync("git add -A", { cwd: root, env });
      const { stdout: treeSha } = await execAsync("git write-tree", { cwd: root, env });

      const result = await pi.exec("git", ["commit-tree", treeSha.trim(), "-m", "node restore backup"]);
      return result.stdout.trim();
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function restoreWithBackup(
    exec: ExecFn,
    targetRef: string,
    currentSessionId: string,
    notify: (msg: string, level: "info" | "warning" | "error") => void
  ): Promise<boolean> {
    try {
      const existingBackupRefName = await findBeforeRestoreRefName(exec, currentSessionId);

      const backupCommit = await captureWorktree();
      // Include session ID in before-restore ref to scope it per-session
      const newBackupId = `${BEFORE_RESTORE_PREFIX}${currentSessionId}-${Date.now()}`;
      await exec("git", [
        "update-ref",
        `${REF_PREFIX}${newBackupId}`,
        backupCommit,
      ]);

      if (existingBackupRefName) {
        await exec("git", ["update-ref", "-d", existingBackupRefName]);
      }

      await exec("git", [
        "restore",
        "--worktree",
        "--source",
        targetRef,
        "--",
        ".",
      ]);
      return true;
    } catch (err) {
      notify(`Failed to restore: ${err}`, "error");
      return false;
    }
  }

  async function createCheckpointFromWorktree(exec: ExecFn, checkpointId: string): Promise<boolean> {
    try {
      const commitSha = await captureWorktree();
      await exec("git", [
        "update-ref",
        `${REF_PREFIX}${checkpointId}`,
        commitSha,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async function getTreeShaForObject(exec: ExecFn, objectRef: string): Promise<string | null> {
    try {
      const result = await exec("git", ["rev-parse", `${objectRef}^{tree}`]);
      const treeSha = result.stdout.trim();
      return treeSha || null;
    } catch {
      return null;
    }
  }

  async function hasSameTreeAsAny(
    exec: ExecFn,
    commitSha: string,
    targets: string[],
  ): Promise<boolean> {
    const snapshotTreeSha = await getTreeShaForObject(exec, commitSha);
    if (!snapshotTreeSha) return false;

    const dedupedTargets = Array.from(new Set(targets.filter(Boolean)));
    for (const target of dedupedTargets) {
      const targetTreeSha = await getTreeShaForObject(exec, target);
      if (targetTreeSha && targetTreeSha === snapshotTreeSha) {
        return true;
      }
    }

    return false;
  }

  function extractCheckpointTimestamp(checkpointId: string): number {
    const userMatch = checkpointId.match(/^checkpoint-[a-f0-9-]{36}-(\d+)-.+$/);
    if (userMatch?.[1]) return Number(userMatch[1]);

    const assistantMatch = checkpointId.match(/^checkpoint-assistant-[a-f0-9-]{36}-(\d+)-.+$/);
    if (assistantMatch?.[1]) return Number(assistantMatch[1]);

    return 0;
  }

  function extractCheckpointEntryId(checkpointId: string): string | null {
    const userMatch = checkpointId.match(/^checkpoint-[a-f0-9-]{36}-\d+-(.+)$/);
    if (userMatch?.[1]) return userMatch[1];

    const assistantMatch = checkpointId.match(/^checkpoint-assistant-[a-f0-9-]{36}-\d+-(.+)$/);
    if (assistantMatch?.[1]) return assistantMatch[1];

    return null;
  }

  async function getCheckpointTimeline(currentSessionId: string): Promise<string[]> {
    try {
      const result = await pi.exec("git", [
        "for-each-ref",
        "--format=%(refname)",
        REF_PREFIX,
      ]);

      const refs = result.stdout.trim().split("\n").filter(Boolean);
      const timeline: string[] = [];

      for (const ref of refs) {
        const checkpointId = ref.replace(REF_PREFIX, "");

        if (checkpointId.startsWith(`checkpoint-${currentSessionId}-`)) {
          timeline.push(checkpointId);
          continue;
        }

        if (checkpointId.startsWith(`${ASSISTANT_CHECKPOINT_PREFIX}${currentSessionId}-`)) {
          timeline.push(checkpointId);
        }
      }

      timeline.sort((a, b) => {
        const timestampDiff = extractCheckpointTimestamp(a) - extractCheckpointTimestamp(b);
        return timestampDiff !== 0 ? timestampDiff : a.localeCompare(b);
      });

      return timeline;
    } catch {
      return [];
    }
  }

  function resolveHistoryCursorIndex(timeline: string[]): number {
    if (timeline.length === 0) return -1;

    if (historyCursorCheckpointId) {
      const cursorIndex = timeline.indexOf(historyCursorCheckpointId);
      if (cursorIndex !== -1) {
        return cursorIndex;
      }
    }

    // Default to latest checkpoint when no explicit cursor is set.
    return timeline.length - 1;
  }

  async function navigateCheckpointHistory(
    direction: "undo" | "redo",
    currentSessionId: string,
    notify: (msg: string, level: "info" | "warning" | "error") => void,
    navigateToEntry?: (entryId: string) => Promise<void>,
  ): Promise<boolean> {
    const timeline = await getCheckpointTimeline(currentSessionId);
    if (timeline.length === 0) {
      notify("No checkpoints available", "warning");
      return false;
    }

    const currentIndex = resolveHistoryCursorIndex(timeline);
    const targetIndex = direction === "undo" ? currentIndex - 1 : currentIndex + 1;

    if (targetIndex < 0 || targetIndex >= timeline.length) {
      notify(direction === "undo" ? "No older checkpoint" : "No newer checkpoint", "warning");
      return false;
    }

    const targetCheckpointId = timeline[targetIndex];
    if (!targetCheckpointId) {
      notify("Checkpoint target is not available", "warning");
      return false;
    }

    const success = await restoreWithBackup(
      pi.exec,
      `${REF_PREFIX}${targetCheckpointId}`,
      currentSessionId,
      notify,
    );

    if (!success) {
      return false;
    }

    historyCursorCheckpointId = targetCheckpointId;

    const entryId = extractCheckpointEntryId(targetCheckpointId);
    if (entryId && navigateToEntry) {
      await navigateToEntry(entryId).catch(() => {});
    }

    notify(`Restored to checkpoint ${targetIndex + 1}/${timeline.length}`, "info");
    return true;
  }

  /**
   * Find the most recent user message in the current branch.
   * Used at turn_end to find the user message that triggered the agent loop.
   */
  function findUserMessageEntry(
    sessionManager: { getLeafId(): string | null; getBranch(id?: string): any[] },
  ): { id: string; parentId?: string | null } | null {
    const leafId = sessionManager.getLeafId();
    if (!leafId) return null;

    const branch = sessionManager.getBranch(leafId);
    // Walk backwards to find the most recent user message
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message?.role === "user") {
        return entry;
      }
    }
    return null;
  }

  /**
   * Find assistant message in the current branch.
   * If targetTimestamp is provided, prefer exact timestamp match for the current turn.
   */
  function findAssistantMessageEntry(
    sessionManager: { getLeafId(): string | null; getBranch(id?: string): any[] },
    targetTimestamp?: number,
    allowFallback = true,
  ): { id: string; parentId?: string | null } | null {
    const leafId = sessionManager.getLeafId();
    if (!leafId) return null;

    const branch = sessionManager.getBranch(leafId);

    if (typeof targetTimestamp === "number" && Number.isFinite(targetTimestamp)) {
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          entry.message?.timestamp === targetTimestamp
        ) {
          return entry;
        }
      }

      if (!allowFallback) {
        return null;
      }
    }

    // Fallback to latest assistant in branch.
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message?.role === "assistant") {
        return entry;
      }
    }

    return null;
  }

  async function waitForAssistantMessageEntry(
    sessionManager: { getLeafId(): string | null; getBranch(id?: string): any[] },
    targetTimestamp?: number,
    maxAttempts = 8,
    delayMs = 20,
  ): Promise<{ id: string; parentId?: string | null } | null> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const exact = findAssistantMessageEntry(sessionManager, targetTimestamp, false);
      if (exact) return exact;

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return findAssistantMessageEntry(sessionManager);
  }

  async function pruneCheckpoints(exec: ExecFn, currentSessionId: string) {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--sort=creatordate",
        "--format=%(refname)",
        REF_PREFIX,
      ]);

      const refs = result.stdout.trim().split("\n").filter(Boolean);

      const checkpointRefs = refs.filter((r) => {
        if (r.includes(BEFORE_RESTORE_PREFIX)) return false;
        if (r.includes("checkpoint-resume-")) return false;
        const checkpointId = r.replace(REF_PREFIX, "");
        return checkpointId.startsWith(`checkpoint-${currentSessionId}-`);
      });

      const assistantRefs = refs.filter((r) => {
        const checkpointId = r.replace(REF_PREFIX, "");
        return checkpointId.startsWith(`${ASSISTANT_CHECKPOINT_PREFIX}${currentSessionId}-`);
      });

      // Keep only newest assistant snapshot for this session.
      if (assistantRefs.length > 1) {
        const toDelete = assistantRefs.slice(0, assistantRefs.length - 1);
        for (const ref of toDelete) {
          await exec("git", ["update-ref", "-d", ref]);

          const checkpointId = ref.replace(REF_PREFIX, "");
          const match = checkpointId.match(/^checkpoint-assistant-([a-f0-9-]{36})-(\d+)-(.+)$/);
          if (!match) continue;

          const entryId = match[3];
          if (!entryId) continue;

          if (checkpoints.get(entryId) === checkpointId) {
            checkpoints.delete(entryId);
          }
          if (latestAssistantSnapshot?.checkpointId === checkpointId) {
            latestAssistantSnapshot = null;
          }
        }
      }

      const newestAssistantRef = assistantRefs[assistantRefs.length - 1];
      if (newestAssistantRef) {
        const checkpointId = newestAssistantRef.replace(REF_PREFIX, "");
        const match = checkpointId.match(/^checkpoint-assistant-([a-f0-9-]{36})-(\d+)-(.+)$/);
        if (match) {
          const entryId = match[3];
          if (entryId) {
            latestAssistantSnapshot = { entryId, checkpointId };
            checkpoints.set(entryId, checkpointId);
          }
        }
      }

      if (checkpointRefs.length > MAX_CHECKPOINTS) {
        const toDelete = checkpointRefs.slice(0, checkpointRefs.length - MAX_CHECKPOINTS);
        for (const ref of toDelete) {
          await exec("git", ["update-ref", "-d", ref]);

          const checkpointId = ref.replace(REF_PREFIX, "");
          const match = checkpointId.match(/^checkpoint-([a-f0-9-]{36})-(\d+)-(.+)$/);
          if (!match) continue;

          const entryId = match[3];
          if (!entryId) continue;

          if (checkpoints.get(entryId) === checkpointId) {
            checkpoints.delete(entryId);
          }
        }
      }
    } catch {
      // Silent failure - pruning is not critical
    }
  }

  async function clearSessionCheckpoints(exec: ExecFn, currentSessionId: string): Promise<number> {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--format=%(refname)",
        REF_PREFIX,
      ]);

      const refs = result.stdout.trim().split("\n").filter(Boolean);
      const refsToDelete = refs.filter((ref) => {
        const checkpointId = ref.replace(REF_PREFIX, "");

        if (checkpointId.startsWith(`checkpoint-${currentSessionId}-`)) return true;
        if (checkpointId.startsWith(`${ASSISTANT_CHECKPOINT_PREFIX}${currentSessionId}-`)) return true;
        if (checkpointId.startsWith(`checkpoint-resume-${currentSessionId}-`)) return true;
        if (checkpointId.startsWith(`${BEFORE_RESTORE_PREFIX}${currentSessionId}-`)) return true;

        return false;
      });

      for (const ref of refsToDelete) {
        await exec("git", ["update-ref", "-d", ref]);
      }

      return refsToDelete.length;
    } catch {
      return 0;
    }
  }

  /**
   * Initialize the extension for the current session/repo
   */
  async function initializeForSession(ctx: ExtensionContext) {
    // Reset all state for fresh initialization
    resetState();

    // Capture session ID for scoping checkpoints
    sessionId = ctx.sessionManager.getSessionId();

    try {
      const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
      isGitRepo = result.stdout.trim() === "true";
    } catch {
      isGitRepo = false;
    }

    if (!isGitRepo) {
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      return;
    }

    // Rebuild checkpoints map from existing git refs (for resumed sessions)
    // Only loads checkpoints belonging to this session
    await rebuildCheckpointsMap(pi.exec, sessionId);

    // Normalize refs for this session (e.g. keep only newest assistant snapshot).
    await pruneCheckpoints(pi.exec, sessionId);

    syncCheckpointLabels(ctx);
    updateStatus(ctx);
  }

  pi.registerCommand("undo", {
    description: "Restore files to previous checkpoint",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const currentSessionId = ctx.sessionManager.getSessionId();
      const notify = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : () => {};

      await navigateCheckpointHistory("undo", currentSessionId, notify, async (entryId) => {
        const targetId = resolveEntryIdFromSanitized(ctx.sessionManager as any, entryId) ?? entryId;
        skipNextTreeRestorePrompt = true;
        try {
          await ctx.navigateTree(targetId, { summarize: false });
        } finally {
          if (skipNextTreeRestorePrompt) {
            skipNextTreeRestorePrompt = false;
          }
        }
      });
    },
  });

  pi.registerCommand("redo", {
    description: "Restore files to next checkpoint",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const currentSessionId = ctx.sessionManager.getSessionId();
      const notify = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : () => {};

      await navigateCheckpointHistory("redo", currentSessionId, notify, async (entryId) => {
        const targetId = resolveEntryIdFromSanitized(ctx.sessionManager as any, entryId) ?? entryId;
        skipNextTreeRestorePrompt = true;
        try {
          await ctx.navigateTree(targetId, { summarize: false });
        } finally {
          if (skipNextTreeRestorePrompt) {
            skipNextTreeRestorePrompt = false;
          }
        }
      });
    },
  });

  pi.registerCommand("checkpoint-list", {
    description: "List checkpoints and restore to selected checkpoint",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const notify = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : () => {};
      const currentSessionId = ctx.sessionManager.getSessionId();

      try {
        const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
        if (result.stdout.trim() !== "true") {
          notify("Not in a Git repository", "warning");
          return;
        }
      } catch {
        notify("Not in a Git repository", "warning");
        return;
      }

      const timeline = await getCheckpointTimeline(currentSessionId);
      if (timeline.length === 0) {
        notify("No checkpoints available", "info");
        return;
      }

      const timelineDescending = [...timeline].reverse();
      const sessionManager = ctx.sessionManager as any;
      const lookup = buildSanitizedEntryIdLookup(sessionManager);
      const badgeMap = buildCheckpointBadgeMap(timeline);

      const items = timelineDescending.map((checkpointId) => {
        const timestamp = formatCheckpointTime(extractCheckpointTimestamp(checkpointId));
        const checkpointEntryId = extractCheckpointEntryId(checkpointId);
        const resolvedEntryId = checkpointEntryId ? lookup.get(checkpointEntryId) ?? checkpointEntryId : null;
        const badge = badgeMap.get(checkpointId) ?? (checkpointId.startsWith(ASSISTANT_CHECKPOINT_PREFIX) ? "A?" : "U?");
        const preview = getEntryPreviewText(sessionManager, resolvedEntryId);
        const label = `[${badge}] ${timestamp} · ${preview}`;

        return { checkpointId, resolvedEntryId, label };
      });

      const selectedLabel = await ctx.ui.select("Rewind checkpoints", items.map((item) => item.label));
      if (!selectedLabel) return;

      const selectedItem = items.find((item) => item.label === selectedLabel);
      if (!selectedItem) {
        notify("Selected checkpoint is not available", "warning");
        return;
      }

      const success = await restoreWithBackup(
        pi.exec,
        `${REF_PREFIX}${selectedItem.checkpointId}`,
        currentSessionId,
        notify,
      );

      if (!success) {
        return;
      }

      historyCursorCheckpointId = selectedItem.checkpointId;

      const targetId = selectedItem.resolvedEntryId;
      if (targetId) {
        skipNextTreeRestorePrompt = true;
        try {
          await ctx.navigateTree(targetId, { summarize: false });
        } finally {
          if (skipNextTreeRestorePrompt) {
            skipNextTreeRestorePrompt = false;
          }
        }
      }

      notify("Restored selected checkpoint", "info");
    },
  });

  pi.registerCommand("clear-checkpoint", {
    description: "Delete rewind checkpoints for the current session",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const notify = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : () => {};
      const currentSessionId = ctx.sessionManager.getSessionId();

      try {
        const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
        if (result.stdout.trim() !== "true") {
          notify("Not in a Git repository", "warning");
          return;
        }
      } catch {
        notify("Not in a Git repository", "warning");
        return;
      }

      const deletedCount = await clearSessionCheckpoints(pi.exec, currentSessionId);

      checkpoints.clear();
      latestAssistantSnapshot = null;
      pendingCheckpoint = null;
      historyCursorCheckpointId = null;

      syncCheckpointLabels(ctx);
      updateStatus(ctx);

      if (deletedCount === 0) {
        notify("No checkpoints found for this session", "info");
        return;
      }

      notify(`Cleared ${deletedCount} checkpoint${deletedCount === 1 ? "" : "s"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await initializeForSession(ctx);
  });
  
  pi.on("session_switch", async (_event, ctx) => {
    await initializeForSession(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!(await ensureGitRepo(pi.exec))) return;

    // Capture once per agent loop (before first effective tool-side changes).
    // We don't rely on event.turnIndex semantics; instead we only capture when
    // there is no pending snapshot yet.
    if (pendingCheckpoint) return;

    try {
      // Capture worktree state now, but don't create the ref yet.
      // At this point, the triggering user message may not be the leaf yet,
      // so we defer ref creation until turn_end.
      const commitSha = await captureWorktree();
      pendingCheckpoint = { commitSha, timestamp: event.timestamp };
    } catch {
      pendingCheckpoint = null;
    }
  });

  pi.on("message_start", async (event, ctx) => {
    if (!(await ensureGitRepo(pi.exec))) return;

    // Agent first turns don't emit turn_start.
    // Capture baseline when assistant starts streaming to support single-turn prompts.
    if (event.message?.role !== "assistant") return;
    if (pendingCheckpoint) return;

    try {
      const commitSha = await captureWorktree();
      pendingCheckpoint = { commitSha, timestamp: Date.now() };
    } catch {
      pendingCheckpoint = null;
    }
  });

  pi.on("agent_end", async () => {
    // Safety reset: never carry pending turn snapshot across prompts.
    pendingCheckpoint = null;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!(await ensureGitRepo(pi.exec))) return;
    if (!sessionId) return;

    let changed = false;
    let createdUserCheckpointId: string | null = null;
    let createdAssistantCheckpointId: string | null = null;

    try {
      // turn_end can race with session persistence. Wait briefly for this turn's
      // assistant entry to appear, then use it as tree navigation anchor.
      const assistantEntry = await waitForAssistantMessageEntry(
        ctx.sessionManager,
        event.message?.role === "assistant" ? event.message.timestamp : undefined,
      );
      const assistantEntryKey = assistantEntry ? sanitizeForRef(assistantEntry.id) : null;
      const assistantCommitSha = await captureWorktree();

      const hasRepoChangesSinceTurnStart = pendingCheckpoint
        ? !(await hasSameTreeAsAny(pi.exec, assistantCommitSha, [pendingCheckpoint.commitSha]))
        : true;

      // Only create a user checkpoint when the repo actually changed during this turn.
      if (pendingCheckpoint && hasRepoChangesSinceTurnStart) {
        const userEntry = findUserMessageEntry(ctx.sessionManager);
        if (userEntry) {
          const sanitizedEntryId = sanitizeForRef(userEntry.id);
          if (!checkpoints.has(sanitizedEntryId)) {
            const checkpointId = `checkpoint-${sessionId}-${pendingCheckpoint.timestamp}-${sanitizedEntryId}`;
            await pi.exec("git", [
              "update-ref",
              `${REF_PREFIX}${checkpointId}`,
              pendingCheckpoint.commitSha,
            ]);
            checkpoints.set(sanitizedEntryId, checkpointId);
            createdUserCheckpointId = checkpointId;
            changed = true;
          }
        }
      }

      const comparisonTargets: string[] = [];
      if (latestAssistantSnapshot?.checkpointId) {
        comparisonTargets.push(`${REF_PREFIX}${latestAssistantSnapshot.checkpointId}`);
      }
      if (createdUserCheckpointId) {
        comparisonTargets.push(`${REF_PREFIX}${createdUserCheckpointId}`);
      }
      if (historyCursorCheckpointId) {
        comparisonTargets.push(`${REF_PREFIX}${historyCursorCheckpointId}`);
      }
      if (pendingCheckpoint?.commitSha) {
        comparisonTargets.push(pendingCheckpoint.commitSha);
      }

      const hasRepoChanges = hasRepoChangesSinceTurnStart &&
        !(await hasSameTreeAsAny(pi.exec, assistantCommitSha, comparisonTargets));

      if (assistantEntryKey && hasRepoChanges) {
        const assistantCheckpointId = `${ASSISTANT_CHECKPOINT_PREFIX}${sessionId}-${Date.now()}-${assistantEntryKey}`;

        await pi.exec("git", [
          "update-ref",
          `${REF_PREFIX}${assistantCheckpointId}`,
          assistantCommitSha,
        ]);

        // Keep only one assistant snapshot: the newest one.
        if (latestAssistantSnapshot && latestAssistantSnapshot.checkpointId !== assistantCheckpointId) {
          await pi.exec("git", ["update-ref", "-d", `${REF_PREFIX}${latestAssistantSnapshot.checkpointId}`]).catch(() => {});
          if (checkpoints.get(latestAssistantSnapshot.entryId) === latestAssistantSnapshot.checkpointId) {
            checkpoints.delete(latestAssistantSnapshot.entryId);
          }
        }

        checkpoints.set(assistantEntryKey, assistantCheckpointId);
        latestAssistantSnapshot = { entryId: assistantEntryKey, checkpointId: assistantCheckpointId };
        createdAssistantCheckpointId = assistantCheckpointId;
        changed = true;
      }

      if (changed) {
        await pruneCheckpoints(pi.exec, sessionId);

        if (createdAssistantCheckpointId) {
          historyCursorCheckpointId = createdAssistantCheckpointId;
        } else if (createdUserCheckpointId) {
          historyCursorCheckpointId = createdUserCheckpointId;
        }

        syncCheckpointLabels(ctx);
        updateStatus(ctx);
      }
    } catch {
      // Silent failure - checkpoint creation is not critical
    } finally {
      // Never carry pending turn snapshot across turns.
      pendingCheckpoint = null;
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!sessionId) return;

    if (skipNextTreeRestorePrompt) {
      skipNextTreeRestorePrompt = false;
      return;
    }

    try {
      const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
      if (result.stdout.trim() !== "true") return;
    } catch {
      return;
    }

    const targetId = event.preparation.targetId;
    const entryKey = sanitizeForRef(targetId);
    const checkpointId = checkpoints.get(entryKey);

    // Nothing actionable for this selected node -> don't interrupt with a menu.
    if (!checkpointId) {
      return;
    }

    const options = [
      "Keep current files",
      "Restore files to this node",
      "Cancel navigation",
    ];

    const choice = await ctx.ui.select("Restore Options", options);

    if (!choice || choice === "Cancel navigation") {
      ctx.ui.notify("Navigation cancelled", "info");
      return { cancel: true };
    }

    if (choice === "Keep current files") {
      return;
    }

    if (choice !== "Restore files to this node") {
      ctx.ui.notify("Selected restore target is not available", "warning");
      return;
    }

    const ref = `${REF_PREFIX}${checkpointId}`;
    const success = await restoreWithBackup(
      pi.exec,
      ref,
      sessionId,
      ctx.ui.notify.bind(ctx.ui)
    );

    if (!success) {
      // File restore failed - cancel navigation
      // (restoreWithBackup already notified the user of the error)
      return { cancel: true };
    }

    historyCursorCheckpointId = checkpointId;
    ctx.ui.notify("Files restored to this node", "info");
  });

}
