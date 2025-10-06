import * as fs from "fs";
import * as path from "path";
import { TFile, Vault } from "obsidian";

/* Transform options for file content before writing */

export interface TransformOptions {
	sanitizeFrontmatter: boolean; // Remove leading YAML frontmatter block
	addTimestampHeader: boolean; // Prepend timestamp HTML comment
	timestampFormat: string; //	Timestamp format tokens: YYYY, MM, DD, HH, mm, ss
	forceExtension?: string; // Force output file extension (with leading dot)
}

/* Runtime context controlling write strategy */

export interface PushContext {
	replicateFolders: boolean; // Preserve original vault folder hierarchy
	overwriteExisting: boolean; // Overwrite existing file directly; else find an incremental name
	targetBase: string; // Absolute target base directory
}

/* Successful push output metadata */

export interface PushResult {
	source: string; // Original vault-relative path
	finalPath: string; // Absolute final path written
	bytes: number; // Number of UTF-8 bytes written
	transformed: boolean; // Whether any transformation mutated the original content
}

/* Failure metadata for a single file in a batch */

export interface PushFailure {
	file: string;
	error: string;
	code?: string;
}

/* Custom error with optional Node.js fs error code */

export class PushError extends Error {
	code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

export function formatTimestamp(fmt: string, d = new Date()): string {
	const pad = (n: number, l = 2) => String(n).padStart(l, "0");
	return fmt
		.replace(/YYYY/g, String(d.getFullYear()))
		.replace(/MM/g, pad(d.getMonth() + 1))
		.replace(/DD/g, pad(d.getDate()))
		.replace(/HH/g, pad(d.getHours()))
		.replace(/mm/g, pad(d.getMinutes()))
		.replace(/ss/g, pad(d.getSeconds()));
}

// Matches a leading YAML frontmatter block lazily.
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

/* Applies transformations in a deterministic order */

export function transformContent(
	raw: string,
	opts: TransformOptions
): { content: string; transformed: boolean } {
	let content = raw;
	let transformed = false;
	if (opts.sanitizeFrontmatter && FRONTMATTER_RE.test(content)) {
		content = content.replace(FRONTMATTER_RE, "");
		transformed = true;
	}
	if (opts.addTimestampHeader) {
		const stamp = formatTimestamp(
			opts.timestampFormat || "YYYY-MM-DD HH:mm"
		);
		content = `<!-- Pushed: ${stamp} -->\n` + content;
		transformed = true;
	}
	return { content, transformed };
}

export async function pushSingleFile(
	vault: Vault,
	file: TFile,
	ctx: PushContext,
	tr: TransformOptions
): Promise<PushResult> {
	const raw = await vault.read(file);
	const { content, transformed } = transformContent(raw, tr);
	let relativePath = file.path;
	// Optionally flatten into root of target directory
	if (!ctx.replicateFolders) {
		relativePath = path.basename(relativePath);
	}
	// Force extension if requested
	if (tr.forceExtension) {
		const baseNoExt = relativePath.replace(/\.[^.]+$/, "");
		relativePath = baseNoExt + tr.forceExtension;
	}
	const destPath = path.join(ctx.targetBase, relativePath);
	const destDir = path.dirname(destPath);
	await fs.promises.mkdir(destDir, { recursive: true });
	let finalPath = destPath;
	// Collision handling (incremental suffix) when overwrite disabled
	if (!ctx.overwriteExisting && fs.existsSync(destPath)) {
		const ext = path.extname(destPath);
		const b = destPath.slice(0, destPath.length - ext.length);
		let i = 1;
		while (fs.existsSync(`${b}-${i}${ext}`)) i++;
		finalPath = `${b}-${i}${ext}`;
	}
	const tmp = finalPath + ".tmp";
	try {
		await fs.promises.writeFile(tmp, content, "utf8");
		await fs.promises.rename(tmp, finalPath);
	} catch (err: unknown) {
		if (fs.existsSync(tmp)) {
			try {
				await fs.promises.unlink(tmp);
			} catch {
				/* ignore cleanup failure */
			}
		}
		let code: string | undefined;
		if (err && typeof err === "object" && "code" in err) {
			code = (err as { code?: string }).code;
		}
		let msg = "Failed to write file";
		if (code === "EACCES" || code === "EPERM")
			msg = "Permission denied writing destination";
		else if (code === "ENOENT") msg = "Destination path not found";
		throw new PushError(`${msg}: ${finalPath}`, code);
	}
	return {
		source: file.path,
		finalPath,
		bytes: Buffer.byteLength(content, "utf8"),
		transformed,
	};
}

// Aggregated results of a multi-file push operation.

export interface PushBatchResult {
	successes: PushResult[];
	failures: PushFailure[];
}

export async function pushMultiple(
	vault: Vault,
	files: TFile[],
	ctx: PushContext,
	tr: TransformOptions
): Promise<PushBatchResult> {
	const successes: PushResult[] = [];
	const failures: PushFailure[] = [];
	for (const f of files) {
		try {
			const r = await pushSingleFile(vault, f, ctx, tr);
			successes.push(r);
		} catch (err: unknown) {
			let code: string | undefined;
			let msg = "Unknown error";
			if (err instanceof PushError) {
				code = err.code;
				msg = err.message;
			} else if (err instanceof Error) {
				msg = err.message;
			}
			failures.push({ file: f.path, error: msg, code });
			console.error("Push error", f.path, err);
		}
	}
	return { successes, failures };
}
