import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS } from "./scenarios.ts";
import { createWorld } from "./world.ts";

for (const s of SCENARIOS) {
  test(`scenario ${s.id}: ${s.title}`, async () => {
    const r = await s.run(createWorld({ startMs: Date.parse("2026-11-05T10:00:00.000Z") }));
    assert.ok(r.passed, `${r.actual}\n${r.log.join("\n")}`);
  });
}
