import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { replay, type Guard, type GuardEvent, type GuardStore } from "../../../packages/guard/src/index.ts";
import { scoreRisk, type FactsProvider } from "../../../packages/risk/src/index.ts";
import { ValidationError, isAccountId, type Decision } from "../../../packages/schema/src/index.ts";
import type { Executor, GuardClient } from "../../../packages/sdk/src/index.ts";
import { runAgent, type Model } from "../../agent/src/agent.ts";
import { GullibleModel, ScriptedModel } from "../../agent/src/models.ts";
import type { VaultSimulator } from "../../../packages/vault-sim/src/index.ts";
import { SCENARIOS } from "../../../attacks/scenarios.ts";
import { ACCOUNTS, demoWeb, type World } from "../../../attacks/world.ts";

/**
 * Everything the HTTP layer needs. In `sim` mode the world (guard + vault
 * simulator) can be swapped by the demo endpoints; in `testnet` mode it is
 * fixed and the vault is the real contract.
 */
export interface AppContext {
  mode: "sim" | "testnet";
  ownerToken: string;
  agentToken: string | null;
  webDir: string;
  /** Current guard/store/executor. Swapped on demo reset in sim mode. */
  current(): { guard: Guard; store: GuardStore; client: GuardClient; executor: Executor; facts: FactsProvider; vault: VaultSimulator | null; world: World | null };
  /** Sim only: build a fresh world and make it current. */
  resetWorld?(): void;
  llm: Model | null;
}

export const bus = new EventEmitter();
bus.setMaxListeners(100);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/** Journal entry without the bulky snapshot, for lists. */
function summary(d: Decision) {
  return {
    decision_id: d.decision_id,
    parent_decision_id: d.parent_decision_id,
    created_at: d.created_at,
    verdict: d.verdict,
    reasons: d.reasons,
    rule_hits: d.rule_hits.map((h) => ({ rule: h.rule, ok: h.ok, severity: h.severity })),
    approval: d.approval,
    proposal: d.input.proposal,
    risk: { score: d.input.risk.score, level: d.input.risk.level },
    state: d.input.state,
    authorization: d.authorization ? { nonce: d.authorization.nonce, expires_at_ms: d.authorization.expires_at_ms } : null,
    execution: d.execution,
    input_hash: d.input_hash,
  };
}

const runs = new Map<string, { status: "running" | "done" | "error"; result?: unknown; error?: string; log: string[] }>();

