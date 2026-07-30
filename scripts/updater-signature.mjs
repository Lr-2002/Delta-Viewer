import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeWrappedText(value, label) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error(`${label} has invalid base64 padding`);
  }
  return decoded.toString("utf8");
}

function parsePublicKey(wrappedPublicKey) {
  const lines = decodeWrappedText(wrappedPublicKey, "updater public key").trimEnd().split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment: ")) {
    throw new Error("updater public key has an invalid Minisign envelope");
  }
  const record = Buffer.from(lines[1], "base64");
  if (record.length !== 42 || record[0] !== 0x45 || ![0x44, 0x64].includes(record[1])) {
    throw new Error("updater public key has an unsupported Minisign record");
  }
  return {
    keyId: record.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, record.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  };
}

function parseSignature(wrappedSignature) {
  const lines = decodeWrappedText(wrappedSignature, "updater signature").trimEnd().split(/\r?\n/);
  if (
    lines.length !== 4
    || !lines[0].startsWith("untrusted comment: ")
    || !lines[2].startsWith("trusted comment: ")
  ) {
    throw new Error("updater signature has an invalid Minisign envelope");
  }
  const record = Buffer.from(lines[1], "base64");
  const globalSignature = Buffer.from(lines[3], "base64");
  if (record.length !== 74 || globalSignature.length !== 64) {
    throw new Error("updater signature has an invalid Minisign record length");
  }
  if (record[0] !== 0x45 || record[1] !== 0x44) {
    throw new Error("updater signature must use bounded-memory prehashed Minisign mode");
  }
  return {
    keyId: record.subarray(2, 10),
    signature: record.subarray(10),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature,
  };
}

export async function verifyUpdaterSignature(filePath, signaturePath, wrappedPublicKey) {
  const [wrappedSignature, publicKey] = await Promise.all([
    readFile(signaturePath, "utf8"),
    Promise.resolve(parsePublicKey(wrappedPublicKey)),
  ]);
  const signature = parseSignature(wrappedSignature);
  if (!signature.keyId.equals(publicKey.keyId)) {
    throw new Error("updater signature key ID does not match the configured public key");
  }

  const digest = createHash("blake2b512");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  if (!verifyEd25519(null, digest.digest(), publicKey.key, signature.signature)) {
    throw new Error(`updater signature does not verify: ${filePath}`);
  }
  const globalMessage = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, "utf8"),
  ]);
  if (!verifyEd25519(null, globalMessage, publicKey.key, signature.globalSignature)) {
    throw new Error(`updater trusted comment does not verify: ${signaturePath}`);
  }
  return {
    keyId: publicKey.keyId.toString("hex").toUpperCase(),
    signature: wrappedSignature.trim(),
    trustedComment: signature.trustedComment,
  };
}
