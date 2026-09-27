import { KeyPair } from 'near-api-js'
import type { KeyPairString } from '@near-js/crypto'
import type { NearRpc } from './rpc.js'

/** Derives the public key from a NEAR private key. Throws on a malformed key. Never logs the secret. */
export const publicKeyOf = (privateKey: string) =>
  KeyPair.fromString(privateKey.trim() as KeyPairString).getPublicKey().toString()

/**
 * Generates a brand-new NEAR wallet: a random ed25519 key pair. The address is
 * the implicit account id (64-char hex of the public key), which the key
 * controls by definition and which activates on chain once it is funded.
 */
export function newWallet(): { accountId: string; privateKey: string; publicKey: string } {
  const kp = KeyPair.fromRandom('ed25519')
  const pub = kp.getPublicKey()
  return { accountId: Buffer.from(pub.data).toString('hex'), privateKey: kp.toString(), publicKey: pub.toString() }
}

export interface VerifyResult {
  publicKey: string
  /** The key controls the account (its public key is an access key on chain). */
  ok: boolean
  accountExists: boolean
  permission: 'FullAccess' | 'FunctionCall' | null
}

interface AccessKeyEntry {
  public_key: string
  access_key: { permission: 'FullAccess' | { FunctionCall: unknown } }
}

/**
 * Checks that `privateKey` controls `accountId`: confirms the account exists,
 * then looks for the derived public key in its on-chain access-key list.
 * (view_account errors for a missing account; view_access_key_list returns the
 * full set of keys, so membership is an exact, reliable check.)
 */
export async function verifyControls(rpc: NearRpc, accountId: string, privateKey: string): Promise<VerifyResult> {
  const publicKey = publicKeyOf(privateKey)
  const exists = await rpc
    .nativeBalance(accountId)
    .then(() => true)
    .catch((err) => {
      if (/UNKNOWN_ACCOUNT|does not exist/i.test(String((err as Error)?.message ?? err))) return false
      throw err
    })
  if (!exists) return { publicKey, ok: false, accountExists: false, permission: null }

  const list = await rpc.call<{ keys?: AccessKeyEntry[] }>('query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: accountId,
  })
  const found = (list.keys ?? []).find((k) => k.public_key === publicKey)
  return {
    publicKey,
    ok: Boolean(found),
    accountExists: true,
    permission: found ? (found.access_key.permission === 'FullAccess' ? 'FullAccess' : 'FunctionCall') : null,
  }
}
