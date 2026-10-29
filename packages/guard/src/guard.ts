import { EventEmitter } from "node:events";
import type { Decision, DecisionInput, ExecutionRecord, GuardAuthorization, Mandate } from "../../schema/src/index.ts";
import { parseMandate, parseProposal } from "../../schema/src/index.ts";
import { evaluate, hashCanonical } from "../../policy-engine/src/index.ts";
import { scoreRisk, type AccountFacts, type BlocklistEntry, type FactsProvider } from "../../risk/src/index.ts";
import { authorizationMessage, type GuardSigner } from "./signer.ts";
import { mandateState, priorPayments, type GuardStore } from "./store.ts";

export interface GuardOptions {
  store: GuardStore;
  facts: FactsProvider;
  signer: GuardSigner;
  /** Account id of the vault contract the signatures are bound to. */
  contractId: string;
  /** How long an `allow` signature stays valid. */
  authorizationTtlMs?: number;
  clock?: () => Date;
}

interface Prepared {
  proposal: ReturnType<typeof parseProposal>;
  facts: AccountFacts;
  ownerApproved: boolean;
}

export type GuardEvent =
  | { type: "decision"; decision: Decision }
  | { type: "execution"; decision: Decision }
  | { type: "approval"; decision: Decision }
  | { type: "mandate"; mandate: Mandate }
  | { type: "policy" };

/**
 * AgentGuard service: turns an agent's proposal into a signed, replayable decision.
 *
 *   proposal ─► facts + risk ─► state ─► evaluate() ─► decision (+ signature on allow)
 *
 * The LLM never sees the signing key and never decides. It only proposes.
 */
export class Guard {
  readonly events = new EventEmitter();
  private readonly ttl: number;
  private readonly clock: () => Date;

  constructor(private readonly o: GuardOptions) {
    this.ttl = o.authorizationTtlMs ?? 120_000;
    this.clock = o.clock ?? (() => new Date());
  }

  get publicKey(): string {
    return this.o.signer.publicKeyNear;
  }
  get contractId(): string {
    return this.o.contractId;
  }
  get store(): GuardStore {
    return this.o.store;
  }

  private emit(e: GuardEvent) {
    this.events.emit("event", e);
  }

  createMandate(raw: unknown): Mandate {
    const m = parseMandate(raw);
    if (this.o.store.getMandate(m.id)) throw new Error(`mandate ${m.id} already exists`);
    this.o.store.putMandate(m);
    this.emit({ type: "mandate", mandate: m });
    return m;
  }

  revokeMandate(id: string): Mandate {
    const m = this.o.store.getMandate(id);
    if (!m) throw new Error(`mandate ${id} not found`);
    m.revoked = true;
    this.o.store.putMandate(m);
    this.emit({ type: "mandate", mandate: m });
    return m;
  }

  setFrozen(frozen: boolean): void {
    const p = this.o.store.getPolicy();
    p.frozen = frozen;
    p.version += 1;
    this.o.store.setPolicy(p);
    this.emit({ type: "policy" });
  }

  reportBlocklist(e: Omit<BlocklistEntry, "at">): BlocklistEntry {
    if (!e.evidence_url.startsWith("https://")) throw new Error("evidence_url must be an https link");
    if (e.reason.trim().length < 5) throw new Error("reason is too short");
    const entry = { ...e, at: this.clock().toISOString() };
    this.o.store.putBlocklist(entry);
    return entry;
  }

  /** The slow, async part: fetch facts about the receiver. */
  private async prepare(proposalRaw: unknown, ownerApproved: boolean): Promise<Prepared> {
    const proposal = parseProposal(proposalRaw);
    const facts = await this.o.facts.getFacts(proposal.receiver);
    return { proposal, facts, ownerApproved };
  }

