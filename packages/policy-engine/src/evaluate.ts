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
  add("policy.not_frozen", !policy.frozen, "block", policy.frozen ? "Владелец заморозил все выплаты" : "Выплаты не заморожены");
  add(
    "policy.action_allowed",
    policy.allowed_actions.includes(proposal.action),
    "block",
    `Действие «${proposal.action}» ${policy.allowed_actions.includes(proposal.action) ? "разрешено" : "не разрешено"} политикой`,
  );
  add("amount.positive", amount > 0n, "block", amount > 0n ? `Сумма ${near(amount)}` : "Сумма должна быть больше нуля");
  const globalMax = BigInt(policy.global_per_tx_max_yocto);
  add(
    "policy.global_per_tx",
    amount <= globalMax,
    "block",
    `${near(amount)} ${amount <= globalMax ? "≤" : ">"} общего лимита на операцию ${near(globalMax)}`,
  );

  // --- Mandate -------------------------------------------------------------
  if (!mandate) {
    add("mandate.exists", false, "block", `Мандат «${proposal.mandate_id}» не найден`);
  } else {
    add("mandate.exists", true, "block", `Мандат «${mandate.id}»: ${mandate.goal}`);
    add("mandate.not_revoked", !mandate.revoked, "block", mandate.revoked ? "Мандат отозван владельцем" : "Мандат действует");
    const expires = Date.parse(mandate.expires_at);
    add("mandate.not_expired", now < expires, "block", now < expires ? `Действует до ${mandate.expires_at}` : `Срок мандата истёк ${mandate.expires_at}`);

    const catOk = mandate.allowed_categories.includes(proposal.category);
    add("mandate.category_allowed", catOk, "block", `Категория «${proposal.category}» ${catOk ? "входит" : "не входит"} в мандат (${mandate.allowed_categories.join(", ") || "пусто"})`);

    const rcvOk = mandate.allowed_receivers.includes(proposal.receiver);
    add(
      "mandate.receiver_allowed",
      rcvOk,
      "block",
      rcvOk ? `${proposal.receiver} есть в списке получателей мандата` : `${proposal.receiver} нет в списке получателей мандата`,
    );
    if (!rcvOk && proposal.provenance === "tool_output") {
      // Informational: explains *why* the agent proposed an unknown address.
      add("provenance.untrusted_receiver", false, "info", "Адрес получателя взят из ответа внешнего инструмента — признак prompt-injection");
    }

    const perTx = BigInt(mandate.per_tx_max_yocto);
    add("mandate.per_tx", amount <= perTx, "block", `${near(amount)} ${amount <= perTx ? "≤" : ">"} лимита мандата на операцию ${near(perTx)}`);

    const budget = BigInt(mandate.budget_yocto);
    const used = BigInt(state.spent_yocto) + BigInt(state.reserved_yocto);
    const remaining = budget > used ? budget - used : 0n;
    const budgetOk = amount <= remaining;
    add(
      "mandate.budget_remaining",
      budgetOk,
      "block",
      `${near(amount)} из оставшихся ${near(remaining)} (бюджет ${near(budget)}, потрачено ${near(state.spent_yocto)}, в резерве ${near(state.reserved_yocto)})`,
    );

    const threshold = BigInt(mandate.approval_threshold_yocto);
    const needsHuman = threshold > 0n && amount >= threshold;
    add(
      "mandate.approval_threshold",
      !needsHuman,
      "warn",
      needsHuman ? `${near(amount)} ≥ порога одобрения ${near(threshold)} — нужен владелец` : `Ниже порога одобрения ${near(threshold)}`,
    );
  }

  // --- Counterparty risk ---------------------------------------------------
  add("risk.not_blocklisted", !risk.blocklisted, "block", risk.blocklisted ? `${risk.account} в общем блоклисте` : `${risk.account} не в блоклисте`);
  const riskBlock = risk.score >= policy.risk_block_at;
  const riskWarn = !riskBlock && risk.score >= policy.risk_warn_at;
  add("risk.score_below_block", !riskBlock, "block", `Риск получателя ${risk.score}/100 (порог блокировки ${policy.risk_block_at})`);
  add("risk.score_below_warn", !riskWarn, "warn", `Риск получателя ${risk.score}/100 (порог проверки ${policy.risk_warn_at})`);

  // --- Verdict ---------------------------------------------------------------
  if (input.owner_approved) {
    add("owner.approved", true, "info", "Владелец одобрил эту операцию: правила уровня warn удовлетворены, правила уровня block проверены заново");
  }
  const failed = hits.filter((h) => !h.ok);
  const warnFailed = failed.some((h) => h.severity === "warn") && !input.owner_approved;
  const verdict: Verdict = failed.some((h) => h.severity === "block") ? "block" : warnFailed ? "warn" : "allow";
  const order = { block: 0, warn: 1, info: 2 } as const;
  const reasons = [...failed].sort((a, b) => order[a.severity] - order[b.severity]).map((h) => h.detail);

  return { verdict, rule_hits: hits, reasons };
}
