/**
 * POST /api/graph/vault-sync — the manual vault sync's transport
 * (src/server/vault-sync.ts): import new or changed notes from the
 * configured vault's Concepts/ folder, recognize renames, skip unchanged
 * files. Awaits the whole sync; the runs surface in the status chips
 * meanwhile, like an explicit import.
 */
import { vaultSync } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	const outcome = await vaultSync.sync();
	if (!outcome.ok) return Response.json({ code: outcome.code, error: outcome.error }, { status: outcome.status });
	return Response.json(outcome.summary);
}
