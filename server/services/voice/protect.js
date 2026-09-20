import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encryption at rest for voice profiles (biometric data): AES-256-GCM. The key comes from the VOICE_PROFILE_KEY
// environment variable (32 random bytes, base64) and exists only in the server process: it is never stored beside
// the data, logged, or sent to a client. The authenticated data binds each ciphertext to its owner and model version, so
// a row copied to another account (or another model) fails to decrypt instead of being silently accepted.

export function parseKey(base64) {
  const key = Buffer.from(base64 ?? "", "base64");
  return key.length === 32 ? key : null;
}

export function encryptJson(value, key, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), data]); // version byte | iv | tag | ciphertext
}

/** Returns the parsed value, or null when the key, owner or model does not match (tampered or foreign data). */
export function decryptJson(blob, key, aad) {
  try {
    if (blob[0] !== 1) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(blob.subarray(13, 29));
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}
