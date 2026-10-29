# What the agent's key can and cannot do

The agent account holds exactly one key after setup: a NEAR **function-call access key**.

| Attribute | Value |
| --- | --- |
| `receiver_id` | the vault contract (e.g. `vault.yourname.testnet`) |
| `method_names` | `["request_payment"]` |
| `allowance` | 0.5 NEAR of gas (set in `scripts/setup-testnet.sh`) |

## What the NEAR protocol guarantees for this key

From the [Access Keys](https://docs.near.org/protocol/accounts-contracts/access-keys) documentation:

- It can only sign a call to `receiver_id`, and only to the listed methods.
- It **cannot attach a deposit**, so it cannot move NEAR inside a call.
- It **cannot transfer NEAR**, add or delete keys, deploy code or delete the account.

So a fully compromised agent process — leaked key, prompt-injected model, malicious dependency — can do one thing: ask the vault to pay. The vault then requires a fresh AgentGuard signature over the exact receiver, amount and nonce, and checks the mandate's receiver list, per-payment limit and remaining budget itself.

Scenario 11 (`pnpm demo --only=11`) models these refusals offline; `pnpm attack:fc-transfer` performs the three forbidden actions against testnet and prints the network's errors.

## Limits and caveats you must know

1. **Gas allowance can run out.** Each call burns gas from the key's allowance. When it is used up, the key stops working. If the account has *only* function-call keys, it cannot sign anything any more, and topping up the account balance does not help: the allowance belongs to the key. Fix: the owner adds a new function-call key (owner keeps control of the agent account through a separate full-access key held offline, or by recreating the account). Monitor the remaining allowance.
2. **The allowance is charged at the gas buy price** and refunded later, so a key needs more allowance than the final cost of its calls.
3. **The key can call `request_payment` with any arguments.** That is by design: the vault's checks (signature, nonce, expiry, receiver list, limits, budget, freeze) are what make those arguments safe.
4. **The key does not protect the vault's owner.** The owner's full-access key controls `create_mandate`, `approve`, `freeze`. Keep it off the agent's machine.
5. **Removing the agent account's full-access key is a manual step** (printed by the setup script) because it is irreversible. Until you do it, the agent account can still transfer its own small balance — not the vault's funds.
