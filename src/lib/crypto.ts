import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * Authenticated encryption for secrets at rest (AES-256-GCM).
 *
 * The 32-byte key is derived from ENCRYPTION_SECRET with scrypt and a random
 * per-record salt, so the same plaintext never encrypts to the same bytes and
 * the raw secret is never used directly as a key. The GCM tag makes tampering
 * detectable: decryption fails rather than returning altered plaintext.
 *
 * On-disk format (base64url, dot-separated): salt.iv.tag.ciphertext
 */

const SALT_LEN = 16
const IV_LEN = 12
const KEY_LEN = 32
const SCRYPT_COST = 1 << 15 // N=32768

const b64 = (b: Buffer) => b.toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url')
const deriveKey = (secret: string, salt: Buffer) =>
  scryptSync(secret, salt, KEY_LEN, { N: SCRYPT_COST, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })

export function encrypt(plaintext: string, secret: string): string {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [salt, iv, cipher.getAuthTag(), ct].map(b64).join('.')
}

export function decrypt(packed: string, secret: string): string {
  const parts = packed.split('.')
  if (parts.length !== 4) throw new Error('malformed ciphertext')
  const [salt, iv, tag, ct] = parts.map(unb64)
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, salt!), iv!)
  decipher.setAuthTag(tag!)
  return Buffer.concat([decipher.update(ct!), decipher.final()]).toString('utf8')
}
