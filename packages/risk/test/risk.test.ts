import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRisk, StaticFactsProvider, Blocklist } from "../src/index.ts";

const now = "2026-11-05T10:00:00.000Z";

test("old, active, known account → low risk", async () => {
  const facts = await new StaticFactsProvider({ "a.testnet": { exists: true, is_contract: false, code_hash: null, created_at: "2025-01-01T00:00:00Z", tx_count: 300, code_changed_at: null } }).getFacts("a.testnet");
  const r = scoreRisk({ facts, blocklist: null, prior_payments: 2, now });
  assert.equal(r.level, "low");
  assert.equal(r.score, 0);
});

test("missing account → high risk", async () => {
  const facts = await new StaticFactsProvider({}).getFacts("ghost.testnet");
  const r = scoreRisk({ facts, blocklist: null, prior_payments: 0, now });
  assert.equal(r.level, "high");
});

test("account created today with no history → medium or worse", () => {
  const r = scoreRisk({
    facts: { account: "new.testnet", exists: true, is_contract: false, code_hash: null, created_at: "2026-11-05T08:00:00Z", tx_count: 1, code_changed_at: null },
    blocklist: null,
    prior_payments: 0,
    now,
  });
  assert.equal(r.score, 55);
  assert.equal(r.level, "medium");
});

test("contract redeployed in the last 24 h adds risk", () => {
  const r = scoreRisk({
    facts: { account: "svc.testnet", exists: true, is_contract: true, code_hash: "x", created_at: "2025-01-01T00:00:00Z", tx_count: 500, code_changed_at: "2026-11-05T02:00:00Z" },
    blocklist: null,
    prior_payments: 0,
    now,
  });
  assert.equal(r.signals.find((s) => s.name === "contract_code_changed_hours")?.points, 30);
});

test("blocklist forces score 100 and requires evidence", () => {
  const bl = new Blocklist();
  assert.throws(() => bl.report({ account: "x.testnet", reason: "drainer", evidence_url: "http://x", reported_by: "a", at: now }));
  const e = bl.report({ account: "x.testnet", reason: "known drainer", evidence_url: "https://example.org/report/1", reported_by: "agent-7", at: now });
  const r = scoreRisk({ facts: { account: "x.testnet", exists: true, is_contract: false, code_hash: null, created_at: "2020-01-01T00:00:00Z", tx_count: 99, code_changed_at: null }, blocklist: e, prior_payments: 0, now });
  assert.equal(r.score, 100);
  assert.equal(r.blocklisted, true);
});
