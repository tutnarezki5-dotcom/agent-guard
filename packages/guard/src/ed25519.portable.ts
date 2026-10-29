/**
 * Ed25519 (RFC 8032) in plain TypeScript with BigInt — the browser
 * backend for the standalone demo, where node:crypto is not available
 * and WebCrypto is async. Not constant-time: fine for a demo running on
 * the viewer's own machine, NOT for production keys. Production signing
 * uses ed25519.ts (OpenSSL). Cross-checked against node:crypto in
 * packages/guard/test/crypto.test.ts.
 */
import { concatBytes, randomBytes } from "./bytes.ts";
import { sha512 } from "../../policy-engine/src/sha.portable.ts";

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

const mod = (a: bigint, m = P) => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};
function pow(b: bigint, e: bigint, m = P): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
const inv = (x: bigint) => pow(x, P - 2n);

const D = mod(-121665n * inv(121666n));
const D2 = mod(2n * D);
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

type Point = [bigint, bigint, bigint, bigint]; // extended coordinates X, Y, Z, T

function recoverX(y: bigint, sign: number): bigint | null {
  if (y >= P) return null;
  const x2 = mod((y * y - 1n) * inv(D * y * y + 1n));
  if (x2 === 0n) return sign ? null : 0n;
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
  if (mod(x * x - x2) !== 0n) return null;
  if (Number(x & 1n) !== sign) x = P - x;
  return x;
}

const GY = mod(4n * inv(5n));
const GX = recoverX(GY, 0)!;
const G: Point = [GX, GY, 1n, mod(GX * GY)];
const ZERO: Point = [0n, 1n, 1n, 0n];

function add(p: Point, q: Point): Point {
  const a = mod((p[1] - p[0]) * (q[1] - q[0]));
  const b = mod((p[1] + p[0]) * (q[1] + q[0]));
  const c = mod(p[3] * D2 * q[3]);
  const d = mod(p[2] * 2n * q[2]);
  const e = b - a,
    f = d - c,
    g = d + c,
    h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function mul(s: bigint, p: Point): Point {
  let q = ZERO;
  let r = p;
  while (s > 0n) {
    if (s & 1n) q = add(q, r);
    r = add(r, r);
    s >>= 1n;
  }
  return q;
}

function equal(p: Point, q: Point): boolean {
  return mod(p[0] * q[2] - q[0] * p[2]) === 0n && mod(p[1] * q[2] - q[1] * p[2]) === 0n;
}

function leToBig(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}
function bigToLe32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function compress(p: Point): Uint8Array {
  const zi = inv(p[2]);
  const x = mod(p[0] * zi);
  const y = mod(p[1] * zi);
  return bigToLe32(y | ((x & 1n) << 255n));
}

function decompress(b: Uint8Array): Point | null {
  if (b.length !== 32) return null;
  const n = leToBig(b);
  const y = n & ((1n << 255n) - 1n);
  const x = recoverX(y, Number(n >> 255n));
  if (x === null) return null;
  return [x, y, 1n, mod(x * y)];
}

function expand(seed: Uint8Array): { a: bigint; prefix: Uint8Array } {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const h = sha512(seed);
  let a = leToBig(h.subarray(0, 32));
  a &= (1n << 254n) - 8n;
  a |= 1n << 254n;
  return { a, prefix: h.subarray(32) };
}

const hashL = (...parts: Uint8Array[]) => mod(leToBig(sha512(concatBytes(...parts))), L);

export const ed25519 = {
  backend: "portable",
  publicFromSeed(seed: Uint8Array): Uint8Array {
    return compress(mul(expand(seed).a, G));
  },
  sign(seed: Uint8Array, msg: Uint8Array): Uint8Array {
    const { a, prefix } = expand(seed);
    const A = compress(mul(a, G));
    const r = hashL(prefix, msg);
    const R = compress(mul(r, G));
    const s = mod(r + hashL(R, A, msg) * a, L);
    return concatBytes(R, bigToLe32(s));
  },
  verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
    if (sig.length !== 64) return false;
    const A = decompress(pub);
    const R = decompress(sig.subarray(0, 32));
    if (!A || !R) return false;
    const s = leToBig(sig.subarray(32));
    if (s >= L) return false;
    const h = hashL(sig.subarray(0, 32), pub, msg);
    return equal(mul(s, G), add(R, mul(h, A)));
  },
  randomSeed(): Uint8Array {
    return randomBytes(32);
  },
};
