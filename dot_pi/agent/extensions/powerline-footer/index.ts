import type { ExtensionAPI, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme } from "@mariozechner/pi-tui";

import type { ColorScheme, SegmentContext, StatusLinePreset, StatusLineSegmentId } from "./types.js";
import { getPreset, PRESETS } from "./presets.js";
import { getSeparator } from "./separators.js";
import { renderSegment } from "./segments.js";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch } from "./vcs-status.js";
import { getDefaultColors } from "./theme.js";

interface PowerlineConfig {
  preset: StatusLinePreset;
}

let config: PowerlineConfig = {
  preset: "default",
};

function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext,
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

function buildContentFromParts(
  parts: string[],
  presetDef: ReturnType<typeof getPreset>,
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(presetDef.separator);
  const sep = separatorDef.left;
  return ` ${parts.join(` ${sep} `)} `;
}

function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number,
): { topContent: string; secondaryContent: string } {
  const separatorDef = getSeparator(presetDef.separator);
  const sepWidth = visibleWidth(separatorDef.left) + 2;

  const primaryIds = [...presetDef.leftSegments, ...presetDef.rightSegments];
  const secondaryIds = presetDef.secondarySegments ?? [];
  const allSegmentIds = [...primaryIds, ...secondaryIds];

  const renderedSegments: { content: string; width: number }[] = [];
  for (const segId of allSegmentIds) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) renderedSegments.push({ content, width });
  }

  if (renderedSegments.length === 0) {
    return { topContent: "", secondaryContent: "" };
  }

  const baseOverhead = 2;
  let currentWidth = baseOverhead;
  const topSegments: string[] = [];
  const overflowSegments: { content: string; width: number }[] = [];
  let overflow = false;

  for (const seg of renderedSegments) {
    const neededWidth = seg.width + (topSegments.length > 0 ? sepWidth : 0);
    if (!overflow && currentWidth + neededWidth <= availableWidth) {
      topSegments.push(seg.content);
      currentWidth += neededWidth;
    } else {
      overflow = true;
      overflowSegments.push(seg);
    }
  }

  let secondaryWidth = baseOverhead;
  const secondarySegments: string[] = [];

  for (const seg of overflowSegments) {
    const neededWidth = seg.width + (secondarySegments.length > 0 ? sepWidth : 0);
    if (secondaryWidth + neededWidth <= availableWidth) {
      secondarySegments.push(seg.content);
      secondaryWidth += neededWidth;
    } else {
      break;
    }
  }

  return {
    topContent: buildContentFromParts(topSegments, presetDef),
    secondaryContent: buildContentFromParts(secondarySegments, presetDef),
  };
}

