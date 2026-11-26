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
 * v2 layout:
 * - Bytes 0..9   : ASCII magic header "SOICHOSE\x00\x01"
 * - Byte  10     : Format version (0x02 current; 0x01 legacy read-compatible)
 * - Byte  11     : Cipher flags (0x01 = Gzip + HKDF-SHA256 + AES-256-GCM)
 * - Bytes 12..43 : 32-byte per-export random salt (16-byte in v1)
 * - Bytes 44..55 : 12-byte random GCM nonce/IV
 * - Bytes 56..71 : 16-byte AES-256-GCM authentication tag (over AAD header+salt+iv & ciphertext)
 * - Bytes 72..N  : Gzipped canonical JSON envelope ciphertext with inner SHA-256 checksum
 */
export const SOICHOSE_MAGIC = Buffer.from("SOICHOSE\x00\x01", "ascii");
const FORMAT_VERSION_V1 = 0x01;
const FORMAT_VERSION_V2 = 0x02;
const CIPHER_FLAGS = 0x01;
const HEADER_LEN = 12;
const IV_LEN = 12;
const TAG_LEN = 16;
const HKDF_INFO_V1 = Buffer.from("soichose-vault-aes256gcm-v1", "utf-8");
const HKDF_INFO_V2 = Buffer.from("soichose-vault-aes256gcm-v2", "utf-8");

export const MAX_BACKUP_FILE_BYTES = 4 * 1024 * 1024; // 4 MB encrypted binary cap
const MAX_DECOMPRESSED_BYTES = 12 * 1024 * 1024; // 12 MB zip-bomb ceiling

export class InvalidBackupVaultError extends Error {
  statusCode = 400;
  constructor(message = "This .soichose backup could not be verified.") {
    super(message);
    this.name = "InvalidBackupVaultError";
  }
}

function deriveVaultKey(salt: Buffer, version: number): Buffer {
  const rootMaterial =
    version === FORMAT_VERSION_V2
      ? crypto.createHash("sha256").update(BACKUP_SECRET, "utf-8").digest()
      : Buffer.from(BACKUP_SECRET, "utf-8");
  const info = version === FORMAT_VERSION_V2 ? HKDF_INFO_V2 : HKDF_INFO_V1;
  return Buffer.from(crypto.hkdfSync("sha256", rootMaterial, salt, info, 32));
}

/**
 * Compresses, integrity-hashes, and authenticates/encrypts a user backup payload
 * into an opaque binary `.soichose` v2 vault buffer (256-bit HKDF salt + AES-256-GCM).
 */
export function encryptBackupVault(payload: unknown): Buffer {
  const canonicalPayload = JSON.stringify(payload);
  const sha256 = crypto.createHash("sha256").update(canonicalPayload, "utf8").digest("hex");

  const innerEnvelope = JSON.stringify({
    format: "soichose-vault",
    v: 2,
    sha256,
    payload,
  });

  const compressed = zlib.gzipSync(Buffer.from(innerEnvelope, "utf8"), { level: 6 });

  const header = Buffer.allocUnsafe(HEADER_LEN);
  SOICHOSE_MAGIC.copy(header, 0);
  header[10] = FORMAT_VERSION_V2;
  header[11] = CIPHER_FLAGS;

  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(IV_LEN);
  const aad = Buffer.concat([header, salt, iv]);
  const key = deriveVaultKey(salt, FORMAT_VERSION_V2);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([aad, authTag, ciphertext]);
}

/**
 * Verifies magic bytes, AES-256-GCM AAD/auth tag, gzip bounds, and inner SHA-256 digest
 * without leaking internal verification failure specifics (zero padding/tag oracle).
 */
export function decryptBackupVault(buffer: Buffer): unknown {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_BACKUP_FILE_BYTES || buffer.length < 57) {
    throw new InvalidBackupVaultError();
  }

  const magicSlice = buffer.subarray(0, SOICHOSE_MAGIC.length);
  if (!crypto.timingSafeEqual(magicSlice, SOICHOSE_MAGIC)) {
    throw new InvalidBackupVaultError("Only genuine .soichose backup files can be imported.");
  }

  const version = buffer[10];
  const flags = buffer[11];
  if (
    (version !== FORMAT_VERSION_V1 && version !== FORMAT_VERSION_V2) ||
    flags !== CIPHER_FLAGS
  ) {
    throw new InvalidBackupVaultError();
  }

  const saltLen = version === FORMAT_VERSION_V2 ? 32 : 16;
  const aadLen = HEADER_LEN + saltLen + IV_LEN;
  const envelopeOffset = aadLen + TAG_LEN;
  if (buffer.length <= envelopeOffset) {
    throw new InvalidBackupVaultError();
  }

  const aad = buffer.subarray(0, aadLen);
  const salt = buffer.subarray(HEADER_LEN, HEADER_LEN + saltLen);
  const iv = buffer.subarray(HEADER_LEN + saltLen, aadLen);
  const authTag = buffer.subarray(aadLen, envelopeOffset);
  const ciphertext = buffer.subarray(envelopeOffset);

  let envelopeText: string;
  try {
    const key = deriveVaultKey(salt, version);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const plain = zlib.gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    envelopeText = plain.toString("utf8");
  } catch {
    throw new InvalidBackupVaultError();
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
    throw new InvalidBackupVaultError();
  }

  if (
    !parsedEnvelope ||
    parsedEnvelope.format !== "soichose-vault" ||
    (parsedEnvelope.v !== 1 && parsedEnvelope.v !== 2) ||
    typeof parsedEnvelope.sha256 !== "string" ||
    !parsedEnvelope.payload
  ) {
    throw new InvalidBackupVaultError();
  }

  const recomputed = crypto
    .createHash("sha256")
    .update(JSON.stringify(parsedEnvelope.payload), "utf8")
    .digest("hex");

  const a = Buffer.from(parsedEnvelope.sha256, "hex");
  const b = Buffer.from(recomputed, "hex");
  if (a.length !== 32 || b.length !== 32 || !crypto.timingSafeEqual(a, b)) {
    throw new InvalidBackupVaultError();
  }

  return parsedEnvelope.payload;
}
