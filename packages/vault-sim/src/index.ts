import { randomBytes } from "node:crypto";
import { authorizationMessage, verifyMessage } from "../../guard/src/signer.ts";

/**
 * Local simulator of the AgentGuard vault contract and of the two NEAR
 * protocol rules the demo relies on.
 *
 * `request_payment` mirrors contracts/vault-core/src/lib.rs line for line:
 * same checks, same order, same error codes. It exists so the whole demo
 * runs offline in seconds. On testnet the real contract replaces it
 * (EXECUTOR=testnet).
 */

export type VaultErrorCode =
  | "ERR_NOT_OWNER"
  | "ERR_NOT_AGENT"
  | "ERR_FROZEN"
  | "ERR_NO_MANDATE"
  | "ERR_MANDATE_EXISTS"
  | "ERR_MANDATE_REVOKED"
  | "ERR_MANDATE_EXPIRED"
  | "ERR_AUTH_EXPIRED"
  | "ERR_NONCE_USED"
  | "ERR_BAD_SIGNATURE"
  | "ERR_RECEIVER_NOT_ALLOWED"
  | "ERR_PER_TX_LIMIT"
  | "ERR_BUDGET_EXCEEDED"
  | "ERR_INSUFFICIENT_BALANCE"
  | "ERR_INVALID_MANDATE"
  | "ERR_NO_PENDING_REQUEST";

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode | ProtocolErrorCode) {
    super(code);
    this.name = "VaultError";
  }
}

export interface SimMandate {
  budget: bigint;
  per_tx_max: bigint;
  expires_at_ms: number;
  allowed_receivers: string[];
  onchain_approval_threshold: bigint;
  committed: bigint;
  revoked: boolean;
}

export interface PaymentArgs {
  mandate_id: string;
  receiver: string;
  amount_yocto: string;
  nonce: number;
  expires_at_ms: number;
  input_hash: string;
  signature: string;
}

export type PaymentOutcome =
  | { kind: "transfer"; tx_hash: string; receiver: string; amount: bigint }
  | { kind: "transfer_failed"; tx_hash: string; receiver: string; amount: bigint }
  | { kind: "pending"; request_id: number };

export interface VaultEvent {
  event: string;
  data: Record<string, unknown>;
  at_ms: number;
}

export class VaultSimulator {
  frozen = false;
  readonly mandates = new Map<string, SimMandate>();
  readonly usedNonces = new Set<number>();
  readonly pending = new Map<number, { mandate_id: string; receiver: string; amount: bigint; input_hash: string }>();
  readonly events: VaultEvent[] = [];
  readonly balances = new Map<string, bigint>();
  private nextRequestId = 1;

  constructor(
    readonly contractId: string,
    readonly owner: string,
    readonly agent: string,
    readonly guardPublicKey: string,
    /** Accounts that exist on the simulated chain; transfers to others fail and are released. */
    readonly existingAccounts: Set<string>,
    private readonly clock: () => number = () => Date.now(),
    vaultBalance = 100n * 10n ** 24n,
  ) {
    this.balances.set(contractId, vaultBalance);
  }

  private emit(event: string, data: Record<string, unknown>) {
    this.events.push({ event, data, at_ms: this.clock() });
  }

  private onlyOwner(caller: string) {
    if (caller !== this.owner) throw new VaultError("ERR_NOT_OWNER");
  }

  createMandate(caller: string, id: string, m: Omit<SimMandate, "committed" | "revoked">) {
    this.onlyOwner(caller);
    if (this.mandates.has(id)) throw new VaultError("ERR_MANDATE_EXISTS");
    if (!id || id.includes("|") || m.per_tx_max > m.budget) throw new VaultError("ERR_INVALID_MANDATE");
    this.mandates.set(id, { ...m, allowed_receivers: [...m.allowed_receivers], committed: 0n, revoked: false });
    this.emit("mandate_created", { id, budget: m.budget.toString() });
  }

  revokeMandate(caller: string, id: string) {
    this.onlyOwner(caller);
    const m = this.mandates.get(id);
    if (!m) throw new VaultError("ERR_NO_MANDATE");
    m.revoked = true;
  }

  setFrozen(caller: string, frozen: boolean) {
    this.onlyOwner(caller);
    this.frozen = frozen;
    this.emit(frozen ? "frozen" : "unfrozen", {});
  }