export default function powerlineFooter(pi: ExtensionAPI) {
  let enabled = true;
  let sessionStartTime = Date.now();
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let getThinkingLevelFn: (() => string) | null = null;
  let tuiRef: any = null;

  let lastLayoutWidth = 0;
  let lastLayoutResult: { topContent: string; secondaryContent: string } | null = null;
  let lastLayoutTimestamp = 0;

  pi.on("session_start", async (_event, ctx) => {
    sessionStartTime = Date.now();
    currentCtx = ctx;

    const ctxAny = ctx as any;
    if (typeof ctxAny.getThinkingLevel === "function") {
      getThinkingLevelFn = () => ctxAny.getThinkingLevel();
    }

    if (enabled && ctx.hasUI) {
      setupCustomEditor(ctx);
    }
  });

  const mightChangeGitBranch = (cmd: string): boolean => {
    const gitBranchPatterns = [
      /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
      /\bgit\s+stash\s+(pop|apply)/,
    ];
    return gitBranchPatterns.some((p) => p.test(cmd));
  };

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }

    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeGitBranch(cmd)) {
        invalidateGitStatus();
        invalidateGitBranch();
        setTimeout(() => tuiRef?.requestRender(), 100);
      }
    }
  });

  pi.on("user_bash", async (event, _ctx) => {
    if (mightChangeGitBranch(event.command)) {
      invalidateGitStatus();
      invalidateGitBranch();
      setTimeout(() => tuiRef?.requestRender(), 100);
      setTimeout(() => tuiRef?.requestRender(), 300);
      setTimeout(() => tuiRef?.requestRender(), 500);
    }
  });

  pi.registerCommand("powerline", {
    description: "Configure powerline status (toggle, preset)",
    handler: async (args, ctx) => {
      currentCtx = ctx;

      if (!args || !args.trim()) {
        enabled = !enabled;
        if (enabled) {
          setupCustomEditor(ctx);
          ctx.ui.notify("Powerline enabled", "info");
        } else {
          ctx.ui.setEditorComponent(undefined);
          ctx.ui.setFooter(undefined);
          ctx.ui.setWidget("powerline-secondary", undefined);
          ctx.ui.setWidget("powerline-status", undefined);
          footerDataRef = null;
          tuiRef = null;
          lastLayoutResult = null;
          ctx.ui.notify("Powerline disabled", "info");
        }
        return;
      }

      const sub = args.trim().toLowerCase();
      if (sub === "on") {
        enabled = true;
        setupCustomEditor(ctx);
        ctx.ui.notify("Powerline enabled", "info");
        return;
      }
      if (sub === "off") {
        enabled = false;
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.setFooter(undefined);
        ctx.ui.setWidget("powerline-secondary", undefined);
        ctx.ui.setWidget("powerline-status", undefined);
        lastLayoutResult = null;
        ctx.ui.notify("Powerline disabled", "info");
        return;
      }

      const preset = sub as StatusLinePreset;
      if (preset in PRESETS) {
        config.preset = preset;
        lastLayoutResult = null;
        if (enabled) setupCustomEditor(ctx);
        ctx.ui.notify(`Preset set to: ${preset}`, "info");
        return;
      }

      const presetList = Object.keys(PRESETS).join(", ");
      ctx.ui.notify(`Available presets: ${presetList}`, "info");
    },
  });

  function buildSegmentContext(ctx: any, theme: Theme): SegmentContext {
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let lastAssistant: any = undefined;
    let thinkingLevelFromSession = "off";

    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    for (const e of sessionEvents) {
      if (e.type === "thinking_level_change" && e.thinkingLevel) {
        thinkingLevelFromSession = e.thinkingLevel;
      }

      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          continue;
        }

        const usage = m.usage;
        if (!usage) continue;

        input += usage.input ?? 0;
        output += usage.output ?? 0;
        cacheRead += usage.cacheRead ?? 0;
        cacheWrite += usage.cacheWrite ?? 0;
        cost += usage.cost?.total ?? 0;
        lastAssistant = m;
      }
    }

    const contextTokens = lastAssistant?.usage
      ? (lastAssistant.usage.input ?? 0)
        + (lastAssistant.usage.output ?? 0)
        + (lastAssistant.usage.cacheRead ?? 0)
        + (lastAssistant.usage.cacheWrite ?? 0)
      : 0;

    const contextWindow = ctx.model?.contextWindow || 0;
    const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const git = getGitStatus(gitBranch);

    const usingSubscription = ctx.model
      ? (ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false)
      : false;

    return {
      model: ctx.model,
      thinkingLevel: thinkingLevelFromSession || getThinkingLevelFn?.() || "off",
      sessionId: ctx.sessionManager?.getSessionId?.(),
      sessionName: ctx.sessionManager?.getSessionName?.(),
      usageStats: { input, output, cacheRead, cacheWrite, cost },
      contextPercent,
      contextWindow,
      autoCompactEnabled: ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      usingSubscription,
      sessionStartTime,
      git,
      extensionStatuses: footerDataRef?.getExtensionStatuses() ?? new Map(),
      options: presetDef.segmentOptions ?? {},
      theme,
      colors,
    };
  }

  function getResponsiveLayout(width: number, theme: Theme): { topContent: string; secondaryContent: string } {
    const now = Date.now();
    if (lastLayoutResult && lastLayoutWidth === width && now - lastLayoutTimestamp < 50) {
      return lastLayoutResult;
    }

    const presetDef = getPreset(config.preset);
    const segmentCtx = buildSegmentContext(currentCtx, theme);

    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, width);
    lastLayoutTimestamp = now;

    return lastLayoutResult;
  }

  function setupCustomEditor(ctx: any) {
    import("@mariozechner/pi-coding-agent").then(({ CustomEditor }) => {
      let currentEditor: any = null;
      let autocompleteFixed = false;

      const editorFactory = (tui: any, editorTheme: EditorTheme, keybindings: any) => {
        const editor = new CustomEditor(tui, editorTheme, keybindings);
        currentEditor = editor;

        const originalHandleInput = editor.handleInput.bind(editor);
        editor.handleInput = (data: string) => {
          if (!autocompleteFixed && !(editor as any).autocompleteProvider) {
            autocompleteFixed = true;
            ctx.ui.setEditorComponent(editorFactory);
            currentEditor?.handleInput(data);
            return;
          }
          originalHandleInput(data);
        };

        const originalRender = editor.render.bind(editor);
        editor.render = (width: number): string[] => {
          if (width < 10) {
            return originalRender(width);
          }

          const border = (s: string) => ctx.ui.theme.fg("borderAccent", s);
          const prompt = "\x1b[38;2;200;200;200m>\x1b[0m";

          const promptPrefix = ` ${prompt} `;
          const contPrefix = "   ";
          const contentWidth = Math.max(1, width - 5);
          const lines = originalRender(contentWidth);

          if (lines.length === 0 || !currentCtx) return lines;

          let bottomBorderIndex = lines.length - 1;
          for (let i = lines.length - 1; i >= 1; i--) {
            const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
            if (stripped.length > 0 && /^─{3,}/.test(stripped)) {
              bottomBorderIndex = i;
              break;
            }
          }

          const result: string[] = [];
          const layout = getResponsiveLayout(width, ctx.ui.theme);
          result.push(layout.topContent);

          const sessionNameRaw = currentCtx.sessionManager?.getSessionName?.();
          const sessionName = typeof sessionNameRaw === "string" ? sessionNameRaw.trim() : "";
          if (sessionName) {
            const sessionPrefix = " ↳ ";
            const maxSessionWidth = Math.max(1, width - 2);
            const maxNameWidth = Math.max(1, maxSessionWidth - visibleWidth(sessionPrefix));
            const sessionText =
              visibleWidth(sessionName) > maxNameWidth
                ? `${sessionName.slice(0, Math.max(0, maxNameWidth - 1))}…`
                : sessionName;
            result.push(ctx.ui.theme.fg("dim", `${sessionPrefix}${sessionText}`));
          }

          const makeBodyRow = (inner: string) => {
            const innerWidth = Math.max(1, width - 2);
            const clipped = truncateToWidth(inner, innerWidth, "");
            const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
            return border("│") + clipped + pad + border("│");
          };

          const userLabel = ` ${ctx.ui.theme.bold("User")} `;
          const topFill = Math.max(1, width - 2 - visibleWidth(userLabel));
          result.push(border("┌") + ctx.ui.theme.fg("accent", userLabel) + border("─".repeat(topFill) + "┐"));

          for (let i = 1; i < bottomBorderIndex; i++) {
            const prefix = i === 1 ? promptPrefix : contPrefix;
            result.push(makeBodyRow(`${prefix}${lines[i] || ""}`));
          }

          if (bottomBorderIndex === 1) {
            result.push(makeBodyRow(`${promptPrefix}${" ".repeat(contentWidth)}`));
          }

          result.push(border("└" + "─".repeat(Math.max(1, width - 2)) + "┘"));

          for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
            result.push(lines[i] || "");
          }

          return result;
        };

        return editor;
      };

      ctx.ui.setEditorComponent(editorFactory);

      ctx.ui.setFooter((tui: any, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
        footerDataRef = footerData;
        tuiRef = tui;
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose: unsub,
          invalidate() {},
          render(): string[] {
            return [];
          },
        };
      });

      ctx.ui.setWidget(
        "powerline-secondary",
        (_tui: any, theme: Theme) => ({
          dispose() {},
          invalidate() {},
          render(width: number): string[] {
            if (!currentCtx) return [];
            const layout = getResponsiveLayout(width, theme);
            return layout.secondaryContent ? [layout.secondaryContent] : [];
          },
        }),
        { placement: "belowEditor" },
      );

      ctx.ui.setWidget(
        "powerline-status",
        () => ({
          dispose() {},
          invalidate() {},
          render(width: number): string[] {
            if (!currentCtx || !footerDataRef) return [];

            const statuses = footerDataRef.getExtensionStatuses();
            if (!statuses || statuses.size === 0) return [];

            const notifications: string[] = [];
            for (const value of statuses.values()) {
              if (value && value.trimStart().startsWith("[")) {
                const lineContent = ` ${value}`;
                if (visibleWidth(lineContent) <= width) {
                  notifications.push(lineContent);
                }
              }
            }
            return notifications;
          },
        }),
        { placement: "aboveEditor" },
      );
    });
  }
}
