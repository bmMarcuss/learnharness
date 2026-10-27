/**
 * Vault sync — the pure half (no IO, no hashing): what one sync of the
 * vault's Concepts/ folder should do, and which graph items are STALE.
 *
 * The server (src/server/vault-sync.ts) lists the files, hashes them, and
 * hands this module the present files + the vault-sync ledger. Everything
 * here is derived from those two inputs — the ledger is the only state.
 *
 *   new path, unknown content           → import (fresh source id)
 *   known path, same content            → unchanged (no LLM call)
 *   known path, new content             → re-extract under the SAME id
 *   new path, content = the current version of a source whose file is
 *   gone                                → rename (path moves, no LLM call)
 *   a source's file disappeared         → nothing (its version stays current)
 *
 * Staleness: vault-synced provenance points carry their content version as
 * messageId. A proposition or chain is stale when EVERY point belongs to a
 * vault-synced source and NONE names that source's current version — a
 * chat, a manual notes import, or the current note keeps it fresh.
 */

import type { DerivedGraph } from "./graph.ts";
import type { ProvenancePoint, VaultSyncEntry } from "./contracts.ts";

/** The one vault folder a sync reads (owner decision: fixed, not a setting). */
export const VAULT_SYNC_FOLDER = "Concepts";

/** One vault note as the server found it. */
export interface VaultFile {
	/** Vault-relative, forward slashes ("Concepts/Foo.md"). */
	relPath: string;
	contentHash: string;
}

/** A source's current version — its latest ledger line. */
export interface VaultVersion {
	relPath: string;
	contentHash: string;
}

/** sourceId → current version (latest line wins — append order). */
export function currentVaultVersions(entries: readonly VaultSyncEntry[]): Map<string, VaultVersion> {
	const out = new Map<string, VaultVersion>();
	for (const entry of entries) out.set(entry.sourceId, { relPath: entry.relPath, contentHash: entry.contentHash });
	return out;
}

export type VaultSyncAction =
	| { kind: "import"; relPath: string; contentHash: string }
	| { kind: "reextract"; sourceId: string; relPath: string; contentHash: string }
	| { kind: "rename"; sourceId: string; fromPath: string; relPath: string; contentHash: string }
	| { kind: "unchanged"; sourceId: string; relPath: string };

/** Plan one sync. Deterministic: files are processed in relPath order, and a
 *  vanished source can be claimed by at most one rename. New imports carry
 *  no id — the server mints it (hashing is IO-side). */
export function planVaultSync(files: readonly VaultFile[], entries: readonly VaultSyncEntry[]): VaultSyncAction[] {
	const versions = currentVaultVersions(entries);
	const byPath = new Map<string, string>();
	for (const [sourceId, version] of versions) byPath.set(version.relPath, sourceId);
	const present = new Set(files.map((f) => f.relPath));
	// Rename candidates: sources whose current file is gone, by content.
	const vanishedByHash = new Map<string, string[]>();
	for (const [sourceId, version] of [...versions].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (present.has(version.relPath)) continue;
		const list = vanishedByHash.get(version.contentHash) ?? [];
		list.push(sourceId);
		vanishedByHash.set(version.contentHash, list);
	}
	const actions: VaultSyncAction[] = [];
	for (const file of [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : 1))) {
		const sourceId = byPath.get(file.relPath);
		if (sourceId !== undefined) {
			actions.push(
				versions.get(sourceId)!.contentHash === file.contentHash
					? { kind: "unchanged", sourceId, relPath: file.relPath }
					: { kind: "reextract", sourceId, relPath: file.relPath, contentHash: file.contentHash },
			);
			continue;
		}
		const renamed = vanishedByHash.get(file.contentHash)?.shift();
		if (renamed !== undefined) {
			actions.push({
				kind: "rename",
				sourceId: renamed,
				fromPath: versions.get(renamed)!.relPath,
				relPath: file.relPath,
				contentHash: file.contentHash,
			});
			continue;
		}
		actions.push({ kind: "import", relPath: file.relPath, contentHash: file.contentHash });
	}
	return actions;
}

function isStale(provenance: readonly ProvenancePoint[], versions: ReadonlyMap<string, VaultVersion>): boolean {
	if (provenance.length === 0) return false;
	for (const pt of provenance) {
		const version = versions.get(pt.chatId);
		if (version === undefined) return false; // a chat or a manual import supports it
		if (pt.messageId === version.contentHash) return false; // the current note states it
	}
	return true;
}

/** Proposition and chain ids that only outdated vault-note versions
 *  support. Sorted — deterministic. */
export function staleGraphIds(graph: DerivedGraph, entries: readonly VaultSyncEntry[]): string[] {
	if (entries.length === 0) return [];
	const versions = currentVaultVersions(entries);
	const out: string[] = [];
	for (const node of graph.nodes) if (isStale(node.provenance, versions)) out.push(node.id);
	for (const chain of graph.chains) if (isStale(chain.provenance, versions)) out.push(chain.id);
	return out.sort();
}
