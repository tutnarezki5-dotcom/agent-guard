/** SHA backend — Node.js. The browser build swaps in sha.portable.ts. */
import { createHash } from "node:crypto";

export const sha256 = (msg: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(msg).digest());
export const sha512 = (msg: Uint8Array): Uint8Array => new Uint8Array(createHash("sha512").update(msg).digest());
