/*
 * Obsidian Push plugin
 * Pushes and pulls Markdown notes between your vault and an external (or internal) target directory
 * Supports optional folder replication, content transformations, batch operations, and direct overwrite
 * Includes commands for both exporting (push) and importing (pull) notes—single or multiple selection
 * Desktop-only: relies on Node.js fs/path APIs for file system access
 */

import {
	App,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TextComponent,
	ToggleComponent,
} from "obsidian";
import * as path from "path";
import * as fs from "fs";
import {
	pushSingleFile,
	pushMultiple,
	TransformOptions,
	PushContext,
	PushError,
} from "./src/push";

/*---Settings model---*/

/* Plugin settings interface */
interface PushPluginSettings {
	targetDir: string;
	replicateFolders: boolean;
	overwriteExisting: boolean;
	notifyOnSuccess: boolean;
	sanitizeFrontmatter: boolean;
	addTimestampHeader: boolean;
	timestampFormat: string;
	forceExtension: string;
	successNoticeMessage?: string;
}

const DEFAULT_SETTINGS: PushPluginSettings = {
	targetDir: "",
	replicateFolders: true,
	overwriteExisting: true,
	notifyOnSuccess: true,
	sanitizeFrontmatter: false,
	addTimestampHeader: false,
	timestampFormat: "YYYY-MM-DD HH:mm",
	forceExtension: "",
	successNoticeMessage: "Note pushed to www.juanchiparra.com",
};

/*---Plugin core---*/

/* Main plugin class: loads settings and registers commands */
export default class ObsidianPushPlugin extends Plugin {
	settings: PushPluginSettings;

	async onload() {
		await this.loadSettings();

		// Push commands
		this.addCommand({
			id: "push-current-note",
			name: "Push current note to target directory",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				const file = view.file;
				if (!file) return false;
				if (!this.settings.targetDir) return false;
				if (!checking)
					this.pushFile(file).catch((e) => this.handlePushError(e));
				return true;
			},
		});

		this.addCommand({
			id: "push-modified-today",
			name: "Push notes modified today",
			callback: async () => {
				if (!this.ensureTargetConfigured()) return;
				const files = this.gatherModifiedToday();
				if (!files.length) return new Notice("No notes modified today");
				const res = await this.pushFiles(files);
				new Notice(`Pushed ${res.successes} / ${res.total} notes`);
			},
		});

		this.addCommand({
			id: "push-selected-files",
			name: "Push selected files in explorer",
			callback: async () => {
				if (!this.ensureTargetConfigured()) return;
				const selected = this.getExplorerSelection();
				if (!selected.length)
					return new Notice("No selection in explorer");
				const res = await this.pushFiles(selected);
				new Notice(`Pushed ${res.successes} / ${res.total} selected`);
			},
		});

