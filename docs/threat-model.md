# Threat model

AgentGuard assumes the AI agent **will** be fooled sometimes and that any single component **can** be compromised. Money moves only when two independent parties agree: AgentGuard (off-chain, judges intent) and the vault contract (on-chain, enforces hard limits).

## Assets

- Funds in the vault contract.
- The integrity of the decision journal (what was allowed, why).

## Attackers and what stops them

| # | Attacker / failure | What they try | What stops it | Demo |
| --- | --- | --- | --- | --- |
| 1 | Prompt injection in a web page or tool output | Make the agent pay an attacker | Receiver not in the mandate; blocklist; the engine never reads the model's text; provenance marks the address as coming from a tool | 7, 8 |
| 2 | Model hallucination / bad plan | Pay too much, too often, or the wrong category | Per-payment limit, cumulative mandate budget, category list, approval threshold | 2, 3, 4, 6 |
| 3 | Compromised agent process (key stolen) | Call the vault directly; transfer NEAR; call other contracts | Vault requires AgentGuard's signature; function-call key cannot transfer, attach deposits or call other contracts | 9, 11 |
| 4 | Replay of an old authorization | Re-submit an allowed payment | Per-signature nonce stored on chain; 120 s expiry | 10 |
| 5 | Signature tampering | Change amount or receiver of an allowed payment | Signature covers contract, mandate, receiver, amount, nonce, expiry and input hash | 9 |
| 6 | **Compromised AgentGuard** (signing key stolen) | Sign payments that break the rules | The vault re-checks receiver list, per-payment limit and the exact budget on chain | 3, 5, 12 |
| 7 | Concurrency race | Two payments spend the same remaining budget | AgentGuard reads state and records the reservation in one synchronous step; the vault processes calls sequentially | 5, unit tests |
| 8 | Emergency | Anything unexpected | Owner freeze: AgentGuard blocks everything and the vault rejects every payment and approval | 12 |
| 9 | Tampered journal | Rewrite why a payment was allowed | Each decision stores its full input snapshot and its SHA-256; `replay` recomputes verdict, rule hits and hash | all |

## Explicit non-goals (MVP)

- **Owner key compromise.** Whoever holds the owner key can create mandates and approve payments. Use a hardware wallet or multisig for the owner in production.
- **Collusion of AgentGuard and a stolen agent key within a mandate.** Together they can spend the mandate's budget on its allowed receivers — never more, never elsewhere. Keep mandates small and short-lived.
- **Receivers that are themselves malicious but allow-listed.** Risk signals (contract code changed in the last 24 h, account age) help; they are not a guarantee.
- **Privacy of the journal.** Decisions are stored in plain JSON. Do not put secrets in mandate goals.
- **Risk data quality.** Account age and transaction count come from an indexer; unknown values add points instead of failing open.

## Trust boundaries

```
LLM output ──(untrusted)──► agent runtime ──proposal──► AgentGuard ──signature──► vault contract ──► transfer
                               │                                                   ▲
                               └──── function-call key: request_payment only ──────┘
```

The LLM's words cross no boundary: only the structured fields of a proposal do, and `justification` is stored, never evaluated.
