import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * Authenticated encryption for secrets at rest (AES-256-GCM).
 *
 * The 32-byte key is derived from ENCRYPTION_SECRET with scrypt and a random
 * per-record salt, so the same plaintext never encrypts to the same bytes and
 * the raw secret is never used directly as a key. The GCM tag makes tampering
 * detectable: decryption fails rather than returning altered plaintext.
 *
 * The scrypt cost is stored per record so it can be raised over time without
 * breaking already-encrypted keys:
 *   - new format:    v2.<N>.<salt>.<iv>.<tag>.<ct>   (6 parts, base64url)
 *   - legacy format: <salt>.<iv>.<tag>.<ct>          (4 parts, N = 2^15)
 */

const SALT_LEN = 16
const IV_LEN = 12
const KEY_LEN = 32
/** Cost for new records. Higher = slower to brute-force a leaked secret. */
const SCRYPT_COST = 1 << 16 // N=65536
const LEGACY_COST = 1 << 15 // N=32768 (records written before versioning)
const MAXMEM = 256 * 1024 * 1024

const b64 = (b: Buffer) => b.toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url')
const deriveKey = (secret: string, salt: Buffer, cost: number) =>
  scryptSync(secret, salt, KEY_LEN, { N: cost, r: 8, p: 1, maxmem: MAXMEM })

export function encrypt(plaintext: string, secret: string): string {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, salt, SCRYPT_COST), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v2', String(SCRYPT_COST), b64(salt), b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.')
}

export function decrypt(packed: string, secret: string): string {
  const parts = packed.split('.')
  let cost: number
  let salt: Buffer, iv: Buffer, tag: Buffer, ct: Buffer
  if (parts.length === 6 && parts[0] === 'v2') {
    cost = Number(parts[1])
    ;[salt, iv, tag, ct] = parts.slice(2).map(unb64) as [Buffer, Buffer, Buffer, Buffer]
  } else if (parts.length === 4) {
    cost = LEGACY_COST
    ;[salt, iv, tag, ct] = parts.map(unb64) as [Buffer, Buffer, Buffer, Buffer]
  } else {
    throw new Error('malformed ciphertext')
  }
  if (!Number.isInteger(cost) || cost < 1024) throw new Error('bad scrypt cost')
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, salt, cost), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