  /**
   * The fast, synchronous part. Everything that can change between two
   * concurrent checks (policy, mandate, budget state, nonce) is read here,
   * and the decision is stored before this function returns. Node runs it
   * without interruption, so two concurrent proposals can never both spend
   * the same remaining budget.
   */
  private decide(p: Prepared, parent: string | null): Decision {
    const now = this.clock();
    const blocked = this.o.store.listBlocklist().find((b) => b.account === p.proposal.receiver) ?? null;
    const input: DecisionInput = {
      policy: this.o.store.getPolicy(),
      mandate: this.o.store.getMandate(p.proposal.mandate_id),
      proposal: p.proposal,
      state: mandateState(this.o.store, p.proposal.mandate_id, now.getTime()),
      risk: scoreRisk({ facts: p.facts, blocklist: blocked, prior_payments: priorPayments(this.o.store, p.proposal.receiver), now: now.toISOString() }),
      now: now.toISOString(),
    };
    if (p.ownerApproved) input.owner_approved = true;
    const result = evaluate(input);
    const input_hash = hashCanonical(input);
    let authorization: GuardAuthorization | null = null;
    if (result.verdict === "allow") {
      const fields = {
        contract_id: this.o.contractId,
        mandate_id: input.proposal.mandate_id,
        receiver: input.proposal.receiver,
        amount_yocto: input.proposal.amount_yocto,
        nonce: this.o.store.nextNonce(),
        expires_at_ms: Date.parse(input.now) + this.ttl,
        input_hash,
      };
      const message = authorizationMessage(fields);
      authorization = { ...fields, message, signature: this.o.signer.signMessage(message), guard_public_key: this.o.signer.publicKeyNear };
    }
    const decision: Decision = {
      decision_id: `d_${globalThis.crypto.randomUUID()}`,
      parent_decision_id: parent,
      created_at: input.now,
      ...result,
      input,
      input_hash,
      authorization,
      approval: result.verdict === "warn" ? "pending" : "not_required",
      execution: null,
    };
    this.o.store.addDecision(decision);
    this.emit({ type: "decision", decision });
    return decision;
  }

  /** Check one proposal. Returns allow (with signature), warn (awaiting owner) or block. */
  async check(proposalRaw: unknown): Promise<Decision> {
    return this.decide(await this.prepare(proposalRaw, false), null);
  }

  /**
   * Owner's answer to a `warn`. Approval re-evaluates the SAME proposal
   * against the CURRENT state: `warn` rules are satisfied by the approval,
   * `block` rules (budget, freeze, blocklist…) are checked again.
   */
  async resolveApproval(decisionId: string, approve: boolean): Promise<{ original: Decision; result: Decision | null }> {
    const original = this.o.store.getDecision(decisionId);
    if (!original) throw new Error(`decision ${decisionId} not found`);
    if (original.approval !== "pending") throw new Error(`decision ${decisionId} is not awaiting approval (${original.approval})`);
    original.approval = approve ? "approved" : "rejected";
    this.o.store.updateDecision(original);
    this.emit({ type: "approval", decision: original });
    if (!approve) return { original, result: null };
    const result = this.decide(await this.prepare(original.input.proposal, true), original.decision_id);
    return { original, result };
  }

  recordExecution(decisionId: string, exec: Omit<ExecutionRecord, "at">): Decision {
    const d = this.o.store.getDecision(decisionId);
    if (!d) throw new Error(`decision ${decisionId} not found`);
    if (!d.authorization) throw new Error(`decision ${decisionId} has no authorization to execute`);
    if (d.execution) throw new Error(`decision ${decisionId} was already executed`);
    d.execution = { ...exec, at: this.clock().toISOString() };
    this.o.store.updateDecision(d);
    this.emit({ type: "execution", decision: d });
    return d;
  }
}

export interface ReplayResult {
  decision_id: string;
  match: boolean;
  input_hash_match: boolean;
  verdict_match: boolean;
  rule_hits_match: boolean;
  stored_verdict: string;
  replayed_verdict: string;
  replayed_rule_hits_hash: string;
}

/**
 * Re-run the Policy Engine on the stored snapshot. Because the snapshot holds
 * everything the engine read (policy, mandate, state, risk facts, time), the
 * result must be identical. Any mismatch means the record or the engine changed.
 */
export function replay(d: Decision): ReplayResult {
  const again = evaluate(d.input);
  const input_hash_match = hashCanonical(d.input) === d.input_hash;
  const verdict_match = again.verdict === d.verdict;
  const hitsHash = hashCanonical(again.rule_hits);
  const rule_hits_match = hitsHash === hashCanonical(d.rule_hits);
  return {
    decision_id: d.decision_id,
    match: input_hash_match && verdict_match && rule_hits_match,
    input_hash_match,
    verdict_match,
    rule_hits_match,
    stored_verdict: d.verdict,
    replayed_verdict: again.verdict,
    replayed_rule_hits_hash: hitsHash,
  };
}
