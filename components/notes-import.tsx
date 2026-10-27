"use client";

import { useRef, useState } from "react";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
}

/** Validate the entire response before applying any row: a malformed index
 * must never attribute another file's success to this file (same names included). */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Please retry the file.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== files[r.requestIndex]!.name) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Please retry the file."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}. Please retry the file.`);
	}
	return parseNotesImportResults(body, files);
}

/** Only error text survives a request; selected Files stay request-local. */
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const [errors, setErrors] = useState<string[]>([]);
	const [importing, setImporting] = useState(false);
	const pending = useRef(false);
	const submit = async (files: File[]) => {
		if (pending.current || files.length === 0) return;
		pending.current = true;
		setImporting(true);
		setErrors([]);
		try {
			callbacks.onStart?.();
			const results = await postNotesImport(files);
			setErrors(results
				.filter((result) => !result.ok)
				.sort((a, b) => a.requestIndex - b.requestIndex)
				.map((r) => `${r.filePath}: ${r.error}${r.code ? `\n${r.code}${r.provider ? ` — ${r.provider}` : ""}${r.missing?.length ? ` — ${r.missing.join(", ")}` : ""}${r.slots?.length ? ` — ${r.slots.join(", ")}` : ""}` : ""}`));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setErrors(files.map((file) => `${file.name}: ${message}`));
		} finally {
			pending.current = false;
			setImporting(false);
			callbacks.onFinish?.();
		}
	};
	return {
		errors, importing,
		onImportFiles: (files: FileList | null) => { if (files) void submit(Array.from(files)); },
	};
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => (
		<p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-red-400">{error}</p>
	))}</>;
}

// ─── the vault sync (POST /api/graph/vault-sync) ─────────────────────────────

/** Transport mirror of the server's VaultSyncSummary. */
export interface VaultSyncSummary {
	imported: string[];
	reextracted: string[];
	renamed: Array<{ from: string; to: string }>;
	unchanged: number;
	failed: Array<{ relPath: string; error: string; code?: string }>;
}

export function formatVaultSyncSummary(s: VaultSyncSummary): string {
	const parts = [
		s.imported.length > 0 ? `${s.imported.length} imported` : null,
		s.reextracted.length > 0 ? `${s.reextracted.length} re-extracted` : null,
		s.renamed.length > 0 ? `${s.renamed.length} renamed` : null,
		`${s.unchanged} unchanged`,
		s.failed.length > 0 ? `${s.failed.length} failed` : null,
	].filter((p): p is string => p !== null);
	return `Vault synced: ${parts.join(", ")}.`;
}

/** One sync at a time; the summary line and per-file errors survive until
 *  the next sync. */
export function useVaultSync(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const [syncing, setSyncing] = useState(false);
	const [summary, setSummary] = useState<string | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const pending = useRef(false);
	const sync = async () => {
		if (pending.current) return;
		pending.current = true;
		setSyncing(true);
		setSummary(null);
		setErrors([]);
		try {
			callbacks.onStart?.();
			const response = await fetch("/api/graph/vault-sync", { method: "POST" });
			const body = (await response.json().catch(() => null)) as (VaultSyncSummary & { error?: string }) | null;
			if (!response.ok || !body || !Array.isArray(body.failed)) {
				setErrors([`Vault sync: ${body?.error ?? `HTTP ${response.status}`}`]);
				return;
			}
			setSummary(formatVaultSyncSummary(body));
			setErrors(body.failed.map((f) => `${f.relPath}: ${f.error}${f.code ? `\n${f.code}` : ""}`));
		} catch (error) {
			setErrors([`Vault sync: ${error instanceof Error ? error.message : String(error)}`]);
		} finally {
			pending.current = false;
			setSyncing(false);
			callbacks.onFinish?.();
		}
	};
	return { syncing, summary, errors, sync: () => void sync() };
}