		// Pull commands
		this.addCommand({
			id: "pull-current-note",
			name: "Pull current note from target directory",
			checkCallback: (checking: boolean) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				const file = view.file;
				if (!file) return false;
				if (!this.settings.targetDir) return false;
				if (!checking)
					this.pullFile(file).catch((e) => this.handlePullError(e));
				return true;
			},
		});

		this.addCommand({
			id: "pull-selected-files",
			name: "Pull selected files from target directory",
			callback: async () => {
				if (!this.ensureTargetConfigured()) return;
				const selected = this.getExplorerSelection();
				if (!selected.length)
					return new Notice("No selection in explorer");
				let pulled = 0;
				for (const f of selected) {
					try {
						await this.pullFile(f);
						pulled++;
					} catch (e) {
						this.handlePullError(e);
					}
				}
				new Notice(`Pulled ${pulled} / ${selected.length}`);
			},
		});

		this.addSettingTab(new PushSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Resolve target base directory; if relative, make it absolute using vault base path

	private resolveTargetBase(): string | null {
		let base = this.settings.targetDir.trim();
		if (!base) return null;
		if (!path.isAbsolute(base)) {
			const adapter = this.getAdapter();
			const vaultPath = adapter?.getBasePath?.();
			if (vaultPath) base = path.resolve(vaultPath, base);
		}
		return base;
	}

	// Safely obtain underlying filesystem adapter (desktop only)

	private getAdapter(): FileSystemAdapterLike | null {
		const raw: unknown = (
			this.app.vault as unknown as { adapter?: unknown }
		).adapter;
		if (
			raw &&
			typeof (raw as FileSystemAdapterLike).getBasePath === "function"
		)
			return raw as FileSystemAdapterLike;
		return null;
	}

	// Push a single file honoring current settings

	private async pushFile(file: TFile): Promise<void> {
		const ctx = this.buildPushContext();
		if (!ctx) {
			new Notice("Push: targetDir not configured");
			return;
		}
		const tr = this.buildTransformOptions();
		try {
			const r = await pushSingleFile(this.app.vault, file, ctx, tr);
			if (this.settings.notifyOnSuccess)
				new Notice(this.renderSuccessMessage(r.finalPath));
		} catch (e) {
			this.handlePushError(e);
		}
	}

	private async pushFiles(
		files: TFile[]
	): Promise<{ total: number; successes: number; failures: number }> {
		const ctx = this.buildPushContext();
		if (!ctx) return { total: files.length, successes: 0, failures: 0 };
		const tr = this.buildTransformOptions();
		const batch = await pushMultiple(this.app.vault, files, ctx, tr);
		if (batch.failures.length)
			console.warn("Push failures:", batch.failures);
		return {
			total: files.length,
			successes: batch.successes.length,
			failures: batch.failures.length,
		};
	}

	private ensureTargetConfigured(): boolean {
		if (!this.settings.targetDir) {
			new Notice("Configure targetDir first");
			return false;
		}
		return true;
	}

	private gatherModifiedToday(): TFile[] {
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.stat.mtime >= start.getTime());
	}

	private renderSuccessMessage(finalPath: string): string {
		const tpl = this.settings.successNoticeMessage || "Note pushed";
		return tpl.replace("{path}", finalPath);
	}

	private buildTransformOptions(): TransformOptions {
		return {
			sanitizeFrontmatter: this.settings.sanitizeFrontmatter,
			addTimestampHeader: this.settings.addTimestampHeader,
			timestampFormat: this.settings.timestampFormat,
			forceExtension: this.settings.forceExtension || undefined,
		};
	}

	private buildPushContext(): PushContext | null {
		const targetBase = this.resolveTargetBase();
		if (!targetBase) return null;
		return {
			replicateFolders: this.settings.replicateFolders,
			overwriteExisting: this.settings.overwriteExisting,
			targetBase,
		};
	}

	// Pull logic

	private computeTargetFilePath(
		file: TFile,
		ctx: PushContext,
		tr: TransformOptions
	): string {
		let relative = file.path;
		if (!ctx.replicateFolders) relative = path.basename(relative);
		if (tr.forceExtension) {
			const baseNoExt = relative.replace(/\.[^.]+$/, "");
			relative = baseNoExt + tr.forceExtension;
		}
		return path.join(ctx.targetBase, relative);
	}

	private async pullFile(file: TFile): Promise<void> {
		const ctx = this.buildPushContext();
		if (!ctx) {
			new Notice("Pull: targetDir not configured");
			return;
		}
		const tr = this.buildTransformOptions();
		const targetPath = this.computeTargetFilePath(file, ctx, tr);
		try {
			if (!fs.existsSync(targetPath)) {
				if (tr.forceExtension) {
					const originalPath = path.join(
						ctx.targetBase,
						ctx.replicateFolders
							? file.path
							: path.basename(file.path)
					);
					if (fs.existsSync(originalPath)) {
						await this.applyPulledContent(
							file,
							await fs.promises.readFile(originalPath, "utf8")
						);
						new Notice("Pulled (fallback extension)");
						return;
					}
				}
				new Notice("Target file not found for pull");
				return;
			}
			const content = await fs.promises.readFile(targetPath, "utf8");
			await this.applyPulledContent(file, content);
			new Notice("Note pulled");
		} catch (err) {
			this.handlePullError(err);
		}
	}

	private async applyPulledContent(file: TFile, content: string) {
		await this.app.vault.modify(file, content);
	}

	private handlePullError(err: unknown) {
		console.error("Pull error", err);
		let msg = "Pull failed";
		if (err instanceof Error) msg = err.message;
		new Notice(msg, 8000);
	}

	private handlePushError(err: unknown) {
		console.error("Push error", err);
		let msg = "Push failed";
		if (err instanceof PushError) msg = err.message;
		else if (err instanceof Error) msg = err.message;
		new Notice(msg, 8000);
	}

	private getExplorerSelection(): TFile[] {
		const out: TFile[] = [];
		const root = document.querySelector(".nav-files-container, .nav-files");
		if (!root) return out;
		const selected = root.querySelectorAll(".is-selected");
		selected.forEach((el) => {
			const pathAttr =
				(el as HTMLElement).getAttr?.("data-path") ||
				(el as HTMLElement).dataset?.path;
			if (pathAttr) {
				const f = this.app.vault.getAbstractFileByPath(pathAttr);
				if (f instanceof TFile) out.push(f);
			}
		});
		return out;
	}
}

