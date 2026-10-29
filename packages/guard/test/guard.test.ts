import { test } from "node:test";
import assert from "node:assert/strict";
import { Guard, GuardSigner, MemoryStore, replay, verifyMessage, base58Decode, base58Encode, authorizationMessage } from "../src/index.ts";
import { StaticFactsProvider } from "../../risk/src/index.ts";
import { nearToYocto as N } from "../../schema/src/index.ts";

const OLD = { exists: true, is_contract: false, code_hash: null, created_at: "2025-01-01T00:00:00.000Z", tx_count: 120, code_changed_at: null };

function setup(now = "2026-11-05T10:00:00.000Z") {
  let t = Date.parse(now);
  const { signer } = GuardSigner.generate();
  const guard = new Guard({
    store: new MemoryStore(),
    facts: new StaticFactsProvider({ "weather-api.testnet": OLD, "gpu.testnet": OLD }),
    signer,
    contractId: "vault.agentguard.testnet",
    clock: () => new Date(t),
  });
  guard.createMandate({
    id: "m1",
    goal: "API",
    budget_yocto: N("3"),
    per_tx_max_yocto: N("1"),
    expires_at: "2026-11-13T23:59:00Z",
    allowed_categories: ["api_access"],
    allowed_receivers: ["weather-api.testnet"],
    approval_threshold_yocto: N("0.9"),
  });
  return { guard, signer, advance: (ms: number) => (t += ms) };
}

const proposal = (amount: string, receiver = "weather-api.testnet") => ({ mandate_id: "m1", action: "transfer", receiver, amount_yocto: N(amount), category: "api_access", justification: "test", provenance: "mandate" });

test("allow returns a signature the contract format can verify", async () => {
  const { guard } = setup();
  const d = await guard.check(proposal("0.2"));
  assert.equal(d.verdict, "allow");
  const a = d.authorization!;
  const { contract_id, mandate_id, receiver, amount_yocto, nonce, expires_at_ms, input_hash } = a;
  assert.equal(a.message, authorizationMessage({ contract_id, mandate_id, receiver, amount_yocto, nonce, expires_at_ms, input_hash }));
  assert.equal(input_hash, d.input_hash);
  assert.ok(verifyMessage(a.message, a.signature, guard.publicKey));
  assert.ok(!verifyMessage(a.message.replace(N("0.2"), N("2")), a.signature, guard.publicKey), "tampered amount must not verify");
});

test("reservations count against the budget until executed or expired", async () => {
  const { guard, advance } = setup();
  for (let i = 0; i < 3; i++) assert.equal((await guard.check(proposal("0.8"))).verdict, "allow");
  assert.equal((await guard.check(proposal("0.8"))).verdict, "block", "4th payment exceeds the 3 NEAR budget");
  advance(121_000); // all three signatures expire unused
  assert.equal((await guard.check(proposal("0.8"))).verdict, "allow");
});

test("concurrent checks cannot overspend", async () => {
  const { guard } = setup();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => guard.check(proposal("0.8"))));
  assert.equal(results.filter((d) => d.verdict === "allow").length, 3);
});

test("executions move reservation into spent", async () => {
  const { guard, advance } = setup();
  const d = await guard.check(proposal("0.85"));
  assert.equal(d.verdict, "allow");
  guard.recordExecution(d.decision_id, { status: "success", tx_hash: "abc", error: null });
  assert.throws(() => guard.recordExecution(d.decision_id, { status: "success", tx_hash: "abc", error: null }), /already executed/);
  advance(500_000);
  const d2 = await guard.check(proposal("0.85"));
  assert.equal(d2.input.state.spent_yocto, N("0.85"));
  assert.equal(d2.verdict, "allow");
});

test("warn → owner approves → new allow decision linked to the original", async () => {
  const { guard } = setup();
  const w = await guard.check(proposal("0.95"));
  assert.equal(w.verdict, "warn");
  assert.equal(w.authorization, null);
  const { original, result } = await guard.resolveApproval(w.decision_id, true);
  assert.equal(original.approval, "approved");
  assert.equal(result!.verdict, "allow");
  assert.equal(result!.parent_decision_id, w.decision_id);
  await assert.rejects(guard.resolveApproval(w.decision_id, true), /not awaiting approval/);
});

test("replay reproduces every decision and detects tampering", async () => {
  const { guard } = setup();
  const ds = [await guard.check(proposal("0.2")), await guard.check(proposal("0.2", "gpu.testnet")), await guard.check(proposal("0.95"))];
  for (const d of ds) assert.ok(replay(d).match, d.decision_id);
  const tampered = structuredClone(ds[1]!);
  tampered.verdict = "allow";
  assert.equal(replay(tampered).match, false);
  const tampered2 = structuredClone(ds[0]!);
  tampered2.input.state.spent_yocto = "1";
  assert.equal(replay(tampered2).input_hash_match, false);
});

test("nonces are unique and increasing", async () => {
  const { guard } = setup();
  const a = await guard.check(proposal("0.1"));
  const b = await guard.check(proposal("0.1"));
  assert.ok(b.authorization!.nonce > a.authorization!.nonce);
});

test("base58 round-trip and seed-derived key is stable", () => {
  const bytes = new Uint8Array([0, 0, 1, 2, 255, 128]);
  assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  const { seedBase64, signer } = GuardSigner.generate();
  assert.equal(GuardSigner.fromSeedBase64(seedBase64).publicKeyNear, signer.publicKeyNear);
});
