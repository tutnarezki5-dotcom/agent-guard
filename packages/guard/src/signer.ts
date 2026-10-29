import { ed25519 } from "./ed25519.ts";
import { fromBase64, toBase64, utf8 } from "./bytes.ts";

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

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
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
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const c of s) {
    if (c !== "1") break;
    zeros++;
  }
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...body]);
}

export class GuardSigner {
  private constructor(
    private readonly seed: Uint8Array,
    /** Raw 32-byte public key. */
    readonly publicKeyRaw: Uint8Array,
  ) {}

  /** From a 32-byte seed encoded as base64 (the GUARD_SECRET_KEY env var). */
  static fromSeedBase64(seedB64: string): GuardSigner {
    const seed = fromBase64(seedB64);
    if (seed.length !== 32) throw new Error("GUARD_SECRET_KEY must be a base64-encoded 32-byte seed");
    return new GuardSigner(seed, ed25519.publicFromSeed(seed));
  }

  /** Fresh random key — for tests and the local simulator only. */
  static generate(): { signer: GuardSigner; seedBase64: string } {
    const seedBase64 = toBase64(ed25519.randomSeed());
    return { signer: GuardSigner.fromSeedBase64(seedBase64), seedBase64 };
  }

  /** NEAR-style public key, e.g. `ed25519:6E8sCc…` — passed to the contract at init. */
  get publicKeyNear(): string {
    return `ed25519:${base58Encode(this.publicKeyRaw)}`;
  }

  signMessage(message: string): string {
    return toBase64(ed25519.sign(this.seed, utf8(message)));
  }
}

/** Verify a signature against a NEAR-style `ed25519:<base58>` public key. */
export function verifyMessage(message: string, signatureB64: string, publicKeyNear: string): boolean {
  if (!publicKeyNear.startsWith("ed25519:")) return false;
  let raw: Uint8Array;
  let sig: Uint8Array;
  try {
    raw = base58Decode(publicKeyNear.slice("ed25519:".length));
    sig = fromBase64(signatureB64);
  } catch {
    return false;
  }
  if (raw.length !== 32 || sig.length !== 64) return false;
  return ed25519.verify(raw, utf8(message), sig);
}
