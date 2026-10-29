/**
 * Generates the keypair for the agent's FUNCTION-CALL key in NEAR format:
 *   public:  ed25519:<base58 32-byte public key>
 *   secret:  ed25519:<base58 64 bytes = seed || public key>
 * scripts/setup-testnet.sh adds the public key to the agent account as a
 * function-call key (receiver = vault, methods = request_payment).
 */
import { generateKeyPairSync } from "node:crypto";
import { base58Encode } from "../packages/guard/src/index.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
console.log(`AGENT_FC_PUBLIC_KEY=ed25519:${base58Encode(pub)}`);
console.log(`AGENT_FC_PRIVATE_KEY=ed25519:${base58Encode(Buffer.concat([seed, pub]))}`);
