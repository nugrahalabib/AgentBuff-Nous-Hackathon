import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

// Stable, privacy-preserving key for the one-time-trial ledger: we store a
// SHA-256 of the normalized email, never the email itself. Normalizing
// (trim + lowercase) so casing/whitespace can't be used to mint a second trial.
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function getKey(): Buffer {
  // Prefer a DEDICATED encryption secret so rotating the NextAuth JWT secret
  // (AUTH_SECRET) does not brick every stored BYOK key. Falls back to
  // AUTH_SECRET when ENCRYPTION_KEY is unset, so existing deployments keep
  // decrypting without migration — set ENCRYPTION_KEY (= current AUTH_SECRET
  // value) to decouple the two, then AUTH_SECRET can rotate independently.
  const secret = process.env.ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (!secret) throw new Error("ENCRYPTION_KEY / AUTH_SECRET not set");
  const key = Buffer.from(secret, "base64").subarray(0, 32);
  if (key.length < 32) {
    throw new Error(
      "ENCRYPTION_KEY / AUTH_SECRET must decode to >=32 bytes — generate with: openssl rand -base64 32",
    );
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), encrypted.toString("hex"), tag.toString("hex")].join(":");
}

export function decrypt(ciphertext: string): string {
  const [ivHex, encHex, tagHex] = ciphertext.split(":");
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex")) + decipher.final("utf8");
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 5) + "..." + key.slice(-4);
}
