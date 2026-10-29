import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp, type AppContext } from "../src/app.ts";
import { createWorld, ACCOUNTS, MANDATE_ID, type World } from "../../../attacks/world.ts";
import { HttpGuardClient } from "../../../packages/sdk/src/clients.ts";
import { guardedPay } from "../../../packages/sdk/src/index.ts";
import { nearToYocto as N } from "../../../packages/schema/src/index.ts";

let server: Server;
let base = "";
let world: World;
const OWNER = { authorization: "Bearer test-owner" };

before(async () => {
  world = createWorld();
  const ctx: AppContext = {
    mode: "sim",
    ownerToken: "test-owner",
    agentToken: null,
    webDir: join(dirname(fileURLToPath(import.meta.url)), "../../web"),
    llm: null,
    current: () => ({ guard: world.guard, store: world.store, client: world.client, executor: world.executor, facts: world.facts, vault: world.vault, world }),
    resetWorld: () => {
      world = createWorld({ signer: world.signer });
    },
  };
  server = createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => server.close());

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

const proposal = (receiver: string, amount: string) => ({ mandate_id: MANDATE_ID, action: "transfer", receiver, amount_yocto: N(amount), category: "api_access", justification: "", provenance: "mandate" });

test("health exposes mode and guard key", async () => {
  const r = await call("GET", "/v1/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "sim");
  assert.match(r.body.guard_public_key, /^ed25519:/);
});

test("check → allow → executed through an HTTP agent client", async () => {
  const client = new HttpGuardClient(base);
  const r = await guardedPay(proposal(ACCOUNTS.weatherApi, "0.2"), { guard: client, executor: world.executor });
  assert.equal(r.status, "executed");
  const replayed = await call("POST", `/v1/decisions/${r.decision.decision_id}/replay`);
  assert.equal(replayed.body.match, true);
  const mandates = await call("GET", "/v1/mandates");
  assert.equal(mandates.body.mandates[0].spent_yocto, N("0.2"));
  assert.equal(mandates.body.mandates[0].vault_remaining_yocto, N("2.8"));
});

test("invalid proposal → 400 with issues", async () => {
  const r = await call("POST", "/v1/check", { mandate_id: MANDATE_ID, action: "transfer", receiver: "NOT VALID", amount_yocto: "-1", category: "x" });
  assert.equal(r.status, 400);
  assert.ok(r.body.issues.length >= 3);
});

test("owner endpoints require the owner token", async () => {
  assert.equal((await call("POST", "/v1/freeze", { frozen: true })).status, 401);
  assert.equal((await call("POST", "/v1/freeze", { frozen: true }, { authorization: "Bearer wrong" })).status, 401);
});

test("warn appears in approvals; owner approves over HTTP; agent waiting gets paid", async () => {
  const client = new HttpGuardClient(base);
  const paying = guardedPay(proposal(ACCOUNTS.weatherApi, "0.95"), { guard: client, executor: world.executor, pollMs: 10 });
  let pending: any[] = [];
  for (let i = 0; i < 100 && pending.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
    pending = (await call("GET", "/v1/approvals")).body.approvals;
  }
  assert.equal(pending.length, 1);
  const ok = await call("POST", `/v1/approvals/${pending[0].decision_id}`, { approve: true }, OWNER);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.verdict, "allow");
  const r = await paying;
  assert.equal(r.status, "executed");
  assert.equal((await call("POST", `/v1/approvals/${pending[0].decision_id}`, { approve: true }, OWNER)).status, 409);
});

test("freeze over HTTP blocks the guard and the vault", async () => {
  assert.equal((await call("POST", "/v1/freeze", { frozen: true }, OWNER)).status, 200);
  const d = await call("POST", "/v1/check", proposal(ACCOUNTS.weatherApi, "0.1"));
  assert.equal(d.body.verdict, "block");
  assert.equal((await call("GET", "/v1/vault")).body.frozen, true);
  await call("POST", "/v1/freeze", { frozen: false }, OWNER);
});

test("risk endpoint scores a receiver", async () => {
  const r = await call("GET", `/v1/risk/${ACCOUNTS.drain}`);
  assert.equal(r.body.report.blocklisted, true);
  assert.equal(r.body.report.score, 100);
});

test("demo scenario runs over HTTP in a fresh world", async () => {
  const list = await call("GET", "/v1/demo/scenarios");
  assert.equal(list.body.scenarios.length, 12);
  for (const id of [5, 7, 12]) {
    const r = await call("POST", `/v1/demo/scenarios/${id}/run`, {}, OWNER);
    assert.equal(r.status, 200);
    assert.equal(r.body.result.passed, true, `scenario ${id}: ${JSON.stringify(r.body.result.log)}`);
  }
  // Journal now shows only the last scenario's decisions.
  const ds = await call("GET", "/v1/decisions");
  assert.equal(ds.body.decisions.length, 1);
});

test("unknown routes and decisions → 404", async () => {
  assert.equal((await call("GET", "/v1/nope")).status, 404);
  assert.equal((await call("GET", "/v1/decisions/d_missing")).status, 404);
});
