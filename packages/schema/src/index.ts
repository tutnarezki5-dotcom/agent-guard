/**
 * Shared data contracts for AgentGuard.
 *
 * Every part of the system (agent, Policy Engine, API, vault simulator, UI)
 * speaks these types. Amounts are always strings of yoctoNEAR
 * (1 NEAR = 10^24 yocto) and are parsed with BigInt — never floats.
 *
 * The validators are hand-written and dependency-free on purpose: the
 * security-critical path has no third-party code in it.
 */

export const YOCTO_PER_NEAR = 10n ** 24n;

export type Verdict = "allow" | "warn" | "block";
export type ActionType = "transfer";
export type Category = "api_access" | "compute" | "data" | "agent_service" | "dev_services" | "other";
export const CATEGORIES: readonly Category[] = ["api_access", "compute", "data", "agent_service", "dev_services", "other"];

/** Where the receiver address in a proposal came from. Set by the agent runtime, never by the model. */
export type Provenance = "mandate" | "user" | "tool_output" | "model";

/** Owner-wide rules that apply to every mandate. */
export interface Policy {
  version: number;
  allowed_actions: ActionType[];
  /** Hard cap for any single payment, regardless of mandate. */
  global_per_tx_max_yocto: string;
  /** Risk score at or above which a payment is blocked. 0–100. */
  risk_block_at: number;
  /** Risk score at or above which a payment needs the owner. 0–100. */
  risk_warn_at: number;
  frozen: boolean;
}

/** Budget and permissions for one task. */
export interface Mandate {
  id: string;
  goal: string;
  budget_yocto: string;
  per_tx_max_yocto: string;
  /** ISO-8601 UTC. */
  expires_at: string;
  allowed_categories: Category[];
  /** Exact NEAR account ids. Empty list = no receiver is allowed. */
  allowed_receivers: string[];
  /** Payments at or above this amount need the owner's approval in AgentGuard. */
  approval_threshold_yocto: string;
  revoked: boolean;
}

/** What the agent wants to do. Produced by the LLM through a tool call. */
export interface ActionProposal {
  mandate_id: string;
  action: ActionType;
  receiver: string;
  amount_yocto: string;
  category: Category;
  /** Free text from the model. Stored for the journal, NEVER read by the Policy Engine. */
  justification: string;
  provenance: Provenance;
}

/** Spending state of one mandate at decision time. */
export interface MandateState {
  /** Settled on chain. */
  spent_yocto: string;
  /** Allowed by AgentGuard, signature issued, not yet settled or expired. */
  reserved_yocto: string;
}

export interface RiskSignal {
  name: string;
  value: string | number | boolean | null;
  /** Points added to the risk score, 0–100 in total. */
  points: number;
  detail: string;
}

export interface RiskReport {
  account: string;
  score: number;
  level: "low" | "medium" | "high";
  blocklisted: boolean;
  signals: RiskSignal[];
  /** ISO-8601, when the facts were fetched. Part of the snapshot so replay is exact. */
  observed_at: string;
}

export interface RuleHit {
  rule: string;
  ok: boolean;
  /** What happens when this rule fails. */
  severity: "block" | "warn" | "info";
  detail: string;
}

/** Everything the Policy Engine needs. Stored verbatim so a decision can be replayed. */
export interface DecisionInput {
  policy: Policy;
  mandate: Mandate | null;
  proposal: ActionProposal;
  state: MandateState;
  risk: RiskReport;
  /** ISO-8601 decision time. The engine never reads the clock itself. */
  now: string;
  /** True when the owner explicitly approved this exact proposal. Satisfies `warn` rules only — never `block` rules. */
  owner_approved?: boolean;
}

export interface EvaluationResult {
  verdict: Verdict;
  rule_hits: RuleHit[];
  /** Human-readable reasons for the failed rules, most severe first. */
  reasons: string[];
}

/** Authorization handed to the agent on `allow`. The vault contract checks it. */
export interface GuardAuthorization {
  contract_id: string;
  mandate_id: string;
  receiver: string;
  amount_yocto: string;
  nonce: number;
  /** Unix milliseconds. */
  expires_at_ms: number;
  input_hash: string;
  /** Exact bytes that were signed (UTF-8). */
  message: string;
  /** Base64 ed25519 signature over `message`. */
  signature: string;
  guard_public_key: string;
}

