/**
 * The vault sync — the IO half (core/vault-sync.ts is the pure half): list
 * <vault>/Concepts/*.md, hash each file, plan against the vault-sync
 * ledger, then run the plan. Manual only (POST /api/graph/vault-sync); one
 * sync at a time.
 *
 * Imports and re-extractions go through the SAME notes pipeline as an
 * explicit import (extraction.importNotes), with a stable source id and the
 * content version as the provenance anchor. A ledger line is appended only
 * after the import COMPLETED — a failed or partial run leaves the old
 * version current, so the next sync retries it. The skip-unchanged check
 * lives here, never in importNotes (2d67376: explicit imports always run).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { planVaultSync, VAULT_SYNC_FOLDER, type VaultFile } from "../core/vault-sync.ts";
import type { EmissionStats } from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { NotesImportError, type NotesImportInput } from "../agent/subagents/extraction.ts";

export interface VaultSyncFailure {
	relPath: string;
	error: string;
	/** Present when the run stopped on a setup refusal (models / keys). */
	code?: "models_not_configured" | "provider_key_missing";
}

export interface VaultSyncSummary {
	imported: string[];
	reextracted: string[];
	renamed: Array<{ from: string; to: string }>;
	unchanged: number;
	failed: VaultSyncFailure[];
}

export type VaultSyncOutcome =
	| { ok: true; summary: VaultSyncSummary }
	| { ok: false; status: 400 | 409; code: "vault_not_set" | "vault_not_found" | "busy"; error: string };

export interface VaultSyncDeps {
	graphStore: Pick<GraphStore, "readVaultSync" | "appendVaultSync" | "readSources" | "upsertSource">;
	importNotes: (input: NotesImportInput) => Promise<EmissionStats>;
	/** The configured vault path, read fresh per sync ("" = unset). */
	vaultPath: () => string;
	/** WSL detection seam (tests pin it). */
	isWsl?: () => boolean;
}

/** Concurrent imports — the import route's cap (provider rate limits). */
const SYNC_CONCURRENCY = 3;

function detectWsl(): boolean {
	if (process.platform !== "linux") return false;
	try {
		return /microsoft/i.test(fs.readFileSync("/proc/version", "utf-8"));
	} catch {
		return false;
	}
}

/** The path as this process can open it: a Windows path ("C:\\Users\\…")
 *  becomes /mnt/c/Users/… under WSL; anything else is used as given. */
export function resolveVaultPath(raw: string, isWsl: boolean): string {
	const trimmed = raw.trim();
	const drive = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed);
	if (drive && isWsl) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, "/")}`;
	return trimmed;
}

/** "src_" + 12 hex — path AND first content: a later new file at a renamed
 *  source's old path never collides with it. */
function newVaultSourceId(relPath: string, contentHash: string): string {
	return `src_${crypto.createHash("sha256").update(`vault\0${relPath}\0${contentHash}`).digest("hex").slice(0, 12)}`;
}

function listConceptNotes(vaultDir: string): Array<VaultFile & { text: string }> {
	const dir = path.join(vaultDir, VAULT_SYNC_FOLDER);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".md") && fs.statSync(path.join(dir, name)).isFile())
		.map((name) => {
			const text = fs.readFileSync(path.join(dir, name), "utf-8");
			return {
				relPath: `${VAULT_SYNC_FOLDER}/${name}`,
				contentHash: crypto.createHash("sha256").update(text).digest("hex"),
				text,
			};
		});
}

export function createVaultSync(deps: VaultSyncDeps): { sync(): Promise<VaultSyncOutcome> } {
	let running = false;

	async function syncOnce(vaultDir: string): Promise<VaultSyncSummary> {
		const files = listConceptNotes(vaultDir);
		const textOf = new Map(files.map((f) => [f.relPath, f.text]));
		const actions = planVaultSync(files, deps.graphStore.readVaultSync());
		const summary: VaultSyncSummary = { imported: [], reextracted: [], renamed: [], unchanged: 0, failed: [] };
		const now = () => new Date().toISOString();

		const jobs: Array<{ sourceId: string; relPath: string; contentHash: string; kind: "import" | "reextract" }> = [];
		for (const action of actions) {
			switch (action.kind) {
				case "unchanged":
					summary.unchanged++;
					break;
				case "rename": {
					const prev = deps.graphStore.readSources().find((s) => s.id === action.sourceId);
					deps.graphStore.upsertSource({ id: action.sourceId, filePath: action.relPath, importedAt: prev?.importedAt ?? now() });
					deps.graphStore.appendVaultSync({ sourceId: action.sourceId, relPath: action.relPath, contentHash: action.contentHash, syncedAt: now() });
					summary.renamed.push({ from: action.fromPath, to: action.relPath });
					break;
				}
				case "reextract":
					jobs.push({ ...action, kind: "reextract" });
					break;
				case "import":
					jobs.push({ ...action, sourceId: newVaultSourceId(action.relPath, action.contentHash), kind: "import" });
					break;
			}
		}

		// A setup refusal (no models / a missing key) fails every file the
		// same way — stop launching after the first one.
		let refused: VaultSyncFailure["code"] | undefined;
		const queue = [...jobs];
		const workers = Array.from({ length: Math.min(SYNC_CONCURRENCY, queue.length) }, async () => {
			for (;;) {
				if (refused) return;
				const job = queue.shift();
				if (!job) return;
				try {
					await deps.importNotes({ filePath: job.relPath, text: textOf.get(job.relPath)!, sourceId: job.sourceId, version: job.contentHash });
					deps.graphStore.appendVaultSync({ sourceId: job.sourceId, relPath: job.relPath, contentHash: job.contentHash, syncedAt: now() });
					(job.kind === "import" ? summary.imported : summary.reextracted).push(job.relPath);
				} catch (err) {
					const code =
						err instanceof ModelsNotConfiguredError
							? "models_not_configured"
							: err instanceof ProviderKeyMissingError
								? "provider_key_missing"
								: undefined;
					if (code) refused = code;
					summary.failed.push({
						relPath: job.relPath,
						error: err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError
							? err.envelope.error
							: err instanceof NotesImportError || err instanceof Error
								? err.message
								: String(err),
						...(code ? { code } : {}),
					});
				}
			}
		});
		await Promise.all(workers);
		for (const list of [summary.imported, summary.reextracted]) list.sort();
		summary.failed.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
		return summary;
	}

	return {
		async sync(): Promise<VaultSyncOutcome> {
			const raw = deps.vaultPath();
			if (raw.trim() === "") {
				return { ok: false, status: 400, code: "vault_not_set", error: "Set the vault folder in Settings → Graph first." };
			}
			const vaultDir = resolveVaultPath(raw, (deps.isWsl ?? detectWsl)());
			if (!fs.existsSync(path.join(vaultDir, VAULT_SYNC_FOLDER))) {
				return { ok: false, status: 400, code: "vault_not_found", error: `No ${VAULT_SYNC_FOLDER}/ folder in ${vaultDir}.` };
			}
			if (running) return { ok: false, status: 409, code: "busy", error: "A vault sync is already running." };
			running = true;
			try {
				return { ok: true, summary: await syncOnce(vaultDir) };
			} finally {
				running = false;
			}
		},
	};
}
