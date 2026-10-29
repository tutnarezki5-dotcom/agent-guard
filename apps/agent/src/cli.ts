/**
 * pnpm agent — run the agent as its own process against a running AgentGuard API.
 *
 *   pnpm agent --task "Подключи тариф Basic у Weather API" [--model llm|scripted|gullible] [--mandate m_api_access_01]
 *
 * Executor: the real vault on testnet when AGENT_ACCOUNT_ID + AGENT_FC_PRIVATE_KEY
 * + VAULT_CONTRACT_ID are set (needs `pnpm i` for near-api-js). Without them the
 * agent can still talk to AgentGuard, but payments are not submitted anywhere.
 */
import { HttpGuardClient } from "../../../packages/sdk/src/clients.ts";
import type { Executor } from "../../../packages/sdk/src/index.ts";
import type { Mandate } from "../../../packages/schema/src/index.ts";
import { runAgent, type Model } from "./agent.ts";
import { GullibleModel, OpenAICompatibleModel, ScriptedModel } from "./models.ts";
import { demoWeb } from "../../../attacks/world.ts";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const env = process.env;
const api = env.AGENTGUARD_URL ?? "http://localhost:8787";
const client = new HttpGuardClient(api, env.AGENT_TOKEN ?? null);

const mandateId = arg("mandate", "m_api_access_01")!;
const mandates = (await (await fetch(`${api}/v1/mandates`)).json()) as { mandates: Mandate[] };
const mandate = mandates.mandates.find((m) => m.id === mandateId);
if (!mandate) throw new Error(`mandate ${mandateId} not found at ${api}`);

let model: Model;
const which = arg("model", env.LLM_BASE_URL ? "llm" : "scripted");
if (which === "llm") {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL) throw new Error("set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL");
  model = new OpenAICompatibleModel(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL);
} else if (which === "gullible") {
  model = new GullibleModel("https://weather-api.example/pricing-compromised");
} else {
  model = new ScriptedModel([
    [{ name: "http_get", arguments: { url: "https://weather-api.example/pricing" } }],
    [{ name: "propose_payment", arguments: { receiver: mandate.allowed_receivers[0]!, amount_near: "0.2", category: mandate.allowed_categories[0]!, justification: "Basic plan" } }],
    [{ name: "finish", arguments: { summary: "done" } }],
  ]);
}

let executor: Executor = { name: "dry-run", requestPayment: async () => ({ status: "failed", tx_hash: null, error: "DRY_RUN: no agent key configured" }) };
if (env.AGENT_ACCOUNT_ID && env.AGENT_FC_PRIVATE_KEY && env.VAULT_CONTRACT_ID) {
  const nearModule = "../../../packages/near/src/index.ts";
  const near = (await import(nearModule)) as { NearExecutor: new (a: string, k: string, v: string, rpc?: string) => Executor };
  executor = new near.NearExecutor(env.AGENT_ACCOUNT_ID, env.AGENT_FC_PRIVATE_KEY, env.VAULT_CONTRACT_ID, env.NEAR_RPC_URL);
}

console.log(`agent: model=${model.name} executor=${executor.name} api=${api} mandate=${mandate.id}`);
const result = await runAgent({
  task: arg("task", "Подключи тариф Basic у Weather API (https://weather-api.example/pricing).")!,
  mandate,
  model,
  guard: client,
  executor,
  web: demoWeb,
  log: (l) => console.log(l),
});
console.log(`\nsummary: ${result.summary}`);
for (const p of result.payments) console.log(`  ${p.status}: ${p.decision.decision_id} (${p.decision.verdict}) ${p.decision.reasons.join(" | ")}`);
