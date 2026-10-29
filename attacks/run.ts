/**
 * pnpm demo — runs all 12 scenarios, each in a fresh world, and prints a table.
 * Exit code 1 if any scenario fails. Options: --json, --only=3,7, --verbose
 */
import { SCENARIOS, type ScenarioResult } from "./scenarios.ts";
import { createWorld } from "./world.ts";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",").map(Number);
const verbose = args.includes("--verbose");
const asJson = args.includes("--json");
const START = Date.parse("2026-11-05T10:00:00.000Z");

const rows: Array<{ id: number; title: string; expected: string; result: ScenarioResult }> = [];
for (const s of SCENARIOS) {
  if (only && !only.includes(s.id)) continue;
  let result: ScenarioResult;
  try {
    result = await s.run(createWorld({ startMs: START }));
  } catch (e) {
    result = { passed: false, actual: `exception: ${e instanceof Error ? e.message : String(e)}`, stopped_by: [], log: [], decision_ids: [] };
  }
  rows.push({ id: s.id, title: s.title, expected: s.expected, result });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  console.log(`\nAgentGuard — ${rows.length} сценариев (симулятор контракта, фиксированное время ${new Date(START).toISOString()})\n`);
  console.log(`${pad("#", 3)} ${pad("Сценарий", 34)} ${pad("Ожидалось", 44)} ${pad("Получилось", 44)} ${pad("Где остановлено", 30)} Итог`);
  console.log("-".repeat(165));
  for (const r of rows) {
    console.log(`${pad(String(r.id), 3)} ${pad(r.title, 34)} ${pad(r.expected, 44)} ${pad(r.result.actual, 44)} ${pad(r.result.stopped_by.join(" + "), 30)} ${r.result.passed ? "PASS" : "FAIL"}`);
    if (verbose || !r.result.passed) for (const l of r.result.log) console.log(`      · ${l}`);
  }
  const passed = rows.filter((r) => r.result.passed).length;
  console.log(`\n${passed}/${rows.length} PASS`);
}
process.exit(rows.every((r) => r.result.passed) ? 0 : 1);