export interface Decision extends EvaluationResult {
  decision_id: string;
  /** Set on the decision created when the owner approves a `warn`. */
  parent_decision_id: string | null;
  created_at: string;
  input: DecisionInput;
  input_hash: string;
  authorization: GuardAuthorization | null;
  /** For `warn`: pending until the owner decides. */
  approval: "not_required" | "pending" | "approved" | "rejected";
  execution: ExecutionRecord | null;
}

export interface ExecutionRecord {
  status: "success" | "failed" | "pending_onchain_approval";
  tx_hash: string | null;
  error: string | null;
  at: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid input: ${issues.join("; ")}`);
    this.name = "ValidationError";
  }
}

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isAccountId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT_RE.test(v);
}

export function isYocto(v: unknown): v is string {
  return typeof v === "string" && /^(0|[1-9]\d{0,39})$/.test(v);
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);
}

function obj(v: unknown, issues: string[], label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    issues.push(`${label} must be an object`);
    return {};
  }
  return v as Record<string, unknown>;
}

/**
 * Validate a proposal coming from the model. Unknown fields are dropped:
 * only the fields below ever reach the Policy Engine.
 */
export function parseProposal(raw: unknown): ActionProposal {
  const issues: string[] = [];
  const o = obj(raw, issues, "proposal");
  if (typeof o.mandate_id !== "string" || o.mandate_id.length === 0) issues.push("mandate_id is required");
  if (o.action !== "transfer") issues.push("action must be 'transfer'");
  if (!isAccountId(o.receiver)) issues.push("receiver must be a valid NEAR account id");
  if (!isYocto(o.amount_yocto)) issues.push("amount_yocto must be a non-negative integer string");
  if (typeof o.category !== "string" || !CATEGORIES.includes(o.category as Category)) issues.push(`category must be one of ${CATEGORIES.join(", ")}`);
  const provenance = (o.provenance ?? "model") as Provenance;
  if (!["mandate", "user", "tool_output", "model"].includes(provenance)) issues.push("provenance is invalid");
  if (issues.length) throw new ValidationError(issues);
  return {
    mandate_id: o.mandate_id as string,
    action: "transfer",
    receiver: o.receiver as string,
    amount_yocto: o.amount_yocto as string,
    category: o.category as Category,
    justification: typeof o.justification === "string" ? o.justification.slice(0, 2000) : "",
    provenance,
  };
}

export function parseMandate(raw: unknown): Mandate {
  const issues: string[] = [];
  const o = obj(raw, issues, "mandate");
  if (typeof o.id !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(o.id)) issues.push("id must be 1–64 chars of [a-zA-Z0-9_.-]");
  if (typeof o.goal !== "string" || o.goal.length === 0) issues.push("goal is required");
  for (const k of ["budget_yocto", "per_tx_max_yocto", "approval_threshold_yocto"] as const) {
    if (!isYocto(o[k])) issues.push(`${k} must be a non-negative integer string`);
  }
  if (!isIsoDate(o.expires_at)) issues.push("expires_at must be an ISO-8601 date");
  if (!Array.isArray(o.allowed_categories) || !o.allowed_categories.every((c) => CATEGORIES.includes(c as Category))) issues.push("allowed_categories is invalid");
  if (!Array.isArray(o.allowed_receivers) || !o.allowed_receivers.every(isAccountId)) issues.push("allowed_receivers must be NEAR account ids");
  if (issues.length === 0 && BigInt(o.per_tx_max_yocto as string) > BigInt(o.budget_yocto as string)) issues.push("per_tx_max_yocto cannot exceed budget_yocto");
  if (issues.length) throw new ValidationError(issues);
  return {
    id: o.id as string,
    goal: o.goal as string,
    budget_yocto: o.budget_yocto as string,
    per_tx_max_yocto: o.per_tx_max_yocto as string,
    expires_at: new Date(o.expires_at as string).toISOString(),
    allowed_categories: [...(o.allowed_categories as Category[])],
    allowed_receivers: [...(o.allowed_receivers as string[])],
    approval_threshold_yocto: o.approval_threshold_yocto as string,
    revoked: o.revoked === true,
  };
}

// ---------------------------------------------------------------------------
// Amount helpers
// ---------------------------------------------------------------------------

/** "1.25" NEAR → yocto string. Exact; no floating point. */
export function nearToYocto(near: string): string {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(near.trim());
  if (!m) throw new Error(`not a NEAR amount: ${near}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(24, "0"));
  return (whole * YOCTO_PER_NEAR + frac).toString();
}

/** yocto string → "1.25" (trailing zeros trimmed). */
export function yoctoToNear(yocto: string | bigint): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO_PER_NEAR;
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
