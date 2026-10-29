import type { DecisionInput, EvaluationResult, RuleHit, Verdict } from "../../schema/src/index.ts";
import { yoctoToNear } from "../../schema/src/index.ts";

/**
 * The Policy Engine.
 *
 * A pure, deterministic function: same input → same verdict and the same
 * list of rule hits, byte for byte. It never reads the clock, the network
 * or `proposal.justification` (the model's own words). That last point is
 * what makes prompt injection powerless here: no text the model writes can
 * change a formal rule.
 *
 * Verdict: any failed `block` rule → block; else any failed `warn` rule →
 * warn; else allow.
 */
export function evaluate(input: DecisionInput): EvaluationResult {
  const { policy, mandate, proposal, state, risk } = input;
  const now = Date.parse(input.now);
  const hits: RuleHit[] = [];
  const add = (rule: string, ok: boolean, severity: RuleHit["severity"], detail: string) => hits.push({ rule, ok, severity, detail });

  const amount = BigInt(proposal.amount_yocto);
  const near = (v: bigint | string) => `${yoctoToNear(v)} NEAR`;

  // --- Owner-wide policy -----------------------------------------------------
  add("policy.not_frozen", !policy.frozen, "block", policy.frozen ? "The owner froze all payments" : "Payments are not frozen");
  add(
    "policy.action_allowed",
    policy.allowed_actions.includes(proposal.action),
    "block",
    `Action "${proposal.action}" is ${policy.allowed_actions.includes(proposal.action) ? "allowed" : "not allowed"} by the policy`,
  );
  add("amount.positive", amount > 0n, "block", amount > 0n ? `Amount ${near(amount)}` : "Amount must be greater than zero");
  const globalMax = BigInt(policy.global_per_tx_max_yocto);
  add(
    "policy.global_per_tx",
    amount <= globalMax,
    "block",
    `${near(amount)} ${amount <= globalMax ? "≤" : ">"} global per-payment limit ${near(globalMax)}`,
  );

  // --- Mandate -------------------------------------------------------------
  if (!mandate) {
    add("mandate.exists", false, "block", `Mandate "${proposal.mandate_id}" not found`);
  } else {
    add("mandate.exists", true, "block", `Mandate "${mandate.id}": ${mandate.goal}`);
    add("mandate.not_revoked", !mandate.revoked, "block", mandate.revoked ? "The owner revoked the mandate" : "Mandate is active");
    const expires = Date.parse(mandate.expires_at);
    add("mandate.not_expired", now < expires, "block", now < expires ? `Valid until ${mandate.expires_at}` : `Mandate expired at ${mandate.expires_at}`);

    const catOk = mandate.allowed_categories.includes(proposal.category);
    add("mandate.category_allowed", catOk, "block", `Category "${proposal.category}" is ${catOk ? "" : "not "}in the mandate (${mandate.allowed_categories.join(", ") || "none"})`);

    const rcvOk = mandate.allowed_receivers.includes(proposal.receiver);
    add(
      "mandate.receiver_allowed",
      rcvOk,
      "block",
      rcvOk ? `${proposal.receiver} is on the mandate's receiver list` : `${proposal.receiver} is not on the mandate's receiver list`,
    );
    if (!rcvOk && proposal.provenance === "tool_output") {
      // Informational: explains *why* the agent proposed an unknown address.
      add("provenance.untrusted_receiver", false, "info", "The receiver address came from an external tool output, a sign of prompt injection");
    }

    const perTx = BigInt(mandate.per_tx_max_yocto);
    add("mandate.per_tx", amount <= perTx, "block", `${near(amount)} ${amount <= perTx ? "≤" : ">"} mandate per-payment limit ${near(perTx)}`);

    const budget = BigInt(mandate.budget_yocto);
    const used = BigInt(state.spent_yocto) + BigInt(state.reserved_yocto);
    const remaining = budget > used ? budget - used : 0n;
    const budgetOk = amount <= remaining;
    add(
      "mandate.budget_remaining",
      budgetOk,
      "block",
      `${near(amount)} of ${near(remaining)} remaining (budget ${near(budget)}, spent ${near(state.spent_yocto)}, reserved ${near(state.reserved_yocto)})`,
    );

    const threshold = BigInt(mandate.approval_threshold_yocto);
    const needsHuman = threshold > 0n && amount >= threshold;
    add(
      "mandate.approval_threshold",
      !needsHuman,
      "warn",
      needsHuman ? `${near(amount)} ≥ approval threshold ${near(threshold)}, owner must approve` : `Below approval threshold ${near(threshold)}`,
    );
  }

  // --- Counterparty risk ---------------------------------------------------
  add("risk.not_blocklisted", !risk.blocklisted, "block", risk.blocklisted ? `${risk.account} is on the shared blocklist` : `${risk.account} is not on the blocklist`);
  const riskBlock = risk.score >= policy.risk_block_at;
  const riskWarn = !riskBlock && risk.score >= policy.risk_warn_at;
  add("risk.score_below_block", !riskBlock, "block", `Receiver risk ${risk.score}/100 (block at ${policy.risk_block_at})`);
  add("risk.score_below_warn", !riskWarn, "warn", `Receiver risk ${risk.score}/100 (review at ${policy.risk_warn_at})`);

  // --- Verdict ---------------------------------------------------------------
  if (input.owner_approved) {
    add("owner.approved", true, "info", "The owner approved this payment: warn rules are satisfied, block rules were checked again");
  }
  const failed = hits.filter((h) => !h.ok);
  const warnFailed = failed.some((h) => h.severity === "warn") && !input.owner_approved;
  const verdict: Verdict = failed.some((h) => h.severity === "block") ? "block" : warnFailed ? "warn" : "allow";
  const order = { block: 0, warn: 1, info: 2 } as const;
  const reasons = [...failed].sort((a, b) => order[a.severity] - order[b.severity]).map((h) => h.detail);

  return { verdict, rule_hits: hits, reasons };
}
