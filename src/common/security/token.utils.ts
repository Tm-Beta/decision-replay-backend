import crypto from "crypto";

const AUTH_SECRET =
  process.env.AUTH_SECRET ||
  process.env.SESSION_SECRET ||
  (process.env.NODE_ENV === "production" ? "" : "decision-replay-enterprise-hmac-sha256-secret-key-2026");

if (!AUTH_SECRET || (process.env.NODE_ENV === "production" && (AUTH_SECRET.length < 32 || AUTH_SECRET === "decision-replay-enterprise-hmac-sha256-secret-key-2026"))) {
  throw new Error("Set AUTH_SECRET to a random value of at least 32 characters in production.");
}

export interface TokenPayload {
  userId: string;
  email: string;
  timestamp: number;
}

/**
 * Generates a cryptographically signed HMAC-SHA256 session token with random nonce.
 * Format: usr_tok.<base64url_payload>.<hmac_signature>
 */
export function generateSessionToken(userId: string, email: string): string {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const payloadString = `${userId}:${email}:${timestamp}:${nonce}`;
  const encodedPayload = Buffer.from(payloadString, "utf-8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(encodedPayload)
    .digest("hex");

  return `usr_tok.${encodedPayload}.${signature}`;
}

/**
 * Verifies the cryptographic integrity, signature, and expiration of a session token.
 * Employs constant-time comparison to prevent side-channel timing attacks.
 */
export function verifySessionToken(token: string): { userId: string; email: string } | null {
  // Support modern HMAC token format: usr_tok.<payload>.<signature>
  if (token.startsWith("usr_tok.")) {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [, encodedPayload, providedSignature] = parts;

    // Compute expected signature
    const expectedSignature = crypto
      .createHmac("sha256", AUTH_SECRET)
      .update(encodedPayload)
      .digest("hex");

    // Timing-safe comparison to prevent timing attacks
    const providedBuf = Buffer.from(providedSignature, "hex");
    const expectedBuf = Buffer.from(expectedSignature, "hex");

    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return null;
    }

    try {
      const payloadString = Buffer.from(encodedPayload, "base64url").toString("utf-8");
      const [userId, email, timestampStr] = payloadString.split(":");
      const timestamp = parseInt(timestampStr, 10);

      // Max session age: 30 days
      const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(timestamp) || timestamp > Date.now() || Date.now() - timestamp > maxAgeMs) {
        return null;
      }

      if (!userId) return null;

      return { userId, email: email || "" };
    } catch {
      return null;
    }
  }


  return null;
}
