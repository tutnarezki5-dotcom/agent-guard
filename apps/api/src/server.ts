/**
 * pnpm dev — start AgentGuard API + dashboard on http://localhost:8787
 *
 * EXECUTOR=sim (default): everything local, vault simulator, demo world.
 * EXECUTOR=testnet: real vault contract on NEAR testnet; needs the
 *   variables listed in .env.example and `pnpm i` (near-api-js).
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Guard, GuardSigner, MemoryStore } from "../../../packages/guard/src/index.ts";
import { RpcFactsProvider } from "../../../packages/risk/src/index.ts";
import { InProcessGuardClient } from "../../../packages/sdk/src/clients.ts";
import type { Executor } from "../../../packages/sdk/src/index.ts";
import { OpenAICompatibleModel } from "../../agent/src/models.ts";
import { createWorld, type World } from "../../../attacks/world.ts";
import { createApp, type AppContext } from "./app.ts";

const env = process.env;
const mode = (env.EXECUTOR ?? "sim") === "testnet" ? "testnet" : "sim";
const port = Number(env.PORT ?? 8787);
const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "../../web");

const llm = env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL ? new OpenAICompatibleModel(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL) : null;

let ctx: AppContext;

if (mode === "sim") {
  const signer = env.GUARD_SECRET_KEY ? GuardSigner.fromSeedBase64(env.GUARD_SECRET_KEY) : GuardSigner.generate().signer;
  let world: World = createWorld({ signer });
  ctx = {
    mode,
    ownerToken: env.OWNER_TOKEN ?? "dev-owner-token",
    agentToken: env.AGENT_TOKEN ?? null,
    webDir,
    llm,
    current: () => ({ guard: world.guard, store: world.store, client: world.client, executor: world.executor, facts: world.facts, vault: world.vault, world }),
    resetWorld: () => {
      world = createWorld({ signer });
    },
  };
} else {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`EXECUTOR=testnet requires ${k} (see .env.example)`);
    return v;
  };
  const signer = GuardSigner.fromSeedBase64(need("GUARD_SECRET_KEY"));
  const vaultId = need("VAULT_CONTRACT_ID");
  const rpc = env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  const facts = new RpcFactsProvider(rpc, env.INDEXER_URL ?? null);
  const store = new MemoryStore(env.DATA_FILE ?? "data/agentguard.json");
  const guard = new Guard({ store, facts, signer, contractId: vaultId });
  // The API process does not sign transactions in testnet mode: the agent
  // process does, with its function-call key (apps/agent). This executor is
  // only used by the dashboard's "run agent" button, if keys are present.
  let executor: Executor = { name: "none", requestPayment: async () => ({ status: "failed", tx_hash: null, error: "API has no agent key; run the agent with `pnpm agent`" }) };
  if (env.AGENT_ACCOUNT_ID && env.AGENT_FC_PRIVATE_KEY) {
    // Loaded only in testnet mode, so the simulator never needs near-api-js installed.
    const nearModule = "../../../packages/near/src/index.ts";
    const near = (await import(nearModule)) as { NearExecutor: new (account: string, key: string, vault: string, rpc: string) => Executor };
    executor = new near.NearExecutor(env.AGENT_ACCOUNT_ID, env.AGENT_FC_PRIVATE_KEY, vaultId, rpc);
  }
  const client = new InProcessGuardClient(guard);
  ctx = { mode, ownerToken: need("OWNER_TOKEN"), agentToken: env.AGENT_TOKEN ?? null, webDir, llm, current: () => ({ guard, store, client, executor, facts, vault: null, world: null }) };
}

const server = createServer(createApp(ctx));
server.listen(port, () => {
  const c = ctx.current();
  console.log(`AgentGuard ${mode} mode on http://localhost:${port}`);
  console.log(`  vault contract:   ${c.guard.contractId}`);
  console.log(`  guard public key: ${c.guard.publicKey}`);
  console.log(`  executor:         ${c.executor.name}${llm ? `, LLM ${llm.name}` : ""}`);
  if (mode === "sim") console.log(`  owner token:      ${ctx.ownerToken} (local demo only)`);
});
