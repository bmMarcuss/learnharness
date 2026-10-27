/**
 * THE VAULT SYNC — manual "Sync vault" over <vault>/Concepts/*.md.
 *
 * Pins: the pure plan (import / unchanged / re-extract / rename / vanished
 * left alone), staleness (only outdated vault versions → stale; a chat, a
 * manual import, or the current version keeps it fresh), the merger's
 * anchor (version-stamped points; a new version re-asserts a chain), the
 * version-scoped digest, and the IO half over a temp vault with a fake
 * notes door (skip unchanged, stable id across edits, rename without a
 * run, failure retried next sync, setup refusal stops the queue, WSL path
 * translation).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-sync-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { planVaultSync, staleGraphIds } = await import("../src/core/vault-sync.ts");
const { getGraph, mergeFindings } = await import("../src/core/graph.ts");
const { sourceDigest } = await import("../src/agent/subagents/extraction.ts");
const { createVaultSync, resolveVaultPath } = await import("../src/server/vault-sync.ts");
const { ModelsNotConfiguredError, sanitizeUserSettings } = await import("../src/core/settings.ts");
const { parseGraphSettingsBody } = await import("../src/server/settings-body.ts");
const { newGraphContextMessage } = await import("../src/core/native-messages.ts");
import type { GraphChain, GraphNode, NotesSource, VaultSyncEntry } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import type { NotesImportInput } from "../src/agent/subagents/extraction.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const entry = (sourceId: string, relPath: string, contentHash: string): VaultSyncEntry => ({
	sourceId,
	relPath,
	contentHash,
	syncedAt: "2026-10-27T00:00:00.000Z",
});

function memStore() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const vault: VaultSyncEntry[] = [];
	const sources = new Map<string, NotesSource>();
	const store = {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n, provenance: [...n.provenance] })),
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: () => {},
		appendCoverage: () => {},
		rewriteLedgers: (next: { chains?: GraphChain[] }) => {
			if (next.chains) chains.splice(0, chains.length, ...next.chains);
		},
		appendVaultSync: (e: VaultSyncEntry) => void vault.push({ ...e }),
		readVaultSync: () => vault.map((e) => ({ ...e })),
		upsertSource: (s: NotesSource) => void sources.set(s.id, { ...s }),
		readSources: () => [...sources.values()],
	};
	return { store, nodes, chains, vault, sources };
}

describe("planVaultSync", () => {
	const ledger = [entry("src_a", "Concepts/A.md", "h1"), entry("src_b", "Concepts/B.md", "h2")];

	it("new → import, same → unchanged, edited → re-extract under the same id", () => {
		const plan = planVaultSync(
			[
				{ relPath: "Concepts/A.md", contentHash: "h1" },
				{ relPath: "Concepts/B.md", contentHash: "h2-edited" },
				{ relPath: "Concepts/C.md", contentHash: "h3" },
			],
			ledger,
		);
		assert.deepEqual(plan, [
			{ kind: "unchanged", sourceId: "src_a", relPath: "Concepts/A.md" },
			{ kind: "reextract", sourceId: "src_b", relPath: "Concepts/B.md", contentHash: "h2-edited" },
			{ kind: "import", relPath: "Concepts/C.md", contentHash: "h3" },
		]);
	});

	it("unchanged content at a new path whose old file is gone → rename; a vanished file is left alone", () => {
		const plan = planVaultSync([{ relPath: "Concepts/A renamed.md", contentHash: "h1" }], ledger);
		assert.deepEqual(plan, [
			{ kind: "rename", sourceId: "src_a", fromPath: "Concepts/A.md", relPath: "Concepts/A renamed.md", contentHash: "h1" },
		]);
	});

	it("a copy (old file still present) is a new import, never a rename", () => {
		const plan = planVaultSync(
			[
				{ relPath: "Concepts/A.md", contentHash: "h1" },
				{ relPath: "Concepts/A copy.md", contentHash: "h1" },
				{ relPath: "Concepts/B.md", contentHash: "h2" },
			],
			ledger,
		);
		assert.equal(plan.find((a) => a.relPath === "Concepts/A copy.md")?.kind, "import");
	});

	it("rename + edit together falls back to a new import", () => {
		const plan = planVaultSync([{ relPath: "Concepts/A2.md", contentHash: "h1-edited" }], ledger);
		assert.deepEqual(plan, [{ kind: "import", relPath: "Concepts/A2.md", contentHash: "h1-edited" }]);
	});

	it("the latest ledger line is the current version", () => {
		const plan = planVaultSync(
			[{ relPath: "Concepts/A.md", contentHash: "h1b" }],
			[entry("src_a", "Concepts/A.md", "h1"), entry("src_a", "Concepts/A.md", "h1b")],
		);
		assert.equal(plan[0]!.kind, "unchanged");
	});
});

describe("staleGraphIds", () => {
	const node = (id: string, provenance: GraphNode["provenance"]): GraphNode => ({
		id, name: id, statement: id, aliases: [], createdAt: "2026-10-27T00:00:00.000Z", provenance,
	});
	const ledger = [entry("src_v", "Concepts/V.md", "old"), entry("src_v", "Concepts/V.md", "new")];

	it("stale only when every point is an outdated vault version", () => {
		const graph = {
			nodes: [
				node("n_old", [{ chatId: "src_v", messageId: "old" }]),
				node("n_current", [{ chatId: "src_v", messageId: "old" }, { chatId: "src_v", messageId: "new" }]),
				node("n_chat", [{ chatId: "src_v", messageId: "old" }, { chatId: "chat_1", messageId: "m1" }]),
				node("n_manual", [{ chatId: "src_manual", messageId: "" }]),
			],
			chains: [
				{ id: "arg_old", premises: ["n_old"], conclusion: "n_current", createdAt: "", provenance: [{ chatId: "src_v", messageId: "old" }] },
				{ id: "arg_new", premises: ["n_chat"], conclusion: "n_current", createdAt: "", provenance: [{ chatId: "src_v", messageId: "new" }] },
			],
		};
		assert.deepEqual(staleGraphIds(graph, ledger), ["arg_old", "n_old"]);
	});

	it("no vault ledger → nothing is stale", () => {
		assert.deepEqual(staleGraphIds({ nodes: [node("n", [{ chatId: "src_x", messageId: "" }])], chains: [] }, []), []);
	});
});

describe("mergeFindings anchor + version-scoped digest", () => {
	it("stamps the version into node and chain points; a new version re-asserts the same chain", () => {
		const { store } = memStore();
		const deps = { chatStore: {} as never, graphStore: store as unknown as GraphStore };
		const findings = {
			propositions: [
				{ id: "p1", name: "A", statement: "A holds.", aliases: [] },
				{ id: "p2", name: "B", statement: "B holds.", aliases: [] },
			],
			chains: [{ premises: ["p1"], conclusion: "p2" }],
		};
		mergeFindings("src_v", findings, { links: [] }, deps, { foldedAt: "t", anchor: "v1" });
		const first = getGraph(store);
		assert.deepEqual(first.nodes.map((n) => n.provenance), [[{ chatId: "src_v", messageId: "v1" }], [{ chatId: "src_v", messageId: "v1" }]]);
		const [a, b] = first.nodes;
		// v2: the auditor links both propositions; the chain re-asserts under v2
		mergeFindings("src_v", findings, { links: [{ id: "p1", linkTo: a!.id }, { id: "p2", linkTo: b!.id }] }, deps, { foldedAt: "t", anchor: "v2" });
		const second = getGraph(store);
		assert.equal(second.chains.length, 1, "same argument, one chain");
		assert.deepEqual(second.chains[0]!.provenance.map((pt) => pt.messageId), ["v1", "v2"]);
		assert.deepEqual(staleGraphIds(second, [entry("src_v", "Concepts/V.md", "v2")]), []);
		// the v2 digest is empty before v2 has merged anything; v1's digest is full
		assert.equal(sourceDigest(first, "src_v", "v2"), "");
		assert.match(sourceDigest(first, "src_v", "v1"), /THE GRAPH SO FAR/);
		assert.match(sourceDigest(first, "src_v"), /THE GRAPH SO FAR/, "no version → the whole source, as before");
	});

	it("without an anchor the chat path is unchanged: \"\" points, no re-assertion", () => {
		const { store, chains } = memStore();
		const deps = { chatStore: {} as never, graphStore: store as unknown as GraphStore };
		const findings = {
			propositions: [
				{ id: "p1", name: "A", statement: "A holds.", aliases: [] },
				{ id: "p2", name: "B", statement: "B holds.", aliases: [] },
			],
			chains: [{ premises: ["p1"], conclusion: "p2" }],
		};
		mergeFindings("chat_1", findings, { links: [] }, deps, { foldedAt: "t" });
		const [a, b] = getGraph(store).nodes;
		mergeFindings("chat_1", findings, { links: [{ id: "p1", linkTo: a!.id }, { id: "p2", linkTo: b!.id }] }, deps, { foldedAt: "t" });
		assert.equal(chains.length, 1, "the same chat never re-asserts its own chain");
		assert.equal(chains[0]!.provenance[0]!.messageId, "");
	});
});

describe("createVaultSync (temp vault, fake notes door)", () => {
	function setup(importNotes: (input: NotesImportInput) => Promise<{ nodes: number; chains: number }>) {
		const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-"));
		fs.mkdirSync(path.join(vaultDir, "Concepts"));
		const mem = memStore();
		const calls: NotesImportInput[] = [];
		const sync = createVaultSync({
			graphStore: mem.store,
			importNotes: async (input) => {
				calls.push(input);
				return importNotes(input);
			},
			vaultPath: () => vaultDir,
			isWsl: () => false,
		});
		const write = (name: string, text: string) => fs.writeFileSync(path.join(vaultDir, "Concepts", name), text);
		return { vaultDir, mem, calls, sync, write };
	}
	const ok = async () => ({ nodes: 1, chains: 0 });

	it("imports new notes, skips unchanged, re-extracts edits under the same id, renames without a run", async () => {
		const t = setup(ok);
		t.write("A.md", "alpha");
		t.write("B.md", "beta");
		fs.writeFileSync(path.join(t.vaultDir, "Concepts", "ignored.txt"), "not markdown");
		const first = await t.sync.sync();
		assert.ok(first.ok);
		assert.deepEqual(first.summary.imported, ["Concepts/A.md", "Concepts/B.md"]);
		assert.equal(t.calls.length, 2);
		const idOfA = t.calls.find((c) => c.filePath === "Concepts/A.md")!.sourceId!;
		assert.match(idOfA, /^src_[0-9a-f]{12}$/);
		assert.ok(t.calls.every((c) => typeof c.version === "string" && c.version.length === 64));

		const second = await t.sync.sync();
		assert.ok(second.ok);
		assert.equal(second.summary.unchanged, 2);
		assert.equal(t.calls.length, 2, "unchanged files cost nothing");

		t.write("A.md", "alpha, edited");
		fs.renameSync(path.join(t.vaultDir, "Concepts", "B.md"), path.join(t.vaultDir, "Concepts", "B2.md"));
		const third = await t.sync.sync();
		assert.ok(third.ok);
		assert.deepEqual(third.summary.reextracted, ["Concepts/A.md"]);
		assert.deepEqual(third.summary.renamed, [{ from: "Concepts/B.md", to: "Concepts/B2.md" }]);
		assert.equal(t.calls.length, 3, "the rename runs no extraction");
		assert.equal(t.calls[2]!.sourceId, idOfA, "an edit keeps the source id");
		const renamedId = t.mem.vault.find((e) => e.relPath === "Concepts/B2.md")!.sourceId;
		assert.equal(renamedId, t.calls.find((c) => c.filePath === "Concepts/B.md")!.sourceId, "a rename keeps the source id");
		assert.equal(t.mem.sources.get(renamedId)?.filePath, "Concepts/B2.md");

		fs.rmSync(path.join(t.vaultDir, "Concepts", "B2.md"));
		const fourth = await t.sync.sync();
		assert.ok(fourth.ok);
		assert.equal(fourth.summary.unchanged, 1, "a deleted note is left alone");
		assert.equal(t.calls.length, 3);
	});

	it("a failed import records nothing, so the next sync retries it", async () => {
		let fail = true;
		const t = setup(async () => {
			if (fail) throw new Error("synthetic extractor failure");
			return { nodes: 1, chains: 0 };
		});
		t.write("A.md", "alpha");
		const first = await t.sync.sync();
		assert.ok(first.ok);
		assert.deepEqual(first.summary.failed, [{ relPath: "Concepts/A.md", error: "synthetic extractor failure" }]);
		assert.equal(t.mem.vault.length, 0);
		fail = false;
		const second = await t.sync.sync();
		assert.ok(second.ok);
		assert.deepEqual(second.summary.imported, ["Concepts/A.md"]);
		assert.equal(t.calls[0]!.sourceId, t.calls[1]!.sourceId, "the retry reuses the same id");
	});

	it("a setup refusal stops the queue instead of failing every file", async () => {
		const t = setup(async () => {
			throw new ModelsNotConfiguredError(["cheap"]);
		});
		for (const name of ["A.md", "B.md", "C.md", "D.md", "E.md"]) t.write(name, name);
		const outcome = await t.sync.sync();
		assert.ok(outcome.ok);
		assert.ok(outcome.summary.failed.length <= 3, "at most the in-flight workers fail");
		assert.ok(outcome.summary.failed.every((f) => f.code === "models_not_configured"));
	});

	it("refuses honestly: unset vault, missing Concepts/, a sync already running", async () => {
		const unset = createVaultSync({ graphStore: memStore().store, importNotes: ok, vaultPath: () => "", isWsl: () => false });
		assert.deepEqual(await unset.sync(), {
			ok: false, status: 400, code: "vault_not_set", error: "Set the vault folder in Settings → Graph first.",
		});
		const missing = createVaultSync({ graphStore: memStore().store, importNotes: ok, vaultPath: () => os.tmpdir() + "/lh-no-such-vault", isWsl: () => false });
		const refusal = await missing.sync();
		assert.ok(!refusal.ok && refusal.code === "vault_not_found");

		let release!: () => void;
		const t = setup(() => new Promise((resolve) => { release = () => resolve({ nodes: 0, chains: 0 }); }));
		t.write("A.md", "alpha");
		const running = t.sync.sync();
		await new Promise((r) => setImmediate(r));
		const busy = await t.sync.sync();
		assert.ok(!busy.ok && busy.code === "busy" && busy.status === 409);
		release();
		assert.ok((await running).ok);
	});

	it("translates a Windows path only under WSL", () => {
		assert.equal(resolveVaultPath("C:\\Users\\me\\Documents\\Learning", true), "/mnt/c/Users/me/Documents/Learning");
		assert.equal(resolveVaultPath("C:\\Users\\me\\Learning", false), "C:\\Users\\me\\Learning");
		assert.equal(resolveVaultPath("  /home/me/vault ", true), "/home/me/vault");
	});
});

describe("vault path setting + stale practice picks", () => {
	it("the sanitizer keeps a trimmed path and drops blanks; the PUT parser agrees", () => {
		assert.equal(sanitizeUserSettings({ version: 1, graph: { vaultPath: "  /v  " } })?.graph?.vaultPath, "/v");
		assert.equal(sanitizeUserSettings({ version: 1, graph: { vaultPath: "  " } })?.graph?.vaultPath, undefined);
		assert.deepEqual(parseGraphSettingsBody({ vaultPath: " /v " }), { ok: true, settings: { vaultPath: "/v" } });
		assert.deepEqual(parseGraphSettingsBody({ vaultPath: 3 }), { ok: false, error: "vaultPath must be a string" });
	});

	it("a stale pick is flagged in the session context the model reads", () => {
		const message = newGraphContextMessage(
			[
				{ id: "n_1", name: "Fresh", statement: "Fresh holds." },
				{ id: "n_2", name: "Old", statement: "Old held.", stale: true },
			],
			[],
		);
		assert.match(message.content as string, /\[n_1\] Fresh: Fresh holds\.\n/);
		assert.match(message.content as string, /\[n_2\] Old: Old held\. \(stale: its source note has changed since it was extracted\)/);
	});
});
