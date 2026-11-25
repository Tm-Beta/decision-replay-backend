import crypto from "crypto";
import zlib from "zlib";

const DEV_FALLBACK_SECRET = "decision-replay-enterprise-hmac-sha256-secret-key-2026";
const BACKUP_SECRET =
  process.env.BACKUP_SECRET ||
  process.env.AUTH_SECRET ||
  process.env.SESSION_SECRET ||
  (process.env.NODE_ENV === "production" ? "" : DEV_FALLBACK_SECRET);

if (
  !BACKUP_SECRET ||
  (process.env.NODE_ENV === "production" &&
    (BACKUP_SECRET.length < 32 || BACKUP_SECRET === DEV_FALLBACK_SECRET))
) {
  throw new Error(
    "Set BACKUP_SECRET or AUTH_SECRET to a random value of at least 32 characters in production.",
  );
}

/**
 * Proprietary encrypted vault format for So I Chose (.soichose):
 * - Bytes 0..9   : ASCII magic header "SOICHOSE\x00\x01"
 * - Byte  10     : Format version (0x01)
 * - Byte  11     : Cipher flags (0x01 = Gzip + HKDF-SHA256 + AES-256-GCM)
 * - Bytes 12..27 : 16-byte per-export random salt
 * - Bytes 28..39 : 12-byte random GCM nonce/IV
 * - Bytes 40..55 : 16-byte AES-256-GCM authentication tag (over header+salt+iv AAD & ciphertext)
 * - Bytes 56..N  : Gzipped canonical JSON envelope ciphertext
 */
export const SOICHOSE_MAGIC = Buffer.from("SOICHOSE\x00\x01", "ascii");
const FORMAT_VERSION = 0x01;
const CIPHER_FLAGS = 0x01;
const HEADER_LEN = 12;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const AAD_LEN = HEADER_LEN + SALT_LEN + IV_LEN; // 40 bytes
const ENVELOPE_OFFSET = AAD_LEN + TAG_LEN; // 56 bytes
const HKDF_INFO = Buffer.from("soichose-vault-aes256gcm-v1", "utf-8");

export const MAX_BACKUP_FILE_BYTES = 4 * 1024 * 1024; // 4 MB encrypted binary cap
const MAX_DECOMPRESSED_BYTES = 12 * 1024 * 1024; // 12 MB zip-bomb ceiling

export class InvalidBackupVaultError extends Error {
  statusCode = 400;
  constructor(message = "Invalid, tampered, or unsupported .soichose backup file.") {
    super(message);
    this.name = "InvalidBackupVaultError";
  }
}

function deriveVaultKey(salt: Buffer): Buffer {
  const derived = crypto.hkdfSync(
    "sha256",
    Buffer.from(BACKUP_SECRET, "utf-8"),
    salt,
    HKDF_INFO,
    32,
  );
  return Buffer.from(derived);
}

/**
 * Compresses, integrity-hashes, and authenticates/encrypts a user backup payload
 * into an opaque binary `.soichose` vault buffer.
 */
export function encryptBackupVault(payload: unknown): Buffer {
  const canonicalPayload = JSON.stringify(payload);
  const sha256 = crypto.createHash("sha256").update(canonicalPayload, "utf8").digest("hex");

  const innerEnvelope = JSON.stringify({
    format: "soichose-vault",
    v: 1,
    sha256,
    payload,
  });

  const compressed = zlib.gzipSync(Buffer.from(innerEnvelope, "utf8"), { level: 6 });

  const header = Buffer.allocUnsafe(HEADER_LEN);
  SOICHOSE_MAGIC.copy(header, 0);
  header[10] = FORMAT_VERSION;
  header[11] = CIPHER_FLAGS;

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const aad = Buffer.concat([header, salt, iv]);
  const key = deriveVaultKey(salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([aad, authTag, ciphertext]);
}

/**
 * Verifies magic bytes, AES-256-GCM AAD/auth tag, gzip bounds, and inner SHA-256 digest
 * before returning the decrypted payload from a `.soichose` vault buffer.
 */
export function decryptBackupVault(buffer: Buffer): unknown {
  if (!Buffer.isBuffer(buffer) || buffer.length <= ENVELOPE_OFFSET) {
    throw new InvalidBackupVaultError("This file is not a valid .soichose backup vault.");
  }
  if (buffer.length > MAX_BACKUP_FILE_BYTES) {
    throw new InvalidBackupVaultError("Backup file exceeds the 4 MB size limit.");
  }

  const magicSlice = buffer.subarray(0, SOICHOSE_MAGIC.length);
  if (!crypto.timingSafeEqual(magicSlice, SOICHOSE_MAGIC)) {
    throw new InvalidBackupVaultError("Only genuine .soichose backup files can be imported.");
  }

  const version = buffer[10];
  const flags = buffer[11];
  if (version !== FORMAT_VERSION || flags !== CIPHER_FLAGS) {
    throw new InvalidBackupVaultError("Unsupported .soichose backup format version.");
  }

  const aad = buffer.subarray(0, AAD_LEN);
  const salt = buffer.subarray(HEADER_LEN, HEADER_LEN + SALT_LEN);
  const iv = buffer.subarray(HEADER_LEN + SALT_LEN, AAD_LEN);
  const authTag = buffer.subarray(AAD_LEN, ENVELOPE_OFFSET);
  const ciphertext = buffer.subarray(ENVELOPE_OFFSET);

  let compressed: Buffer;
  try {
    const key = deriveVaultKey(salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new InvalidBackupVaultError(
      "Backup signature verification failed. This .soichose file may be corrupted or tampered with.",
    );
  }

  let envelopeText: string;
  try {
    const plain = zlib.gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    envelopeText = plain.toString("utf8");
  } catch {
    throw new InvalidBackupVaultError("Could not unpack .soichose backup contents.");
  }

  let parsedEnvelope: {
    format?: unknown;
    v?: unknown;
    sha256?: unknown;
    payload?: unknown;
  };
  try {
    parsedEnvelope = JSON.parse(envelopeText);
  } catch {
    throw new InvalidBackupVaultError("Corrupted inner vault structure.");
  }

  if (
    !parsedEnvelope ||
    parsedEnvelope.format !== "soichose-vault" ||
    parsedEnvelope.v !== 1 ||
    typeof parsedEnvelope.sha256 !== "string" ||
    !parsedEnvelope.payload
  ) {
    throw new InvalidBackupVaultError("Invalid .soichose vault metadata.");
  }

  const recomputed = crypto
    .createHash("sha256")
    .update(JSON.stringify(parsedEnvelope.payload), "utf8")
    .digest("hex");

  const a = Buffer.from(parsedEnvelope.sha256, "hex");
  const b = Buffer.from(recomputed, "hex");
  if (a.length !== 32 || b.length !== 32 || !crypto.timingSafeEqual(a, b)) {
    throw new InvalidBackupVaultError("Backup checksum mismatch.");
  }

  return parsedEnvelope.payload;
}

