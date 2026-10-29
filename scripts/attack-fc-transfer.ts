/**
 * pnpm attack:fc-transfer — scenario 11 on the real network.
 *
 * Using the agent's FUNCTION-CALL key, try three things the NEAR protocol
 * must refuse: transfer NEAR, call a different contract, attach a deposit.
 * Prints each error. Needs AGENT_ACCOUNT_ID, AGENT_FC_PRIVATE_KEY,
 * VAULT_CONTRACT_ID in .env and `pnpm i`.
 *
 * Written against near-api-js v6 — verify method names after installing.
 */
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";

const env = process.env;
for (const k of ["AGENT_ACCOUNT_ID", "AGENT_FC_PRIVATE_KEY", "VAULT_CONTRACT_ID"]) if (!env[k]) throw new Error(`set ${k}`);

const provider = new JsonRpcProvider({ url: env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org" });
const agent = new Account(env.AGENT_ACCOUNT_ID!, provider, KeyPairSigner.fromSecretKey(env.AGENT_FC_PRIVATE_KEY as `ed25519:${string}`));

async function attempt(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`UNEXPECTED SUCCESS  ${label}`);
    process.exitCode = 1;
  } catch (e) {
    console.log(`refused as expected  ${label}\n    ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
}

await attempt("transfer 0.1 NEAR to the attacker", () => agent.transfer({ receiverId: "drain.testnet", amount: 100_000_000_000_000_000_000_000n }));
await attempt("call another contract (wrap.testnet.near_deposit)", () => agent.callFunction({ contractId: "wrap.testnet", methodName: "near_deposit", args: {}, deposit: 0n }));
await attempt("request_payment with an attached deposit", () => agent.callFunction({ contractId: env.VAULT_CONTRACT_ID!, methodName: "request_payment", args: {}, deposit: 1n }));
