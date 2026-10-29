/**
 * pnpm replay <decision_id>         — ask a running API to re-evaluate a stored decision
 * pnpm replay --file data/agentguard.json [<decision_id>]   — offline, straight from a data file
 *
 * Prints whether the replayed verdict, rule hits and input hash match the record.
 */
import { readFileSync } from "node:fs";
import { replay } from "../../../packages/guard/src/index.ts";
import type { Decision } from "../../../packages/schema/src/index.ts";

const args = process.argv.slice(2);
const fileIdx = args.indexOf("--file");

if (fileIdx >= 0) {
  const file = args[fileIdx + 1]!;
  const id = args.find((a, i) => i !== fileIdx && i !== fileIdx + 1);
  const decisions = (JSON.parse(readFileSync(file, "utf8")) as { decisions: Decision[] }).decisions.filter((d) => !id || d.decision_id === id);
  let bad = 0;
  for (const d of decisions) {
    const r = replay(d);
    if (!r.match) bad++;
    console.log(`${r.match ? "MATCH   " : "MISMATCH"} ${d.decision_id} ${r.stored_verdict} → ${r.replayed_verdict}${r.input_hash_match ? "" : " (input hash differs)"}`);
  }
  console.log(`\n${decisions.length - bad}/${decisions.length} decisions replay identically`);
  process.exit(bad ? 1 : 0);
} else {
  const id = args[0];
  if (!id) {
    console.error("usage: pnpm replay <decision_id> | pnpm replay --file <data.json> [id]");
    process.exit(2);
  }
  const api = process.env.AGENTGUARD_URL ?? "http://localhost:8787";
  const res = await fetch(`${api}/v1/decisions/${encodeURIComponent(id)}/replay`, { method: "POST" });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  process.exit(res.ok && (body as { match?: boolean }).match ? 0 : 1);
}
