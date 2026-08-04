import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(encryptionKey: string): Buffer {
  return Buffer.from(encryptionKey, 'hex');
}

export function encrypt(plaintext: string, encryptionKey: string): string {
  const key = getKey(encryptionKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedString: string, encryptionKey: string): string {
  const key = getKey(encryptionKey);
  const [ivHex, authTagHex, ciphertext] = encryptedString.split(':');

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// ---------------------------------------------------------------------------------------------
// Password hashing
//
// WHY scrypt AND NOT argon2/bcrypt: both are native modules. Dockerfile.agent already documents
// the pain of native dependencies in this project (@livekit/rtc-node has no musl build), and
// adding a second one to two images — for a B2B dashboard with on the order of ten users — is a
// bad trade. Node's scrypt is a memory-hard KDF in the standard library, tuned below to the
// parameters OWASP lists as acceptable, and it costs nothing to build.
// ---------------------------------------------------------------------------------------------

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
// Node's default maxmem (32MB) is too low for N=16384,r=8 — it throws instead of hashing.
// 128 * N * r = 16MB of working memory; doubling it leaves headroom without being generous.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Format: "<saltHex>:<hashHex>". Self-describing enough to change parameters later by prefixing. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Constant-time verification. Returns false rather than throwing on a malformed or absent stored
 * hash — a user row with a NULL password_hash (invited but not yet accepted) is a normal state,
 * not an error, and it must not be distinguishable from a wrong password.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
    salt = Buffer.from(saltHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN || salt.length === 0) return false;

  const actual = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------------------------
// Opaque tokens (refresh tokens, invites, password resets)
// ---------------------------------------------------------------------------------------------

/**
 * The raw token is returned ONCE — to a cookie or an email — and only its sha256 is stored.
 * A database dump therefore yields no usable sessions or invite links.
 *
 * sha256 without a salt is correct here and would be wrong for passwords: the input is 32 bytes
 * of CSPRNG output, so there is no dictionary to attack and no reason to pay a KDF's cost on
 * every request.
 */
export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