  /** Mirrors `VaultState::request_payment` in vault-core. Keep the order identical. */
  requestPayment(caller: string, a: PaymentArgs): PaymentOutcome {
    const now = this.clock();
    if (caller !== this.agent) throw new VaultError("ERR_NOT_AGENT");
    if (this.frozen) throw new VaultError("ERR_FROZEN");
    const m = this.mandates.get(a.mandate_id);
    if (!m) throw new VaultError("ERR_NO_MANDATE");
    if (m.revoked) throw new VaultError("ERR_MANDATE_REVOKED");
    if (now >= m.expires_at_ms) throw new VaultError("ERR_MANDATE_EXPIRED");
    if (now > a.expires_at_ms) throw new VaultError("ERR_AUTH_EXPIRED");
    if (this.usedNonces.has(a.nonce)) throw new VaultError("ERR_NONCE_USED");
    const msg = authorizationMessage({ contract_id: this.contractId, mandate_id: a.mandate_id, receiver: a.receiver, amount_yocto: a.amount_yocto, nonce: a.nonce, expires_at_ms: a.expires_at_ms, input_hash: a.input_hash });
    if (!a.signature || !verifyMessage(msg, a.signature, this.guardPublicKey)) throw new VaultError("ERR_BAD_SIGNATURE");
    if (!m.allowed_receivers.includes(a.receiver)) throw new VaultError("ERR_RECEIVER_NOT_ALLOWED");
    const amount = BigInt(a.amount_yocto);
    if (amount === 0n || amount > m.per_tx_max) throw new VaultError("ERR_PER_TX_LIMIT");
    const newCommitted = m.committed + amount;
    if (newCommitted > m.budget) throw new VaultError("ERR_BUDGET_EXCEEDED");
    const balance = this.balances.get(this.contractId) ?? 0n;
    if (amount > balance) throw new VaultError("ERR_INSUFFICIENT_BALANCE");
    const needsOwner = m.onchain_approval_threshold > 0n && amount >= m.onchain_approval_threshold;

    this.usedNonces.add(a.nonce);
    m.committed = newCommitted;
    if (needsOwner) {
      const id = this.nextRequestId++;
      this.pending.set(id, { mandate_id: a.mandate_id, receiver: a.receiver, amount, input_hash: a.input_hash });
      this.emit("pending", { request_id: id, mandate_id: a.mandate_id, amount: amount.toString() });
      return { kind: "pending", request_id: id };
    }
    this.emit("payment", { mandate_id: a.mandate_id, receiver: a.receiver, amount: amount.toString(), nonce: a.nonce, input_hash: a.input_hash });
    return this.transfer(a.mandate_id, a.receiver, amount);
  }

  approve(caller: string, requestId: number): PaymentOutcome {
    this.onlyOwner(caller);
    if (this.frozen) throw new VaultError("ERR_FROZEN");
    const p = this.pending.get(requestId);
    if (!p) throw new VaultError("ERR_NO_PENDING_REQUEST");
    this.pending.delete(requestId);
    this.emit("approved", { request_id: requestId });
    return this.transfer(p.mandate_id, p.receiver, p.amount);
  }

  reject(caller: string, requestId: number) {
    this.onlyOwner(caller);
    const p = this.pending.get(requestId);
    if (!p) throw new VaultError("ERR_NO_PENDING_REQUEST");
    this.pending.delete(requestId);
    this.release(p.mandate_id, p.amount);
    this.emit("rejected", { request_id: requestId });
  }

  private release(mandateId: string, amount: bigint) {
    const m = this.mandates.get(mandateId);
    if (m) m.committed = m.committed > amount ? m.committed - amount : 0n;
  }

  /** Transfer + callback, as in the contract: a failed transfer releases the budget. */
  private transfer(mandateId: string, receiver: string, amount: bigint): PaymentOutcome {
    const tx_hash = `sim-${randomBytes(16).toString("hex")}`;
    if (!this.existingAccounts.has(receiver)) {
      this.release(mandateId, amount);
      this.emit("transfer_failed", { mandate_id: mandateId, amount: amount.toString() });
      return { kind: "transfer_failed", tx_hash, receiver, amount };
    }
    this.balances.set(this.contractId, (this.balances.get(this.contractId) ?? 0n) - amount);
    this.balances.set(receiver, (this.balances.get(receiver) ?? 0n) + amount);
    return { kind: "transfer", tx_hash, receiver, amount };
  }

  remaining(mandateId: string): bigint | null {
    const m = this.mandates.get(mandateId);
    return m ? m.budget - m.committed : null;
  }
}

// ---------------------------------------------------------------------------
// NEAR protocol model: access keys
// ---------------------------------------------------------------------------

export type ProtocolErrorCode = "PROTOCOL_ACTION_NOT_PERMITTED" | "PROTOCOL_RECEIVER_MISMATCH" | "PROTOCOL_METHOD_NOT_ALLOWED" | "PROTOCOL_DEPOSIT_WITH_FUNCTION_CALL_KEY";

export type AccessKey = { kind: "full_access" } | { kind: "function_call"; receiver_id: string; method_names: string[] };

export type Action = { type: "Transfer"; deposit: bigint } | { type: "FunctionCall"; method: string; args: unknown; deposit: bigint } | { type: "AddKey" } | { type: "DeleteAccount" };

/**
 * The rule from docs.near.org/protocol/accounts-contracts/access-keys that
 * scenario 11 depends on: a function-call key can only sign a single
 * FunctionCall to its receiver, to an allowed method, with no deposit.
 * Modelled here for the offline demo; `pnpm attack:fc-transfer` shows the
 * real network refusing the same transaction.
 */
export function checkAccessKey(key: AccessKey, receiverId: string, actions: Action[]): void {
  if (key.kind === "full_access") return;
  if (actions.length !== 1 || actions[0]!.type !== "FunctionCall") throw new VaultError("PROTOCOL_ACTION_NOT_PERMITTED");
  const a = actions[0]!;
  if (receiverId !== key.receiver_id) throw new VaultError("PROTOCOL_RECEIVER_MISMATCH");
  if (key.method_names.length > 0 && !key.method_names.includes(a.method)) throw new VaultError("PROTOCOL_METHOD_NOT_ALLOWED");
  if (a.deposit > 0n) throw new VaultError("PROTOCOL_DEPOSIT_WITH_FUNCTION_CALL_KEY");
}
