/**
 * Ed25519 backend — Node.js (OpenSSL via node:crypto). Used by the API,
 * the CLIs and the tests. The browser build replaces this file with
 * ed25519.portable.ts (pure JS); `test/crypto.test.ts` checks both
 * produce identical keys and signatures.
 */
import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { concatBytes, randomBytes } from "./bytes.ts";

const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

const privateKey = (seed: Uint8Array) => createPrivateKey({ key: Buffer.from(concatBytes(PKCS8_PREFIX, seed)), format: "der", type: "pkcs8" });

export const ed25519 = {
  backend: "node:crypto",
  publicFromSeed(seed: Uint8Array): Uint8Array {
    const jwk = createPublicKey(privateKey(seed)).export({ format: "jwk" });
    return new Uint8Array(Buffer.from(jwk.x!, "base64url"));
  },
  sign(seed: Uint8Array, msg: Uint8Array): Uint8Array {
    return new Uint8Array(nodeSign(null, msg, privateKey(seed)));
  },
  verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
    try {
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
      return nodeVerify(null, msg, key, sig);
    } catch {
      return false;
    }
  },
  randomSeed(): Uint8Array {
    return randomBytes(32);
  },
};
