/**
 * Read tool override: attempt REAL sixel image rendering directly in chat tool output.
 *
 * This is an extension-only hack for terminals that support sixel (e.g. Windows Terminal in WSL).
 *
 * Env:
 * - PI_CHAFA_CHAT=1|0            Render sixel directly inside read result (default: 1)
 * - PI_CHAFA_CHAT_SIZE=WxH       Sixel size for chat rendering (default: x20)
 * - PI_CHAFA_CHAT_TOP_PAD=N      Blank lines between read text and image (default: 2)
 * - PI_CHAFA_CHAT_RESERVE_ROWS=N Extra blank rows reserved after sixel line (default: 0)
 * - PI_CHAFA_CHAT_CURSOR_UP=N   Cursor-up compensation after sixel (default: 1)
 * - PI_CHAFA_CHAT_BG=COLOR      Background color for sixel compositing (default: #142218)
 * - PI_CHAFA_INLINE=1|0          Also prepend ASCII preview text (default: 0)
 * - PI_CHAFA_INLINE_SIZE=WxH     ASCII preview size (default: 100x12)
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ReadToolDetails,
	ReadToolInput,
	ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { createReadTool } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@mariozechner/pi-tui";

const DEFAULT_CHAT_SIZE = "x20";
const DEFAULT_CHAT_TOP_PAD = 2;
const DEFAULT_CHAT_RESERVE_ROWS = 0;
const DEFAULT_CHAT_CURSOR_UP = 1;
const DEFAULT_CHAT_BG = "#142218";
const DEFAULT_INLINE = false;
const DEFAULT_INLINE_SIZE = "100x12";

type ReadDetailsExtended = ReadToolDetails & {
	chafaChat?: {
		sequence: string;
		rows: number;
		size: string;
		path: string;
	};
};

function envBool(name: string, defaultValue: boolean): boolean {
	const value = process.env[name];
	if (value === undefined) return defaultValue;
	return value !== "0" && value.toLowerCase() !== "false";
}

function normalizePath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function hasImageContent(result: AgentToolResult<ReadToolDetails>): boolean {
	return result.content.some((part) => part.type === "image");
}

function firstTextBlock(result: AgentToolResult<ReadToolDetails>) {
	return result.content.find((part) => part.type === "text" && "text" in part);
}

function appendInfo(result: AgentToolResult<ReadToolDetails>, line: string): void {
	const firstText = firstTextBlock(result);
	if (firstText && "text" in firstText) {
		firstText.text = `${firstText.text}\n\n[${line}]`;
		return;
	}
	result.content.unshift({ type: "text", text: `[${line}]` });
}

function parseRowsFromSize(size: string): number {
	const match = size.match(/^(?:(\d+)?)x(?:(\d+)?)$/i);
	if (!match) return 30;
	const rowsRaw = match[2];
	if (!rowsRaw) return 30;
	const rows = Number.parseInt(rowsRaw, 10);
	return Number.isFinite(rows) && rows > 0 ? rows : 30;
}

function buildSixelForChat(absPath: string): { sequence?: string; rows?: number; size?: string; error?: string } {
	if (!existsSync(absPath)) {
		return { error: `Image path not found: ${absPath}` };
	}

	const size = process.env.PI_CHAFA_CHAT_SIZE || DEFAULT_CHAT_SIZE;
	const bg = process.env.PI_CHAFA_CHAT_BG || DEFAULT_CHAT_BG;
	const args = [
		"--format=sixels",
		"--size",
		size,
		"--align=top,left",
		"--relative=off",
		"--optimize=0",
		"--bg",
		bg,
		absPath,
	];

	const result = spawnSync("chafa", args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
		encoding: "utf-8",
	});

	if (result.error) return { error: `chafa sixel failed: ${result.error.message}` };
	if ((result.status ?? 1) !== 0) {
		const err = (result.stderr || "").trim();
		return { error: `chafa sixel exited ${result.status ?? 1}${err ? `: ${err}` : ""}` };
	}

	let sequence = result.stdout || "";
	if (!sequence) return { error: "chafa sixel returned empty output" };

	// Remove cursor hide/show controls from chafa output to avoid cursor glitches in TUI.
	sequence = sequence.replace(/\x1b\[\?25[hl]/g, "");

	return { sequence, rows: parseRowsFromSize(size), size };
}

function buildInlineAscii(absPath: string): { preview?: string; error?: string } {
	if (!existsSync(absPath)) return { error: `Image path not found: ${absPath}` };
	const size = process.env.PI_CHAFA_INLINE_SIZE || DEFAULT_INLINE_SIZE;
	const args = [
		"--format=symbols",
		"--colors=none",
		"--symbols",
		"ascii",
		"--animate=off",
		"--size",
		size,
		"--align=top,left",
		absPath,
	];
	const result = spawnSync("chafa", args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
		encoding: "utf-8",
	});
	if (result.error) return { error: `inline chafa failed: ${result.error.message}` };
	if ((result.status ?? 1) !== 0) return { error: `inline chafa exited ${result.status ?? 1}` };
	const preview = (result.stdout || "").trimEnd();
	if (!preview) return { error: "inline chafa returned empty output" };
	return { preview };
}

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (!raw) return defaultValue;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) return defaultValue;
	return n;
}

function buildSixelComponent(sequence: string, reserveRows: number, cursorUpRows: number): Component {
	// Prefix with a harmless OSC 1337 stub so pi-tui treats this line as an image line,
	// bypassing normal width checks for giant escape payloads.
	const marker = "\x1b]1337;File=inline=1:\x07";
	return {
		render: () => {
			// Reset styles before and after sequence so Box background doesn't tint/pad image area.
			// Cursor-up trims trailing blank background row from boxed renderer.
			const up = cursorUpRows > 0 ? `\x1b[${cursorUpRows}A` : "";
			const lines = [`\x1b[0m${marker}${sequence}${up}\x1b[0m`];
			for (let i = 0; i < reserveRows; i++) lines.push("");
			return lines;
		},
		invalidate: () => {},
	};
}

function renderFallbackText(result: AgentToolResult<any>, options: ToolRenderResultOptions, theme: any): Text {
	const textOutput = result.content
		.filter((part) => part.type === "text" && "text" in part)
		.map((part) => part.text)
		.join("\n");
	const lines = textOutput.split("\n");
	const max = options.expanded ? lines.length : 18;
	const shown = lines.slice(0, max).join("\n");
	const remain = lines.length - max;
	const tail = remain > 0 ? `\n${theme.fg("muted", `... (${remain} more lines, Ctrl+E to expand)` )}` : "";
	return new Text(theme.fg("toolOutput", shown) + tail, 0, 0);
}

export default function readChafaSixelExtension(pi: ExtensionAPI) {
	const builtinRead = createReadTool(process.cwd());

	pi.registerTool({
		name: "read",
		label: "read",
		description: builtinRead.description,
		parameters: builtinRead.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const normalizedParams: ReadToolInput = {
				...params,
				path: normalizePath(params.path),
			};

			const absPath = resolve(ctx.cwd, normalizedParams.path);
			const result = (await builtinRead.execute(toolCallId, normalizedParams, signal, onUpdate)) as AgentToolResult<ReadDetailsExtended>;

			if (!hasImageContent(result)) {
				return result;
			}

			if (envBool("PI_CHAFA_INLINE", DEFAULT_INLINE)) {
				const inline = buildInlineAscii(absPath);
				if (inline.preview) {
					const first = firstTextBlock(result);
					const hdr = `[inline image preview: ${normalizedParams.path}]`;
					if (first && "text" in first) {
						first.text = `${hdr}\n${inline.preview}\n\n${first.text}`;
					}
				}
			}

			if (envBool("PI_CHAFA_CHAT", true)) {
				const sixel = buildSixelForChat(absPath);
				if (sixel.sequence && sixel.rows && sixel.size) {
					result.details = {
						...(result.details ?? {}),
						chafaChat: {
							sequence: sixel.sequence,
							rows: sixel.rows,
							size: sixel.size,
							path: normalizedParams.path,
						},
					};
				} else if (sixel.error) {
					appendInfo(result, sixel.error);
				}
			}

			return result;
		},

		renderCall(args, theme) {
			const path = args.path || "";
			const offset = args.offset;
			const limit = args.limit;
			let display = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path)}`;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				display += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return new Text(display, 0, 0);
		},

		renderResult(result, options, theme) {
			if (options.isPartial) {
				return new Text(theme.fg("warning", "Reading..."), 0, 0);
			}

			const details = (result.details ?? {}) as ReadDetailsExtended;
			const root = new Container();
			root.addChild(renderFallbackText(result, options, theme));

			if (details.chafaChat?.sequence) {
				const topPad = envInt("PI_CHAFA_CHAT_TOP_PAD", DEFAULT_CHAT_TOP_PAD);
				for (let i = 0; i < topPad; i++) {
					root.addChild(new Spacer(1));
				}
				const reserveRows = envInt("PI_CHAFA_CHAT_RESERVE_ROWS", DEFAULT_CHAT_RESERVE_ROWS);
				const cursorUpRows = envInt("PI_CHAFA_CHAT_CURSOR_UP", DEFAULT_CHAT_CURSOR_UP);
				root.addChild(buildSixelComponent(details.chafaChat.sequence, reserveRows, cursorUpRows));
			}

			return root;
		},
	});
}
