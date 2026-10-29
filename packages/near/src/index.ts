/**
 * NEAR testnet integration (near-api-js).
 *
 * NOT VERIFIED IN THE SANDBOX THIS WAS WRITTEN IN (no npm access there).
 * Written against the near-api-js v6 API: `Account`, `JsonRpcProvider`,
 * `KeyPairSigner`, `account.callFunction(...)`. After `pnpm i`, run
 * `pnpm --filter @agentguard/near typecheck` and fix any drift; the NEAR
 * agent skill (`npx skills add near/agent-skills --skill near-api-js`)
 * has the current signatures.
 */
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import type { GuardAuthorization } from "../../schema/src/index.ts";
import type { ExecutionResult, Executor } from "../../sdk/src/index.ts";

export const TESTNET_RPC = "https://rpc.testnet.near.org";
export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

const GAS_300_TGAS = 300_000_000_000_000n;

/**
 * Submits AgentGuard authorizations to the vault contract, signing with the
 * agent's FUNCTION-CALL key (receiver = vault, methods = ["request_payment"]).
 * This process never holds a full-access key.
 */
export class NearExecutor implements Executor {
  readonly name = "testnet";
  private readonly account: Account;

  constructor(
    agentAccountId: string,
    /** "ed25519:…" secret of the function-call key, from AGENT_FC_PRIVATE_KEY. */
    functionCallSecretKey: string,
    private readonly vaultContractId: string,
    rpcUrl = TESTNET_RPC,
  ) {
    const provider = new JsonRpcProvider({ url: rpcUrl });
    const signer = KeyPairSigner.fromSecretKey(functionCallSecretKey as `ed25519:${string}`);
    this.account = new Account(agentAccountId, provider, signer);
  }

  async requestPayment(a: GuardAuthorization): Promise<ExecutionResult> {
    try {
      const outcome = (await this.account.callFunctionRaw({
        contractId: this.vaultContractId,
        methodName: "request_payment",
        args: {
          mandate_id: a.mandate_id,
          receiver: a.receiver,
          amount: a.amount_yocto,
          nonce: String(a.nonce),
          expires_at_ms: String(a.expires_at_ms),
          input_hash: a.input_hash,
          signature: a.signature,
        },
        gas: GAS_300_TGAS,
        deposit: 0n,
      })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string }; status?: { SuccessValue?: string } };
      const hash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? null;
      const ret = outcome.status?.SuccessValue ? Buffer.from(outcome.status.SuccessValue, "base64").toString() : "null";
      const requestId = ret && ret !== "null" ? Number(JSON.parse(ret)) : undefined;
      if (requestId !== undefined) return { status: "pending_onchain_approval", tx_hash: hash, error: null, request_id: requestId };
      return { status: "success", tx_hash: hash, error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = /ERR_[A-Z_]+/.exec(msg)?.[0] ?? msg;
      return { status: "failed", tx_hash: null, error: code };
    }
  }
}

/** Read-only view of the vault (no keys needed). */
export async function viewVault<T>(vaultContractId: string, method: string, args: Record<string, unknown> = {}, rpcUrl = TESTNET_RPC): Promise<T> {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return (await provider.callFunction(vaultContractId, method, args)) as T;
}
