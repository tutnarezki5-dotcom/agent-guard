import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/**
 * Ed25519 signing of AgentGuard decisions.
 *
 * The signed message is a plain UTF-8 string. The vault contract rebuilds
 * the same string from its call arguments and checks the signature with
 * `env::ed25519_verify`, so the two formats must match byte for byte:
 *
 *   agentguard:v1|<contract_id>|<mandate_id>|<receiver>|<amount_yocto>|<nonce>|<expires_at_ms>|<input_hash>
 *
 * See contracts/vault-core/src/lib.rs → `authorization_message`.
 */
export function authorizationMessage(a: {
  contract_id: string;
  mandate_id: string;
  receiver: string;
  amount_yocto: string;
  nonce: number;
  expires_at_ms: number;
  input_hash: string;
}): string {
  for (const [k, v] of Object.entries(a)) {
    if (String(v).includes("|")) throw new Error(`field ${k} must not contain '|'`);
  }
  return `agentguard:v1|${a.contract_id}|${a.mandate_id}|${a.receiver}|${a.amount_yocto}|${a.nonce}|${a.expires_at_ms}|${a.input_hash}`;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = BASE58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character '${c}'`);
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = Buffer.from(hex, "hex");
  let zeros = 0;
  for (const c of s) {
    if (c !== "1") break;
    zeros++;
  }
  return new Uint8Array(Buffer.concat([Buffer.alloc(zeros), body]));
}

export class GuardSigner {
  private constructor(
    private readonly privateKey: KeyObject,
    /** Raw 32-byte public key. */
    readonly publicKeyRaw: Uint8Array,
  ) {}

  /** From a 32-byte seed encoded as base64 (the GUARD_SECRET_KEY env var). */
  static fromSeedBase64(seedB64: string): GuardSigner {
    const seed = Buffer.from(seedB64, "base64");
    if (seed.length !== 32) throw new Error("GUARD_SECRET_KEY must be a base64-encoded 32-byte seed");
    const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
    return new GuardSigner(priv, rawPublicKey(createPublicKey(priv)));
  }

  /** Fresh random key — for tests and the local simulator only. */
  static generate(): { signer: GuardSigner; seedBase64: string } {
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    const seed = der.subarray(der.length - 32);
    return { signer: GuardSigner.fromSeedBase64(seed.toString("base64")), seedBase64: seed.toString("base64") };
  }

  /** NEAR-style public key, e.g. `ed25519:6E8sCc…` — passed to the contract at init. */
  get publicKeyNear(): string {
    return `ed25519:${base58Encode(this.publicKeyRaw)}`;
  }

  signMessage(message: string): string {
    return sign(null, Buffer.from(message, "utf8"), this.privateKey).toString("base64");
  }
}

function rawPublicKey(pub: KeyObject): Uint8Array {
  const jwk = pub.export({ format: "jwk" });
  if (!jwk.x) throw new Error("not an ed25519 public key");
  return new Uint8Array(Buffer.from(jwk.x, "base64url"));
}

/** Verify a signature against a NEAR-style `ed25519:<base58>` public key. */
export function verifyMessage(message: string, signatureB64: string, publicKeyNear: string): boolean {
  if (!publicKeyNear.startsWith("ed25519:")) return false;
  const raw = base58Decode(publicKeyNear.slice("ed25519:".length));
  if (raw.length !== 32) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
  const sig = Buffer.from(signatureB64, "base64");
  if (sig.length !== 64) return false;
  return verify(null, Buffer.from(message, "utf8"), key, sig);
}
