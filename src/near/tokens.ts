import { transactions } from 'near-api-js'
import type { Finality, NearRpc } from './rpc.js'
import type { Action } from './signer.js'

export const TGAS = 1_000_000_000_000n

export interface FtMetadata {
  symbol: string
  name: string
  decimals: number
}

const metaCache = new Map<string, FtMetadata>()

/** Metadata never changes after deployment, so it is cached for the process lifetime. */
export async function ftMetadata(rpc: NearRpc, tokenId: string): Promise<FtMetadata> {
  const hit = metaCache.get(tokenId)
  if (hit) return hit
  const m = await rpc.view<FtMetadata & { icon?: string }>(tokenId, 'ft_metadata')
  const meta = { symbol: m.symbol, name: m.name, decimals: m.decimals }
  metaCache.set(tokenId, meta)
  return meta
}

export async function ftBalance(rpc: NearRpc, tokenId: string, accountId: string, finality: Finality | 'freshest' = 'final'): Promise<bigint> {
  const v =
    finality === 'freshest'
      ? await rpc.viewFreshest<string | null>(tokenId, 'ft_balance_of', { account_id: accountId })
      : await rpc.view<string | null>(tokenId, 'ft_balance_of', { account_id: accountId }, finality)
  return BigInt(v ?? '0')
}

/** Storage registration actions for `accountId` on each token that lacks it. */
export async function registrationTxs(rpc: NearRpc, tokenIds: string[], accountId: string) {
  const out: { receiverId: string; actions: Action[] }[] = []
  await Promise.all(
    tokenIds.map(async (tokenId) => {
      const bal = await rpc
        .view<unknown>(tokenId, 'storage_balance_of', { account_id: accountId })
        // Tokens without storage management (auto-registering) need nothing.
        .catch(() => 'n/a')
      if (bal !== null) return
      const bounds = await rpc
        .view<{ min: string }>(tokenId, 'storage_balance_bounds')
        .catch(() => ({ min: '1250000000000000000000' }))
      out.push({
        receiverId: tokenId,
        actions: [
          transactions.functionCall(
            'storage_deposit',
            Buffer.from(JSON.stringify({ account_id: accountId, registration_only: true })),
            10n * TGAS,
            BigInt(bounds.min),
          ),
        ],
      })
    }),
  )
  return out
}

export function ftTransferCall(receiverId: string, amount: bigint, msg: string, gas = 150n * TGAS): Action {
  return transactions.functionCall(
    'ft_transfer_call',
    Buffer.from(JSON.stringify({ receiver_id: receiverId, amount: amount.toString(), msg })),
    gas,
    1n,
  )
}

/** NEAR-ish ids that should be treated as native NEAR. */
export const isNear = (id: string) => ['near', 'wrap.near'].includes(id.trim().toLowerCase())

const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
export const isAccountId = (s: string) => ACCOUNT_ID.test(s.trim().toLowerCase())
