import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, Mandate, MandateState, Policy } from "../../schema/src/index.ts";
import type { BlocklistEntry } from "../../risk/src/index.ts";

/**
 * Storage for AgentGuard. The MVP keeps everything in memory and, when a
 * file path is given, writes a JSON snapshot after every change. The
 * interface is small on purpose so a PostgreSQL implementation can replace
 * it without touching the Guard.
 */
export interface GuardStore {
  getPolicy(): Policy;
  setPolicy(p: Policy): void;
  getMandate(id: string): Mandate | null;
  putMandate(m: Mandate): void;
  listMandates(): Mandate[];
  addDecision(d: Decision): void;
  getDecision(id: string): Decision | null;
  updateDecision(d: Decision): void;
  listDecisions(filter?: { mandate_id?: string }): Decision[];
  nextNonce(): number;
  listBlocklist(): BlocklistEntry[];
  putBlocklist(e: BlocklistEntry): void;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  allowed_actions: ["transfer"],
  global_per_tx_max_yocto: "5000000000000000000000000", // 5 NEAR
  risk_block_at: 70,
  risk_warn_at: 40,
  frozen: false,
};

interface Snapshot {
  policy: Policy;
  mandates: Mandate[];
  decisions: Decision[];
  nonce: number;
  blocklist: BlocklistEntry[];
}

export class MemoryStore implements GuardStore {
  private policy: Policy;
  private readonly mandates = new Map<string, Mandate>();
  private readonly decisions = new Map<string, Decision>();
  private nonce = 0;
  private readonly blocklist = new Map<string, BlocklistEntry>();

  constructor(private readonly file: string | null = null, policy: Policy = DEFAULT_POLICY) {
    this.policy = structuredClone(policy);
    if (file && existsSync(file)) {
      const s = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
      this.policy = s.policy;
      for (const m of s.mandates) this.mandates.set(m.id, m);
      for (const d of s.decisions) this.decisions.set(d.decision_id, d);
      for (const b of s.blocklist ?? []) this.blocklist.set(b.account, b);
      this.nonce = s.nonce;
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const snap: Snapshot = { policy: this.policy, mandates: [...this.mandates.values()], decisions: [...this.decisions.values()], nonce: this.nonce, blocklist: [...this.blocklist.values()] };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap, null, 2));
    renameSync(tmp, this.file);
  }

  getPolicy() {
    return structuredClone(this.policy);
  }
  setPolicy(p: Policy) {
    this.policy = structuredClone(p);
    this.persist();
  }
  getMandate(id: string) {
    const m = this.mandates.get(id);
    return m ? structuredClone(m) : null;
  }
  putMandate(m: Mandate) {
    this.mandates.set(m.id, structuredClone(m));
    this.persist();
  }
  listMandates() {
    return [...this.mandates.values()].map((m) => structuredClone(m));
  }
  addDecision(d: Decision) {
    if (this.decisions.has(d.decision_id)) throw new Error(`duplicate decision ${d.decision_id}`);
    this.decisions.set(d.decision_id, structuredClone(d));
    this.persist();
  }
  getDecision(id: string) {
    const d = this.decisions.get(id);
    return d ? structuredClone(d) : null;
  }
  updateDecision(d: Decision) {
    if (!this.decisions.has(d.decision_id)) throw new Error(`unknown decision ${d.decision_id}`);
    this.decisions.set(d.decision_id, structuredClone(d));
    this.persist();
  }
  listDecisions(filter: { mandate_id?: string } = {}) {
    return [...this.decisions.values()]
      .filter((d) => !filter.mandate_id || d.input.proposal.mandate_id === filter.mandate_id)
      .map((d) => structuredClone(d));
  }
  nextNonce() {
    this.nonce += 1;
    this.persist();
    return this.nonce;
  }
  listBlocklist() {
    return [...this.blocklist.values()];
  }
  putBlocklist(e: BlocklistEntry) {
    this.blocklist.set(e.account, e);
    this.persist();
  }
}

/**
 * Spending state of a mandate, derived from the decision journal:
 * - spent: executions that succeeded;
 * - reserved: authorizations issued, not executed, not yet expired.
 * Deriving it (instead of keeping counters) means it can never drift.
 */
export function mandateState(store: GuardStore, mandateId: string, nowMs: number): MandateState {
  let spent = 0n;
  let reserved = 0n;
  for (const d of store.listDecisions({ mandate_id: mandateId })) {
    if (!d.authorization) continue;
    const amount = BigInt(d.authorization.amount_yocto);
    if (d.execution?.status === "success" || d.execution?.status === "pending_onchain_approval") spent += amount;
    else if (!d.execution && d.authorization.expires_at_ms > nowMs) reserved += amount;
  }
  return { spent_yocto: spent.toString(), reserved_yocto: reserved.toString() };
}

export function priorPayments(store: GuardStore, receiver: string): number {
  return store.listDecisions().filter((d) => d.execution?.status === "success" && d.input.proposal.receiver === receiver).length;
}
