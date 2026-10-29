import type { RiskReport, RiskSignal } from "../../schema/src/index.ts";

/**
 * Risk Monitor: what do we know about the receiver before money moves?
 *
 * Facts come from a provider (public RPC + an indexer on testnet, or fixed
 * fixtures in tests and the local demo). Scoring is a pure function of the
 * facts, so the report can be stored in the decision snapshot and replayed.
 */

export interface AccountFacts {
  account: string;
  exists: boolean;
  is_contract: boolean;
  code_hash: string | null;
  /** ISO-8601; null when the source cannot tell. */
  created_at: string | null;
  tx_count: number | null;
  /** ISO-8601 of the last contract deploy; null when unknown or not a contract. */
  code_changed_at: string | null;
}

export interface FactsProvider {
  readonly name: string;
  getFacts(account: string): Promise<AccountFacts>;
}

export interface BlocklistEntry {
  account: string;
  reason: string;
  evidence_url: string;
  reported_by: string;
  at: string;
}

const DAY = 86_400_000;

/** Pure scoring. `now` is passed in; nothing here reads the clock. */
export function scoreRisk(params: {
  facts: AccountFacts;
  blocklist: BlocklistEntry | null;
  prior_payments: number;
  now: string;
}): RiskReport {
  const { facts, blocklist, prior_payments } = params;
  const now = Date.parse(params.now);
  const signals: RiskSignal[] = [];
  const sig = (name: string, value: RiskSignal["value"], points: number, detail: string) => signals.push({ name, value, points, detail });

  if (!facts.exists) {
    sig("account_exists", false, 60, "Аккаунт не существует в сети — перевод уйдёт в пустоту или на будущий адрес атакующего");
  } else {
    sig("account_exists", true, 0, "Аккаунт существует");
  }

  if (facts.created_at === null) {
    sig("account_age_days", null, 10, "Возраст аккаунта неизвестен");
  } else {
    const days = Math.floor((now - Date.parse(facts.created_at)) / DAY);
    const points = days < 1 ? 40 : days < 7 ? 25 : days < 30 ? 10 : 0;
    sig("account_age_days", days, points, `Аккаунту ${days} дн.`);
  }

  if (facts.tx_count === null) {
    sig("tx_count", null, 5, "История транзакций неизвестна");
  } else {
    sig("tx_count", facts.tx_count, facts.tx_count < 5 ? 15 : 0, `${facts.tx_count} транзакций в истории`);
  }

  if (facts.is_contract) {
    if (facts.code_changed_at === null) {
      sig("contract_code_changed_hours", null, 5, "Получатель — контракт, время последнего деплоя неизвестно");
    } else {
      const hours = Math.floor((now - Date.parse(facts.code_changed_at)) / 3_600_000);
      sig("contract_code_changed_hours", hours, hours < 24 ? 30 : 0, `Код контракта обновлён ${hours} ч назад`);
    }
  } else {
    sig("is_contract", false, 0, "Получатель — обычный аккаунт, не контракт");
  }

  sig(
    "prior_payments",
    prior_payments,
    prior_payments > 0 ? -15 : 0,
    prior_payments > 0 ? `${prior_payments} успешных платежей этому получателю раньше` : "Раньше платежей этому получателю не было",
  );

  if (blocklist) {
    sig("blocklisted", true, 100, `В блоклисте: ${blocklist.reason} (сообщил ${blocklist.reported_by})`);
  }

  const raw = signals.reduce((s, x) => s + x.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return { account: facts.account, score, level, blocklisted: blocklist !== null, signals, observed_at: params.now };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Fixed facts: tests, the local demo, and offline replay. */
export class StaticFactsProvider implements FactsProvider {
  readonly name = "static";
  constructor(private readonly facts: Record<string, Omit<AccountFacts, "account">>) {}
  async getFacts(account: string): Promise<AccountFacts> {
    const f = this.facts[account];
    if (!f) return { account, exists: false, is_contract: false, code_hash: null, created_at: null, tx_count: null, code_changed_at: null };
    return { account, ...f };
  }
}

const EMPTY_CODE_HASH = "11111111111111111111111111111111";

/**
 * Live facts from NEAR testnet/mainnet.
 * - `view_account` over public JSON-RPC: exists, contract or not.
 * - Optional indexer (NearBlocks-compatible) for age and tx count.
 *   Response shapes are parsed defensively; anything unreadable becomes
 *   `null` and costs a few "unknown" points instead of crashing.
 *   VERIFY the indexer endpoints against its current docs before relying on them.
 */
export class RpcFactsProvider implements FactsProvider {
  readonly name = "rpc";
  constructor(
    private readonly rpcUrl: string,
    private readonly indexerUrl: string | null = null,
  ) {}

  async getFacts(account: string): Promise<AccountFacts> {
    const base: AccountFacts = { account, exists: false, is_contract: false, code_hash: null, created_at: null, tx_count: null, code_changed_at: null };
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "agentguard", method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }),
    });
    const body = (await res.json()) as { result?: { code_hash?: string }; error?: { cause?: { name?: string } } };
    if (body.error) {
      if (body.error.cause?.name === "UNKNOWN_ACCOUNT") return base;
      throw new Error(`RPC error for ${account}: ${JSON.stringify(body.error)}`);
    }
    const codeHash = body.result?.code_hash ?? null;
    const facts: AccountFacts = { ...base, exists: true, code_hash: codeHash, is_contract: codeHash !== null && codeHash !== EMPTY_CODE_HASH };
    if (this.indexerUrl) Object.assign(facts, await this.indexerFacts(account));
    return facts;
  }

  private async indexerFacts(account: string): Promise<Partial<AccountFacts>> {
    const out: Partial<AccountFacts> = {};
    try {
      const r = await fetch(`${this.indexerUrl}/v1/account/${encodeURIComponent(account)}`);
      const j = (await r.json()) as { account?: Array<{ created?: { block_timestamp?: string | number } }> };
      const ts = j.account?.[0]?.created?.block_timestamp;
      if (ts !== undefined) out.created_at = new Date(Number(BigInt(ts) / 1_000_000n)).toISOString();
    } catch {
      /* unknown age */
    }
    try {
      const r = await fetch(`${this.indexerUrl}/v1/account/${encodeURIComponent(account)}/txns/count`);
      const j = (await r.json()) as { txns?: Array<{ count?: string | number }> };
      const c = j.txns?.[0]?.count;
      if (c !== undefined) out.tx_count = Number(c);
    } catch {
      /* unknown count */
    }
    return out;
  }
}

/** Shared blocklist other agents can report to. Evidence is mandatory. */
export class Blocklist {
  private readonly entries = new Map<string, BlocklistEntry>();
  constructor(initial: BlocklistEntry[] = []) {
    for (const e of initial) this.entries.set(e.account, e);
  }
  report(e: BlocklistEntry): BlocklistEntry {
    if (!e.evidence_url.startsWith("https://")) throw new Error("evidence_url must be an https link");
    if (e.reason.trim().length < 5) throw new Error("reason is too short");
    this.entries.set(e.account, e);
    return e;
  }
  get(account: string): BlocklistEntry | null {
    return this.entries.get(account) ?? null;
  }
  list(): BlocklistEntry[] {
    return [...this.entries.values()];
  }
}
