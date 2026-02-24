/**
 * Prompt Stash Extension
 *
 * Primary UX:
 * - Ctrl+S opens a centered dialog with:
 *   1) Stash this (current editor prompt)
 *   2) Show prompts list
 *
 * Prompt list supports:
 * - Pop to editor (remove from stash)
 * - Paste to editor (keep in stash)
 * - Delete item
 * - Clear all
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, type SelectItem, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface StashItem {
	id: number;
	text: string;
	createdAt: number;
}

interface StashSnapshot {
	action: "stash" | "pop" | "delete" | "clear";
	items: StashItem[];
	nextId: number;
}

const ENTRY_TYPE = "prompt-stash";
const PREVIEW_MAX = 90;

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function preview(text: string): string {
	const compact = oneLine(text);
	return compact.length <= PREVIEW_MAX ? compact : `${compact.slice(0, PREVIEW_MAX - 1)}…`;
}

function parseId(value: string): number | undefined {
	const id = Number.parseInt(value, 10);
	return Number.isFinite(id) ? id : undefined;
}

function isValidItem(value: unknown): value is StashItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<StashItem>;
	return typeof item.id === "number" && typeof item.text === "string" && typeof item.createdAt === "number";
}

class CenterMenuDialog {
	private selected = 0;
	private scroll = 0;
	private readonly maxVisibleRows = 8;

	constructor(
		private readonly theme: Theme,
		private readonly title: string,
		private readonly options: SelectItem[],
		private readonly footer: string,
		private readonly done: (result: SelectItem | undefined) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(undefined);
			return;
		}

		if (this.options.length === 0) {
			if (matchesKey(data, "return") || matchesKey(data, "enter")) {
				this.done(undefined);
			}
			return;
		}

		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.ensureVisible();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(this.options.length - 1, this.selected + 1);
			this.ensureVisible();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.selected = Math.max(0, this.selected - this.maxVisibleRows);
			this.ensureVisible();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.selected = Math.min(this.options.length - 1, this.selected + this.maxVisibleRows);
			this.ensureVisible();
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.done(this.options[this.selected]);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerWidth = Math.max(24, width - 2);
		const visibleRows = Math.min(this.maxVisibleRows, Math.max(1, this.options.length));

		const row = (content: string, selected = false): string => {
			const truncated = truncateToWidth(content, innerWidth);
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
			const bgToken = selected ? "selectedBg" : "toolPendingBg";
			const bg = th.bg(bgToken, `${truncated}${pad}`);
			return `${th.fg("borderAccent", "│")}${bg}${th.fg("borderAccent", "│")}`;
		};

		const lines: string[] = [];
		lines.push(th.fg("borderAccent", `╭${"─".repeat(innerWidth)}╮`));
		lines.push(row(` ${th.bold(th.fg("accent", this.title))}`));
		lines.push(row(""));

		if (this.options.length === 0) {
			lines.push(row(` ${th.fg("dim", "No options")}`));
		} else {
			this.ensureVisible();
			for (let i = 0; i < visibleRows; i++) {
				const index = this.scroll + i;
				const option = this.options[index];
				if (!option) {
					lines.push(row(""));
					continue;
				}

				const isSelected = index === this.selected;
				const prefix = isSelected ? th.fg("accent", "›") : th.fg("dim", " ");
				const label = isSelected ? th.fg("accent", option.label) : th.fg("text", option.label);
				const desc = option.description ? ` ${th.fg("muted", option.description)}` : "";
				lines.push(row(` ${prefix} ${label}${desc}`, isSelected));
			}
		}

		if (this.options.length > visibleRows) {
			lines.push(row(` ${th.fg("dim", `${this.selected + 1}/${this.options.length}`)}`));
		}

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", this.footer)}`));
		lines.push(th.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`));

		return lines;
	}

	invalidate(): void {}

	private ensureVisible(): void {
		const visibleRows = Math.min(this.maxVisibleRows, Math.max(1, this.options.length));
		if (this.selected < this.scroll) {
			this.scroll = this.selected;
		} else if (this.selected >= this.scroll + visibleRows) {
			this.scroll = this.selected - visibleRows + 1;
		}
		const maxScroll = Math.max(0, this.options.length - visibleRows);
		this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);
	}
}

export default function promptStashExtension(pi: ExtensionAPI) {
	let items: StashItem[] = [];
	let nextId = 1;

	function persist(action: StashSnapshot["action"]) {
		pi.appendEntry<StashSnapshot>(ENTRY_TYPE, {
			action,
			items: [...items],
			nextId,
		});
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		items = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as Partial<StashSnapshot> | undefined;
			if (!data) continue;

			if (Array.isArray(data.items)) {
				items = data.items.filter(isValidItem).map((item) => ({ ...item }));
			}

			if (typeof data.nextId === "number" && Number.isFinite(data.nextId) && data.nextId > 0) {
				nextId = Math.floor(data.nextId);
			} else {
				nextId = items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
			}
		}
	}

	function stashPrompt(rawText: string, ctx: ExtensionContext): boolean {
		const text = rawText.trim();
		if (!text) {
			ctx.ui.notify("Prompt is empty. Nothing stashed.", "warning");
			return false;
		}

		const item: StashItem = {
			id: nextId++,
			text,
			createdAt: Date.now(),
		};
		items.push(item);
		persist("stash");
		ctx.ui.notify(`Stashed #${item.id}: ${preview(item.text)}`, "info");
		return true;
	}

	function removeById(id: number): StashItem | undefined {
		const index = items.findIndex((item) => item.id === id);
		if (index < 0) return undefined;
		const [removed] = items.splice(index, 1);
		return removed;
	}

	function findById(id: number): StashItem | undefined {
		return items.find((item) => item.id === id);
	}

	function popToEditor(item: StashItem, ctx: ExtensionContext) {
		ctx.ui.setEditorText(item.text);
		removeById(item.id);
		persist("pop");
		ctx.ui.notify(`Popped #${item.id} into editor`, "info");
	}

	function deleteItem(item: StashItem, ctx: ExtensionContext) {
		removeById(item.id);
		persist("delete");
		ctx.ui.notify(`Deleted #${item.id} from stash`, "info");
	}

	async function modalSelect(
		ctx: ExtensionContext,
		title: string,
		options: SelectItem[],
		footer = "↑↓ navigate • enter select • esc cancel",
	): Promise<SelectItem | undefined> {
		if (!ctx.hasUI) return undefined;

		return ctx.ui.custom<SelectItem | undefined>(
			(tui, theme, _kb, done) => {
				const dialog = new CenterMenuDialog(theme, title, options, footer, done);
				return {
					render(width: number) {
						return dialog.render(width);
					},
					invalidate() {
						dialog.invalidate();
					},
					handleInput(data: string) {
						dialog.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: 72,
					maxHeight: 18,
					margin: 1,
				},
			},
		);
	}

	function stashCurrentEditorPrompt(ctx: ExtensionContext) {
		const draft = ctx.ui.getEditorText().trim();
		if (!draft || draft.startsWith("/")) {
			ctx.ui.notify("Editor has no prompt draft to stash", "warning");
			return;
		}
		const ok = stashPrompt(draft, ctx);
		if (ok) {
			ctx.ui.setEditorText("");
		}
	}

	async function openPromptListDialog(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Prompt stash list requires interactive mode", "error");
			return;
		}

		if (items.length === 0) {
			ctx.ui.notify("Prompt stash is empty", "info");
			return;
		}

		const sorted = [...items].sort((a, b) => b.id - a.id);
		const listOptions: SelectItem[] = sorted.map((item) => ({
			value: String(item.id),
			label: `#${item.id}`,
			description: preview(item.text),
		}));
		listOptions.push({ value: "__clear_all__", label: "Clear all stashed prompts" });

		const selected = await modalSelect(ctx, "Stashed Prompts", listOptions);
		if (!selected) return;

		if (selected.value === "__clear_all__") {
			const ok = await ctx.ui.confirm("Clear prompt stash", "Delete all stashed prompts?");
			if (!ok) return;
			items = [];
			nextId = 1;
			persist("clear");
			ctx.ui.notify("Cleared prompt stash", "info");
			return;
		}

		const id = parseId(selected.value);
		if (id === undefined) return;
		const item = findById(id);
		if (!item) {
			ctx.ui.notify(`Stash item #${id} no longer exists`, "warning");
			return;
		}

		const action = await modalSelect(ctx, `Prompt #${item.id}`, [
			{ value: "paste", label: "Paste to editor", description: "Keep in stash" },
			{ value: "pop", label: "Pop to editor", description: "Remove from stash" },
			{ value: "delete", label: "Delete", description: "Remove this stashed prompt" },
		]);
		if (!action) return;

		if (action.value === "pop") {
			popToEditor(item, ctx);
			return;
		}

		if (action.value === "paste") {
			ctx.ui.setEditorText(item.text);
			ctx.ui.notify(`Loaded #${item.id} into editor`, "info");
			return;
		}

		if (action.value === "delete") {
			deleteItem(item, ctx);
		}
	}

	async function openMainDialog(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Prompt stash requires interactive mode", "error");
			return;
		}

		const choice = await modalSelect(ctx, "Prompt Stash", [
			{ value: "stash-current", label: "Stash this", description: "Save current editor prompt" },
			{ value: "show-list", label: "Show prompts list", description: `Manage stashed prompts (${items.length})` },
		]);
		if (!choice) return;

		if (choice.value === "stash-current") {
			stashCurrentEditorPrompt(ctx);
			return;
		}

		if (choice.value === "show-list") {
			await openPromptListDialog(ctx);
		}
	}

	pi.registerCommand("stash-list", {
		description: "Open centered prompt stash dialog",
		handler: async (_args, ctx) => {
			await openMainDialog(ctx);
		},
	});

	pi.registerCommand("pop", {
		description: "Pop latest stashed prompt into editor, optionally by id: /pop [id]",
		getArgumentCompletions: (prefix) => {
			const choices = [...items]
				.sort((a, b) => b.id - a.id)
				.map((item) => ({ value: String(item.id), label: `${item.id}: ${preview(item.text)}` }));
			const filtered = choices.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/pop requires interactive mode", "error");
				return;
			}

			if (items.length === 0) {
				ctx.ui.notify("Prompt stash is empty", "info");
				return;
			}

			const raw = args.trim();
			let item: StashItem | undefined;

			if (!raw) {
				item = items[items.length - 1];
			} else {
				const id = Number.parseInt(raw, 10);
				if (Number.isNaN(id)) {
					ctx.ui.notify(`Invalid stash id: ${raw}`, "error");
					return;
				}
				item = findById(id);
			}

			if (!item) {
				ctx.ui.notify("Stashed prompt not found", "warning");
				return;
			}

			popToEditor(item, ctx);
		},
	});

	pi.registerShortcut("ctrl+s", {
		description: "Prompt stash dialog",
		handler: async (ctx) => {
			await openMainDialog(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
	pi.on("session_fork", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