interface FileSystemAdapterLike {
	getBasePath?: () => string;
}

/*---Settings tab UI---*/

/* Settings tab implementation */

class PushSettingTab extends PluginSettingTab {
	plugin: ObsidianPushPlugin;
	constructor(app: App, plugin: ObsidianPushPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Obsidian Push settings" });

		new Setting(containerEl)
			.setName("Target directory")
			.setDesc(
				"Destination directory for exported notes (absolute or relative to vault root)."
			)
			.addText((text: TextComponent) =>
				text
					.setPlaceholder(
						"E.g.: ../exported-notes or C:/Users/User/Documents/export"
					)
					.setValue(this.plugin.settings.targetDir)
					.onChange(async (value: string) => {
						this.plugin.settings.targetDir = value.trim();
						const adapter = (
							this.plugin as unknown as {
								getAdapter?: () => FileSystemAdapterLike | null;
							}
						).getAdapter?.();
						const base = adapter?.getBasePath?.();
						if (base && this.plugin.settings.targetDir) {
							const resolved = path.isAbsolute(
								this.plugin.settings.targetDir
							)
								? this.plugin.settings.targetDir
								: path.resolve(
										base,
										this.plugin.settings.targetDir
								  );
							if (resolved.startsWith(base)) {
								// If inside vault, warn only if within .obsidian
								if (
									resolved.startsWith(
										path.join(base, ".obsidian")
									)
								) {
									new Notice(
										"Warning: destination inside .obsidian may cause loops."
									);
								}
							}
						}
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Replicate folder structure")
			.setDesc(
				"Preserve original subfolder hierarchy in destination directory."
			)
			.addToggle((t: ToggleComponent) =>
				t
					.setValue(this.plugin.settings.replicateFolders)
					.onChange(async (v: boolean) => {
						this.plugin.settings.replicateFolders = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Overwrite if exists")
			.setDesc(
				"If disabled, an incremental suffix will be added to avoid conflicts."
			)
			.addToggle((t: ToggleComponent) =>
				t
					.setValue(this.plugin.settings.overwriteExisting)
					.onChange(async (v: boolean) => {
						this.plugin.settings.overwriteExisting = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Success notification")
			.setDesc("Show a notice when a note is successfully pushed.")
			.addToggle((t: ToggleComponent) =>
				t
					.setValue(this.plugin.settings.notifyOnSuccess)
					.onChange(async (v: boolean) => {
						this.plugin.settings.notifyOnSuccess = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Success message template")
			.setDesc(
				'Use {path} to inject the final path (e.g. "Note exported: {path}")'
			)
			.addText((t) =>
				t
					.setPlaceholder("Note pushed to www.juanchiparra.com")
					.setValue(this.plugin.settings.successNoticeMessage || "")
					.onChange(async (val) => {
						this.plugin.settings.successNoticeMessage = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Remove frontmatter")
			.setDesc("Strip leading YAML frontmatter if present.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.sanitizeFrontmatter)
					.onChange(async (v) => {
						this.plugin.settings.sanitizeFrontmatter = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Add timestamp header")
			.setDesc(
				"Insert an HTML comment with push date/time at the top of the file."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.addTimestampHeader)
					.onChange(async (v) => {
						this.plugin.settings.addTimestampHeader = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Timestamp format")
			.setDesc("Supported tokens: YYYY MM DD HH mm ss")
			.addText((t) =>
				t
					.setPlaceholder("YYYY-MM-DD HH:mm")
					.setValue(this.plugin.settings.timestampFormat)
					.onChange(async (val) => {
						this.plugin.settings.timestampFormat =
							val || "YYYY-MM-DD HH:mm";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Force extension")
			.setDesc(
				"Example: .md / .txt. Leave empty to keep original extension."
			)
			.addText((t) =>
				t
					.setPlaceholder(".md / .txt")
					.setValue(this.plugin.settings.forceExtension)
					.onChange(async (val) => {
						this.plugin.settings.forceExtension = val.trim();
						await this.plugin.saveSettings();
					})
			);
	}
}
