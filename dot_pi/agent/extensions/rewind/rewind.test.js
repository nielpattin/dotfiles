import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import rewindExtension from "./index.ts";

function run(cmd, args, cwd, allowFailure = false) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error([
      `Command failed: ${cmd} ${args.join(" ")}`,
      `cwd: ${cwd}`,
      `exit: ${result.status}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`,
    ].join("\n"));
  }
  return result;
}

function sanitizeForRef(id) {
  return id.replace(/[^a-zA-Z0-9-]/g, "_");
}

test("rewind: current-session only + first-turn tool-result still creates user+assistant checkpoints", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "rewind-bun-test-"));
  const repoDir = join(tempRoot, "repo");
  mkdirSync(repoDir, { recursive: true });

  try {
    run("git", ["init"], repoDir);
    run("git", ["config", "user.name", "Rewind Test"], repoDir);
    run("git", ["config", "user.email", "rewind-test@example.com"], repoDir);

    const filePath = join(repoDir, "demo.txt");
    writeFileSync(filePath, "v1\n", "utf8");
    run("git", ["add", "demo.txt"], repoDir);
    run("git", ["commit", "-m", "initial"], repoDir);

    const handlers = new Map();
    const commands = new Map();
    const labels = new Map();

    const piApi = {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
      setLabel(entryId, label) {
        labels.set(entryId, label);
      },
      async exec(cmd, args) {
        const result = run(cmd, args, repoDir);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.status ?? 0,
        };
      },
    };

    rewindExtension(piApi);

    expect(handlers.has("session_before_fork")).toBe(false);

    const sessionId = "11111111-1111-4111-8111-111111111111";
    const userId = "user-1";
    const assistantId = "assistant-1";
    const toolResultId = "tool-1";

    const entries = [
      {
        id: userId,
        parentId: null,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "please edit demo.txt" }] },
      },
      {
        id: assistantId,
        parentId: userId,
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
      {
        id: toolResultId,
        parentId: assistantId,
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: "edited demo.txt" }] },
      },
    ];

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    let leafId = toolResultId;

    const sessionManager = {
      getSessionId: () => sessionId,
      getEntries: () => [...entries],
      getLeafId: () => leafId,
      getEntry: (id) => byId.get(id),
      getLabel: (id) => labels.get(id),
      getBranch: (fromId) => {
        const startId = fromId ?? leafId;
        if (!startId) return [];

        const reversed = [];
        let cursor = byId.get(startId);
        while (cursor) {
          reversed.push(cursor);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
        return reversed.reverse();
      },
    };

    const ctx = {
      hasUI: true,
      ui: {
        theme: { fg: (_token, value) => value },
        setStatus: () => {},
        notify: () => {},
        select: async () => {
          throw new Error("UI select was not expected in this test");
        },
      },
      sessionManager,
      cwd: repoDir,
    };

    async function emit(eventType, event, context) {
      const list = handlers.get(eventType) ?? [];
      for (const handler of list) {
        await handler(event, context);
      }
    }

    await emit("session_start", { type: "session_start" }, ctx);

    const refsAfterStart = run("git", ["for-each-ref", "--format=%(refname)", "refs/pi-checkpoints/"], repoDir, true)
      .stdout
      .split("\n")
      .filter(Boolean);

    expect(refsAfterStart.some((ref) => ref.includes(`checkpoint-resume-${sessionId}`))).toBe(false);

    // Simulate first-turn behavior: no turn_start event is emitted by agent loop.
    // Rewind should still capture baseline on assistant message_start.
    await emit(
      "message_start",
      {
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "starting" }], timestamp: Date.now() },
      },
      ctx,
    );

    // Simulate tool-side change during the turn.
    writeFileSync(filePath, "v2\n", "utf8");

    // Keep leaf on toolResult to mirror real tool-heavy turns.
    leafId = toolResultId;

    await emit(
      "turn_end",
      {
        type: "turn_end",
        turnIndex: 0,
        message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() },
        toolResults: [],
      },
      ctx,
    );

    const refs = run("git", ["for-each-ref", "--format=%(refname)", "refs/pi-checkpoints/"], repoDir)
      .stdout
      .split("\n")
      .filter(Boolean);

    const userKey = sanitizeForRef(userId);
    const assistantKey = sanitizeForRef(assistantId);

    const userRefs = refs.filter((ref) => ref.includes(`/checkpoint-${sessionId}-`) && ref.endsWith(`-${userKey}`));
    const assistantRefs = refs.filter(
      (ref) => ref.includes(`/checkpoint-assistant-${sessionId}-`) && ref.endsWith(`-${assistantKey}`),
    );

    expect(userRefs.length).toBeGreaterThanOrEqual(1);
    expect(assistantRefs.length).toBeGreaterThanOrEqual(1);
    expect(commands.has("undo")).toBe(true);
    expect(commands.has("redo")).toBe(true);
    expect(commands.has("checkpoint-list")).toBe(true);
    expect(commands.has("clear-checkpoint")).toBe(true);

    const assistantOnToolResult = refs.some(
      (ref) => ref.includes(`checkpoint-assistant-${sessionId}-`) && ref.endsWith(`-${sanitizeForRef(toolResultId)}`),
    );
    expect(assistantOnToolResult).toBe(false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("rewind: /undo and /redo restore file state across two checkpoints", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "rewind-bun-test-history-"));
  const repoDir = join(tempRoot, "repo");
  mkdirSync(repoDir, { recursive: true });

  try {
    run("git", ["init"], repoDir);
    run("git", ["config", "user.name", "Rewind Test"], repoDir);
    run("git", ["config", "user.email", "rewind-test@example.com"], repoDir);

    const filePath = join(repoDir, "demo.txt");
    writeFileSync(filePath, "base\n", "utf8");
    run("git", ["add", "demo.txt"], repoDir);
    run("git", ["commit", "-m", "initial"], repoDir);

    const handlers = new Map();
    const commands = new Map();
    const labels = new Map();

    const piApi = {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
      setLabel(entryId, label) {
        labels.set(entryId, label);
      },
      async exec(cmd, args) {
        const result = run(cmd, args, repoDir);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.status ?? 0,
        };
      },
    };

    rewindExtension(piApi);

    const sessionId = "22222222-2222-4222-8222-222222222222";

    const entries = [];
    const byId = new Map();
    let leafId = null;

    function addEntry(entry) {
      entries.push(entry);
      byId.set(entry.id, entry);
      leafId = entry.id;
    }

    const sessionManager = {
      getSessionId: () => sessionId,
      getEntries: () => [...entries],
      getLeafId: () => leafId,
      getEntry: (id) => byId.get(id),
      getLabel: (id) => labels.get(id),
      getBranch: (fromId) => {
        const startId = fromId ?? leafId;
        if (!startId) return [];

        const reversed = [];
        let cursor = byId.get(startId);
        while (cursor) {
          reversed.push(cursor);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
        return reversed.reverse();
      },
    };

    const ctx = {
      hasUI: true,
      ui: {
        theme: { fg: (_token, value) => value },
        setStatus: () => {},
        notify: () => {},
        select: async () => {
          throw new Error("UI select was not expected in this test");
        },
      },
      sessionManager,
      cwd: repoDir,
      navigateTree: async () => ({ cancelled: false }),
    };

    async function emit(eventType, event, context) {
      const list = handlers.get(eventType) ?? [];
      for (const handler of list) {
        await handler(event, context);
      }
    }

    await emit("session_start", { type: "session_start" }, ctx);

    addEntry({
      id: "u1",
      parentId: null,
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "do one" }] },
    });
    await emit("message_start", { type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } }, ctx);
    writeFileSync(filePath, "base\none\n", "utf8");
    addEntry({
      id: "a1",
      parentId: "u1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done one" }] },
    });
    addEntry({
      id: "t1",
      parentId: "a1",
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: "edited" }] },
    });
    await emit(
      "turn_end",
      { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [], timestamp: Date.now() }, toolResults: [] },
      ctx,
    );

    addEntry({
      id: "u2",
      parentId: "t1",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "do two" }] },
    });
    await emit("message_start", { type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } }, ctx);
    writeFileSync(filePath, "base\none\ntwo\n", "utf8");
    addEntry({
      id: "a2",
      parentId: "u2",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done two" }] },
    });
    addEntry({
      id: "t2",
      parentId: "a2",
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: "edited" }] },
    });
    await emit(
      "turn_end",
      { type: "turn_end", turnIndex: 1, message: { role: "assistant", content: [], timestamp: Date.now() }, toolResults: [] },
      ctx,
    );

    expect(readFileSync(filePath, "utf8")).toContain("two\n");

    const undo = commands.get("undo");
    const redo = commands.get("redo");
    expect(Boolean(undo)).toBe(true);
    expect(Boolean(redo)).toBe(true);

    await undo.handler("", ctx);
    const afterUndo = readFileSync(filePath, "utf8");
    expect(afterUndo).toContain("one\n");
    expect(afterUndo).not.toContain("two\n");

    await redo.handler("", ctx);
    const afterRedo = readFileSync(filePath, "utf8");
    expect(afterRedo).toContain("one\n");
    expect(afterRedo).toContain("two\n");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("rewind: assistant checkpoint maps to current assistant even when persistence lags", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "rewind-bun-test-race-"));
  const repoDir = join(tempRoot, "repo");
  mkdirSync(repoDir, { recursive: true });

  try {
    run("git", ["init"], repoDir);
    run("git", ["config", "user.name", "Rewind Test"], repoDir);
    run("git", ["config", "user.email", "rewind-test@example.com"], repoDir);

    const filePath = join(repoDir, "demo.txt");
    writeFileSync(filePath, "base\n", "utf8");
    run("git", ["add", "demo.txt"], repoDir);
    run("git", ["commit", "-m", "initial"], repoDir);

    const handlers = new Map();
    const commands = new Map();
    const labels = new Map();

    const piApi = {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
      setLabel(entryId, label) {
        labels.set(entryId, label);
      },
      async exec(cmd, args) {
        const result = run(cmd, args, repoDir);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.status ?? 0,
        };
      },
    };

    rewindExtension(piApi);

    const sessionId = "33333333-3333-4333-8333-333333333333";
    const entries = [];
    const byId = new Map();
    let leafId = null;

    function addEntry(entry) {
      entries.push(entry);
      byId.set(entry.id, entry);
      leafId = entry.id;
    }

    const sessionManager = {
      getSessionId: () => sessionId,
      getEntries: () => [...entries],
      getLeafId: () => leafId,
      getEntry: (id) => byId.get(id),
      getLabel: (id) => labels.get(id),
      getBranch: (fromId) => {
        const startId = fromId ?? leafId;
        if (!startId) return [];

        const reversed = [];
        let cursor = byId.get(startId);
        while (cursor) {
          reversed.push(cursor);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
        return reversed.reverse();
      },
    };

    const ctx = {
      hasUI: true,
      ui: {
        theme: { fg: (_token, value) => value },
        setStatus: () => {},
        notify: () => {},
        select: async () => {
          throw new Error("UI select was not expected in this test");
        },
      },
      sessionManager,
      cwd: repoDir,
      navigateTree: async () => ({ cancelled: false }),
    };

    async function emit(eventType, event, context) {
      const list = handlers.get(eventType) ?? [];
      for (const handler of list) {
        await handler(event, context);
      }
    }

    await emit("session_start", { type: "session_start" }, ctx);

    // Turn 1 (normal) to create older assistant checkpoint (a1)
    const tsA1 = Date.now();
    addEntry({ id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "one" }] } });
    await emit("message_start", { type: "message_start", message: { role: "assistant", content: [], timestamp: tsA1 } }, ctx);
    writeFileSync(filePath, "base\none\n", "utf8");
    addEntry({ id: "a1", parentId: "u1", type: "message", message: { role: "assistant", timestamp: tsA1, content: [{ type: "text", text: "done one" }] } });
    addEntry({ id: "t1", parentId: "a1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "edited" }] } });
    await emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", timestamp: tsA1, content: [] }, toolResults: [] }, ctx);

    // Turn 2 with delayed assistant entry persistence
    const tsA2 = Date.now() + 1;
    addEntry({ id: "u2", parentId: "t1", type: "message", message: { role: "user", content: [{ type: "text", text: "two" }] } });
    await emit("message_start", { type: "message_start", message: { role: "assistant", content: [], timestamp: tsA2 } }, ctx);
    writeFileSync(filePath, "base\none\ntwo\n", "utf8");

    setTimeout(() => {
      addEntry({ id: "a2", parentId: "u2", type: "message", message: { role: "assistant", timestamp: tsA2, content: [{ type: "text", text: "done two" }] } });
      addEntry({ id: "t2", parentId: "a2", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "edited" }] } });
    }, 35);

    await emit("turn_end", { type: "turn_end", turnIndex: 1, message: { role: "assistant", timestamp: tsA2, content: [] }, toolResults: [] }, ctx);

    const refs = run("git", ["for-each-ref", "--format=%(refname)", "refs/pi-checkpoints/"], repoDir)
      .stdout
      .split("\n")
      .filter(Boolean);

    const a1Key = sanitizeForRef("a1");
    const a2Key = sanitizeForRef("a2");

    const assistantRefs = refs.filter((ref) => ref.includes(`/checkpoint-assistant-${sessionId}-`));
    expect(assistantRefs.length).toBeGreaterThanOrEqual(1);

    const hasAssistantForA2 = assistantRefs.some((ref) => ref.endsWith(`-${a2Key}`));
    const hasAssistantForA1 = assistantRefs.some((ref) => ref.endsWith(`-${a1Key}`));
    expect(hasAssistantForA2).toBe(true);
    expect(hasAssistantForA1).toBe(false);

    expect(Boolean(commands.get("undo"))).toBe(true);
    expect(Boolean(commands.get("redo"))).toBe(true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
