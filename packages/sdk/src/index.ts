import type { Decision, GuardAuthorization } from "../../schema/src/index.ts";

/**
 * Agent-side wrapper. The agent runtime calls `guardedPay` instead of
 * touching the vault directly:
 *
 *   block → refuse, never sign
 *   warn  → wait for the owner (or return, if the caller prefers)
 *   allow → submit the AgentGuard authorization to the vault, record the result
 */

/** How the agent reaches AgentGuard: in-process or over HTTP. */
export interface GuardClient {
  check(proposal: unknown): Promise<Decision>;
  getDecision(id: string): Promise<Decision>;
  /** Decisions created from an owner's answer to `parentId`. */
  findChild(parentId: string): Promise<Decision | null>;
  recordExecution(decisionId: string, exec: { status: "success" | "failed" | "pending_onchain_approval"; tx_hash: string | null; error: string | null }): Promise<Decision>;
}

export interface ExecutionResult {
  status: "success" | "failed" | "pending_onchain_approval";
  tx_hash: string | null;
  error: string | null;
  request_id?: number;
}

/** How an authorization reaches the chain: simulator or real testnet contract. */
export interface Executor {
  readonly name: string;
  requestPayment(auth: GuardAuthorization): Promise<ExecutionResult>;
}

export interface GuardedPayOptions {
  guard: GuardClient;
  executor: Executor;
  /** "wait" polls until the owner answers; "return" hands the warn back to the caller. Default "wait". */
  onWarn?: "wait" | "return";
  waitTimeoutMs?: number;
  pollMs?: number;
}

export type GuardedPayResult =
  | { status: "blocked"; decision: Decision }
  | { status: "awaiting_owner"; decision: Decision }
  | { status: "rejected_by_owner"; decision: Decision }
  | { status: "executed"; decision: Decision; execution: ExecutionResult };

export class BlockedError extends Error {
  constructor(readonly decision: Decision) {
    super(`AgentGuard blocked the payment: ${decision.reasons.join("; ")}`);
    this.name = "BlockedError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function guardedPay(proposal: unknown, o: GuardedPayOptions): Promise<GuardedPayResult> {
  let decision = await o.guard.check(proposal);

  if (decision.verdict === "block") return { status: "blocked", decision };

  if (decision.verdict === "warn") {
    if ((o.onWarn ?? "wait") === "return") return { status: "awaiting_owner", decision };
    const deadline = Date.now() + (o.waitTimeoutMs ?? 10 * 60_000);
    for (;;) {
      const current = await o.guard.getDecision(decision.decision_id);
      if (current.approval === "rejected") return { status: "rejected_by_owner", decision: current };
      if (current.approval === "approved") {
        const child = await o.guard.findChild(current.decision_id);
        if (!child) throw new Error("approved decision has no follow-up decision");
        if (child.verdict !== "allow") return { status: "blocked", decision: child };
        decision = child;
        break;
      }
      if (Date.now() > deadline) return { status: "awaiting_owner", decision: current };
      await sleep(o.pollMs ?? 1000);
    }
  }

  // verdict === "allow": the only path that reaches the chain.
  if (!decision.authorization) throw new Error("allow decision without authorization");
  let execution: ExecutionResult;
  try {
    execution = await o.executor.requestPayment(decision.authorization);
  } catch (e) {
    execution = { status: "failed", tx_hash: null, error: e instanceof Error ? e.message : String(e) };
  }
  const recorded = await o.guard.recordExecution(decision.decision_id, { status: execution.status, tx_hash: execution.tx_hash, error: execution.error });
  return { status: "executed", decision: recorded, execution };
}
