import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 as nodeEd } from "../src/ed25519.ts";
import { ed25519 as portableEd } from "../src/ed25519.portable.ts";
import { sha256, sha512 } from "../../policy-engine/src/sha.portable.ts";
import { fromHex, randomBytes, toHex } from "../src/bytes.ts";

test("portable SHA-256 / SHA-512 match node:crypto (incl. block boundaries)", () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 1000]) {
    const m = randomBytes(len);
    assert.equal(toHex(sha256(m)), createHash("sha256").update(m).digest("hex"), `sha256 len ${len}`);
    assert.equal(toHex(sha512(m)), createHash("sha512").update(m).digest("hex"), `sha512 len ${len}`);
  }
});

test("RFC 8032 test vector 1 (portable and node)", () => {
  const seed = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  const pub = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  const sig = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
  for (const ed of [portableEd, nodeEd]) {
    assert.equal(toHex(ed.publicFromSeed(seed)), pub, ed.backend);
    assert.equal(toHex(ed.sign(seed, new Uint8Array())), sig, ed.backend);
    assert.ok(ed.verify(fromHex(pub), new Uint8Array(), fromHex(sig)), ed.backend);
  }
});

test("portable ed25519 matches node:crypto on random keys and messages", () => {
  for (let i = 0; i < 12; i++) {
    const seed = randomBytes(32);
    const msg = randomBytes(i * 37);
    const pub = nodeEd.publicFromSeed(seed);
    assert.equal(toHex(portableEd.publicFromSeed(seed)), toHex(pub));
    const sig = nodeEd.sign(seed, msg);
    assert.equal(toHex(portableEd.sign(seed, msg)), toHex(sig), "deterministic signatures must be identical");
    assert.ok(portableEd.verify(pub, msg, sig));
    const bad = sig.slice();
    bad[5] = bad[5]! ^ 1;
    assert.equal(portableEd.verify(pub, msg, bad), false);
    assert.equal(nodeEd.verify(pub, msg, bad), false);
    if (msg.length) {
      const other = msg.slice();
      other[0] = other[0]! ^ 1;
      assert.equal(portableEd.verify(pub, other, sig), false);
    }
  }
});
