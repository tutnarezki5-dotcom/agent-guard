import type { Decision, GuardAuthorization } from "../../schema/src/index.ts";
import type { Guard } from "../../guard/src/index.ts";
import { VaultError, type VaultSimulator } from "../../vault-sim/src/index.ts";
import type { ExecutionResult, Executor, GuardClient } from "./index.ts";

/** Same process as the Guard: tests, the demo runner, the API's built-in agent. */
export class InProcessGuardClient implements GuardClient {
  constructor(private readonly guard: Guard) {}
  check(proposal: unknown) {
    return this.guard.check(proposal);
  }
  async getDecision(id: string) {
    const d = this.guard.store.getDecision(id);
    if (!d) throw new Error(`decision ${id} not found`);
    return d;
  }
  async findChild(parentId: string) {
    return this.guard.store.listDecisions().find((d) => d.parent_decision_id === parentId) ?? null;
  }
  async recordExecution(id: string, exec: Parameters<GuardClient["recordExecution"]>[1]) {
    return this.guard.recordExecution(id, exec);
  }
}

/** Agent running as a separate process, talking to apps/api. */
export class HttpGuardClient implements GuardClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null = null,
  ) {}
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error ?? "error"}`);
    return json;
  }
  check(proposal: unknown) {
    return this.call<Decision>("POST", "/v1/check", proposal);
  }
  getDecision(id: string) {
    return this.call<Decision>("GET", `/v1/decisions/${encodeURIComponent(id)}`);
  }
  async findChild(parentId: string) {
    const list = await this.call<{ decisions: Decision[] }>("GET", `/v1/decisions?parent_id=${encodeURIComponent(parentId)}`);
    return list.decisions[0] ?? null;
  }
  recordExecution(id: string, exec: Parameters<GuardClient["recordExecution"]>[1]) {
    return this.call<Decision>("POST", `/v1/decisions/${encodeURIComponent(id)}/execution`, exec);
  }
}

/** Submits authorizations to the local vault simulator as the agent account. */
export class SimExecutor implements Executor {
  readonly name = "simulator";
  constructor(
    private readonly vault: VaultSimulator,
    private readonly agentAccount: string,
  ) {}
  async requestPayment(a: GuardAuthorization): Promise<ExecutionResult> {
    try {
      const out = this.vault.requestPayment(this.agentAccount, {
        mandate_id: a.mandate_id,
        receiver: a.receiver,
        amount_yocto: a.amount_yocto,
        nonce: a.nonce,
        expires_at_ms: a.expires_at_ms,
        input_hash: a.input_hash,
        signature: a.signature,
      });
      if (out.kind === "pending") return { status: "pending_onchain_approval", tx_hash: null, error: null, request_id: out.request_id };
      if (out.kind === "transfer_failed") return { status: "failed", tx_hash: out.tx_hash, error: "TRANSFER_FAILED: receiver does not exist, budget released" };
      return { status: "success", tx_hash: out.tx_hash, error: null };
    } catch (e) {
      if (e instanceof VaultError) return { status: "failed", tx_hash: null, error: e.code };
      throw e;
    }
  }
}
