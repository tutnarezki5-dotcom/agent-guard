/**
 * pnpm keys:guard — create AgentGuard's signing key.
 * Prints the secret seed for .env (GUARD_SECRET_KEY) and the public key to
 * pass to the vault contract's `new(…, guard_public_key)`. Never commit the secret.
 */
import { GuardSigner } from "../packages/guard/src/index.ts";

const { signer, seedBase64 } = GuardSigner.generate();
console.log("# Add to .env (keep secret, never commit):");
console.log(`GUARD_SECRET_KEY=${seedBase64}`);
console.log("\n# Public key for the vault contract init:");
console.log(`GUARD_PUBLIC_KEY=${signer.publicKeyNear}`);