export function createApp(ctx: AppContext) {
  const wire = (g: Guard) => g.events.on("event", (e: GuardEvent) => bus.emit("event", e));
  let wired = ctx.current().guard;
  wire(wired);
  const cur = () => {
    const c = ctx.current();
    if (c.guard !== wired) {
      wired = c.guard;
      wire(wired);
    }
    return c;
  };

  const requireOwner = (req: IncomingMessage) => {
    if (bearer(req) !== ctx.ownerToken) throw new HttpError(401, "owner token required (Authorization: Bearer <OWNER_TOKEN>)");
  };
  const requireAgent = (req: IncomingMessage) => {
    if (ctx.agentToken && bearer(req) !== ctx.agentToken && bearer(req) !== ctx.ownerToken) throw new HttpError(401, "agent token required");
  };
  const requireSim = () => {
    if (ctx.mode !== "sim" || !ctx.resetWorld) throw new HttpError(404, "only available in simulator mode");
  };

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
    try {
      // ---- Static dashboard -------------------------------------------
      if (method === "GET" && !path.startsWith("/v1/")) {
        const file = path === "/" ? "index.html" : path.slice(1);
        if (!/^[a-z0-9_-]+\.(html|js|css|svg)$/i.test(file)) throw new HttpError(404, "not found");
        const body = await readFile(join(ctx.webDir, file)).catch(() => null);
        if (!body) throw new HttpError(404, "not found");
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
        return;
      }

      const { guard, store, executor, facts, vault } = cur();

      // ---- Health -----------------------------------------------------
      if (method === "GET" && path === "/v1/health") {
        return send(res, 200, {
          ok: true,
          mode: ctx.mode,
          executor: executor.name,
          contract_id: guard.contractId,
          guard_public_key: guard.publicKey,
          llm: ctx.llm?.name ?? null,
          // Only in the local simulator, so the dashboard works out of the box.
          dev_owner_token: ctx.mode === "sim" ? ctx.ownerToken : undefined,
        });
      }

      // ---- Live events (SSE) --------------------------------------------
      if (method === "GET" && path === "/v1/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        const onEvent = (e: GuardEvent | { type: "reset" }) => {
          const payload = "decision" in e ? { type: e.type, decision: summary(e.decision) } : "mandate" in e ? { type: e.type, mandate: e.mandate } : { type: e.type };
          res.write(`data: ${json(payload)}\n\n`);
        };
        bus.on("event", onEvent);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(ping);
          bus.off("event", onEvent);
        });
        return;
      }

      // ---- Policy / freeze ---------------------------------------------
      if (method === "GET" && path === "/v1/policy") return send(res, 200, store.getPolicy());
      if (method === "POST" && path === "/v1/freeze") {
        requireOwner(req);
        const body = (await readBody(req)) as { frozen?: unknown };
        if (typeof body.frozen !== "boolean") throw new HttpError(400, "frozen must be a boolean");
        guard.setFrozen(body.frozen);
        vault?.setFrozen(ACCOUNTS.owner, body.frozen);
        return send(res, 200, { frozen: body.frozen, note: ctx.mode === "testnet" ? "Also call `freeze` on the vault contract with the owner key." : undefined });
      }

      // ---- Mandates ----------------------------------------------------
      if (method === "GET" && path === "/v1/mandates") {
        const now = Date.now();
        return send(res, 200, {
          mandates: store.listMandates().map((m) => {
            const ds = store.listDecisions({ mandate_id: m.id });
            let spent = 0n;
            let reserved = 0n;
            for (const d of ds) {
              if (!d.authorization) continue;
              if (d.execution?.status === "success" || d.execution?.status === "pending_onchain_approval") spent += BigInt(d.authorization.amount_yocto);
              else if (!d.execution && d.authorization.expires_at_ms > now) reserved += BigInt(d.authorization.amount_yocto);
            }
            return { ...m, spent_yocto: spent.toString(), reserved_yocto: reserved.toString(), vault_remaining_yocto: vault?.remaining(m.id)?.toString() ?? null };
          }),
        });
      }
      if (method === "POST" && path === "/v1/mandates") {
        requireOwner(req);
        const m = guard.createMandate(await readBody(req));
        vault?.createMandate(ACCOUNTS.owner, m.id, { budget: BigInt(m.budget_yocto), per_tx_max: BigInt(m.per_tx_max_yocto), expires_at_ms: Date.parse(m.expires_at), allowed_receivers: m.allowed_receivers, onchain_approval_threshold: 0n });
        return send(res, 201, { mandate: m, note: ctx.mode === "testnet" ? "Also call `create_mandate` on the vault contract with the owner key (scripts/setup-testnet.sh shows how)." : undefined });
      }
      if (method === "POST" && seg[0] === "v1" && seg[1] === "mandates" && seg[3] === "revoke" && seg.length === 4) {
        requireOwner(req);
        const m = guard.revokeMandate(seg[2]!);
        vault?.revokeMandate(ACCOUNTS.owner, m.id);
        return send(res, 200, { mandate: m });
      }

      // ---- Check (agent) -------------------------------------------------
      if (method === "POST" && path === "/v1/check") {
        requireAgent(req);
        return send(res, 200, await guard.check(await readBody(req)));
      }

      // ---- Decisions -----------------------------------------------------
      if (method === "GET" && path === "/v1/decisions") {
        const mandate_id = url.searchParams.get("mandate_id") ?? undefined;
        const parent = url.searchParams.get("parent_id");
        let list = store.listDecisions({ mandate_id });
        if (parent) list = list.filter((d) => d.parent_decision_id === parent);
        list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return send(res, 200, { decisions: url.searchParams.get("full") === "1" || parent ? list : list.map(summary) });
      }
      if (seg[0] === "v1" && seg[1] === "decisions" && seg[2]) {
        const d = store.getDecision(seg[2]);
        if (!d) throw new HttpError(404, `decision ${seg[2]} not found`);
        if (method === "GET" && seg.length === 3) return send(res, 200, d);
        if (method === "POST" && seg[3] === "replay") return send(res, 200, replay(d));
        if (method === "POST" && seg[3] === "execution") {
          requireAgent(req);
          const b = (await readBody(req)) as { status?: string; tx_hash?: string | null; error?: string | null };
          if (!["success", "failed", "pending_onchain_approval"].includes(String(b.status))) throw new HttpError(400, "status is invalid");
          return send(res, 200, guard.recordExecution(d.decision_id, { status: b.status as "success", tx_hash: b.tx_hash ?? null, error: b.error ?? null }));
        }
      }

      // ---- Approvals (owner) ---------------------------------------------
      if (method === "GET" && path === "/v1/approvals") {
        return send(res, 200, { approvals: store.listDecisions().filter((d) => d.approval === "pending").map(summary) });
      }
      if (method === "POST" && seg[0] === "v1" && seg[1] === "approvals" && seg[2] && seg.length === 3) {
        requireOwner(req);
        const b = (await readBody(req)) as { approve?: unknown };
        if (typeof b.approve !== "boolean") throw new HttpError(400, "approve must be a boolean");
        const r = await guard.resolveApproval(seg[2], b.approve);
        return send(res, 200, { original: summary(r.original), result: r.result ? summary(r.result) : null });
      }

      // ---- Risk & blocklist ----------------------------------------------
      if (method === "GET" && seg[0] === "v1" && seg[1] === "risk" && seg[2] && seg.length === 3) {
        if (!isAccountId(seg[2])) throw new HttpError(400, "not a NEAR account id");
        const f = await facts.getFacts(seg[2]);
        const bl = store.listBlocklist().find((b) => b.account === seg[2]) ?? null;
        const prior = store.listDecisions().filter((d) => d.execution?.status === "success" && d.input.proposal.receiver === seg[2]).length;
        return send(res, 200, { facts: f, report: scoreRisk({ facts: f, blocklist: bl, prior_payments: prior, now: new Date().toISOString() }) });
      }
      if (method === "GET" && path === "/v1/blocklist") return send(res, 200, { entries: store.listBlocklist() });
      if (method === "POST" && path === "/v1/blocklist/reports") {
        requireAgent(req);
        const b = (await readBody(req)) as Record<string, unknown>;
        if (!isAccountId(b.account)) throw new HttpError(400, "account must be a NEAR account id");
        return send(res, 201, guard.reportBlocklist({ account: b.account, reason: String(b.reason ?? ""), evidence_url: String(b.evidence_url ?? ""), reported_by: String(b.reported_by ?? "anonymous") }));
      }

      // ---- Vault (simulator view) ----------------------------------------
      if (method === "GET" && path === "/v1/vault") {
        if (!vault) return send(res, 200, { mode: ctx.mode, note: "In testnet mode read the contract: get_mandate, get_pending, get_config." });
        return send(res, 200, {
          contract_id: vault.contractId,
          frozen: vault.frozen,
          balance_yocto: vault.balances.get(vault.contractId) ?? 0n,
          mandates: [...vault.mandates.entries()].map(([id, m]) => ({ id, budget: m.budget, committed: m.committed, remaining: m.budget - m.committed, revoked: m.revoked })),
          receivers: Object.fromEntries([...vault.balances.entries()].filter(([a]) => a !== vault.contractId)),
          events: vault.events.slice(-50),
        });
      }

      // ---- Agent run -------------------------------------------------------
      if (method === "POST" && path === "/v1/agent/run") {
        requireOwner(req);
        const c = cur();
        const b = (await readBody(req)) as { mode?: string; task?: string; mandate_id?: string };
        const mandate = store.getMandate(b.mandate_id ?? store.listMandates()[0]?.id ?? "");
        if (!mandate) throw new HttpError(400, "no mandate");
        let model: Model;
        let task = b.task ?? "Подключи тариф Basic у Weather API (https://weather-api.example/pricing).";
        if (b.mode === "llm") {
          if (!ctx.llm) throw new HttpError(400, "LLM is not configured (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL)");
          model = ctx.llm;
        } else if (b.mode === "gullible") {
          model = new GullibleModel("https://weather-api.example/pricing-compromised");
          task = "Подключи тариф Basic у Weather API.";
        } else {
          model = new ScriptedModel([
            [{ name: "http_get", arguments: { url: "https://weather-api.example/pricing" } }],
            [{ name: "propose_payment", arguments: { receiver: ACCOUNTS.weatherApi, amount_near: "0.2", category: "api_access", justification: "Basic plan" } }],
            [{ name: "finish", arguments: { summary: "Оплачен тариф Basic" } }],
          ]);
        }
        const id = `run_${randomUUID()}`;
        const entry = { status: "running" as "running" | "done" | "error", log: [] as string[], result: undefined as unknown, error: undefined as string | undefined };
        runs.set(id, entry);
        void runAgent({ task, mandate, model, guard: c.client, executor: c.executor, web: demoWeb, log: (l) => entry.log.push(l) })
          .then((r) => Object.assign(entry, { status: "done", result: { summary: r.summary, payments: r.payments.map((p) => ({ status: p.status, decision_id: p.decision.decision_id })) } }))
          .catch((e: unknown) => Object.assign(entry, { status: "error", error: e instanceof Error ? e.message : String(e) }));
        return send(res, 202, { run_id: id });
      }
      if (method === "GET" && seg[0] === "v1" && seg[1] === "agent" && seg[2] === "runs" && seg[3]) {
        const r = runs.get(seg[3]);
        if (!r) throw new HttpError(404, "run not found");
        return send(res, 200, r);
      }

      // ---- Demo scenarios (simulator only) ------------------------------
      if (method === "GET" && path === "/v1/demo/scenarios") {
        return send(res, 200, { scenarios: SCENARIOS.map(({ id, title, attack, expected }) => ({ id, title, attack, expected })) });
      }
      if (method === "POST" && path === "/v1/demo/reset") {
        requireSim();
        requireOwner(req);
        ctx.resetWorld!();
        cur();
        bus.emit("event", { type: "reset" });
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && seg[0] === "v1" && seg[1] === "demo" && seg[2] === "scenarios" && seg[4] === "run") {
        requireSim();
        requireOwner(req);
        const s = SCENARIOS.find((x) => x.id === Number(seg[3]));
        if (!s) throw new HttpError(404, "no such scenario");
        ctx.resetWorld!();
        const fresh = cur();
        bus.emit("event", { type: "reset" });
        const result = await s.run(fresh.world!);
        return send(res, 200, { scenario: { id: s.id, title: s.title, expected: s.expected }, result });
      }

      throw new HttpError(404, `no route for ${method} ${path}`);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof ValidationError) return send(res, 400, { error: e.message, issues: e.issues });
      const msg = e instanceof Error ? e.message : String(e);
      // Business-rule errors from the Guard (unknown mandate, already executed…) are client errors.
      if (/not found/.test(msg)) return send(res, 404, { error: msg });
      if (/already|not awaiting|must be|too short|exists|no authorization/.test(msg)) return send(res, 409, { error: msg });
      console.error(e);
      return send(res, 500, { error: "internal error" });
    }
  };
}
