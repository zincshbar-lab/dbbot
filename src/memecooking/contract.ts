import { transactions } from 'near-api-js'
import type { NearRpc } from '../near/rpc.js'
import { TGAS, ftTransferCall } from '../near/tokens.js'
import type { PlannedTx } from '../near/signer.js'

/**
 * meme.cooking — a presale launchpad, not a curve. Each meme "cooks" for a
 * window; people deposit wNEAR. If the soft cap is met when it ends, the
 * token launches (half the distributable supply to depositors pro rata, the
 * rest into a Rhea pool); if not, deposits are refundable.
 *
 * Verified against mainnet (Sep 2026):
 *  - deposit: wNEAR.ft_transfer_call(meme-cooking.near, amount,
 *    {"Deposit":{"meme_id":N}}); 0.5% fee (20 in → 19.9 credited).
 *  - withdraw({meme_id, amount}), 1 yocto, before the end: 2% fee; pays wNEAR.
 *  - claim({meme_id}), 1 yocto, after the end: tokens if it launched, the
 *    whole deposit back (no fee) if it failed; paid as an ft_transfer, so
 *    the account must be registered on the token first.
 *  - views: get_meme (live only), get_finalized_meme (launched),
 *    get_account → deposits [[id, amount]], get_unclaimed → [ids],
 *    get_claimable({account_id, meme_id}) → tokens.
 *  - storage: 0.02 NEAR per account + 0.005 per meme, on the launchpad.
 */

export const MEME_COOKING = 'meme-cooking.near'
const WRAP = 'wrap.near'
export const DEPOSIT_FEE_BPS = 50
export const WITHDRAW_FEE_BPS = 200

export interface LiveMeme {
  id: number
  owner: string
  name: string
  symbol: string
  decimals: number
  total_supply: string
  start_timestamp_ms: string | null
  end_timestamp_ms: string | null
  soft_cap: string
  hard_cap: string | null
  /** NEAR deposited so far (net of deposit fees). */
  total_staked: string
  /** Tokens that will be shared among depositors. */
  amount_to_be_distributed: string
  team_allocation?: unknown
}

export interface FinalizedMeme {
  id: number
  owner: string
  name: string
  symbol: string
  decimals: number
  soft_cap: string
  total_staked: string
  amount_to_be_distributed: string
}

export type MemeStatus =
  | { kind: 'upcoming'; meme: LiveMeme; startsAt: number }
  | { kind: 'live'; meme: LiveMeme; endsAt: number | null }
  | { kind: 'ended'; meme: LiveMeme } // waiting for finalize
  | { kind: 'launched'; meme: FinalizedMeme; tokenId: string }
  | { kind: 'failed'; id: number } // gone from live, never launched: refundable

/** Launched memes live at `<symbol>-<id>.meme-cooking.near` (e.g. axm-1960). */
export const memeTokenId = (symbol: string, id: number) => `${symbol.toLowerCase()}-${id}.meme-cooking.near`

/** Accepts "1987", "#1987", "meme 1987" or a meme.cooking link. */
export function parseMemeRef(input: string): number | null {
  const t = input.trim().toLowerCase()
  const m = t.match(/meme\.cooking\/meme\/(\d+)/) ?? t.match(/^(?:\/?meme\s+|#)?(\d{1,6})$/)
  return m ? Number(m[1]) : null
}

export class MemeCooking {
  constructor(
    private readonly rpc: NearRpc,
    readonly accountId: string,
    private readonly api = 'https://api.meme.cooking',
  ) {}

  async status(id: number): Promise<MemeStatus> {
    const live = await this.rpc.view<LiveMeme | null>(MEME_COOKING, 'get_meme', { meme_id: id }, 'optimistic').catch(() => null)
    if (live) {
      const now = Date.now()
      const start = live.start_timestamp_ms ? Number(live.start_timestamp_ms) : null
      const end = live.end_timestamp_ms ? Number(live.end_timestamp_ms) : null
      if (start && now < start) return { kind: 'upcoming', meme: live, startsAt: start }
      if (end && now >= end) return { kind: 'ended', meme: live }
      return { kind: 'live', meme: live, endsAt: end }
    }
    const fin = await this.rpc.view<FinalizedMeme>(MEME_COOKING, 'get_finalized_meme', { meme_id: id }, 'optimistic').catch(() => null)
    if (fin) return { kind: 'launched', meme: fin, tokenId: memeTokenId(fin.symbol, fin.id) }
    return { kind: 'failed', id }
  }

  /** My deposits: meme id → wNEAR credited (after the deposit fee). */
  async deposits(): Promise<Map<number, bigint>> {
    const acct = await this.rpc
      .view<{ deposits: [number, string][] } | null>(MEME_COOKING, 'get_account', { account_id: this.accountId }, 'optimistic')
      .catch(() => null)
    return new Map((acct?.deposits ?? []).map(([id, amt]) => [id, BigInt(amt)]))
  }

  async unclaimed(): Promise<number[]> {
    return (await this.rpc.view<number[] | null>(MEME_COOKING, 'get_unclaimed', { account_id: this.accountId }, 'optimistic').catch(() => null)) ?? []
  }

  async claimableTokens(id: number): Promise<bigint> {
    const v = await this.rpc.view<string>(MEME_COOKING, 'get_claimable', { account_id: this.accountId, meme_id: id }, 'optimistic').catch(() => '0')
    return BigInt(v ?? '0')
  }

  /** Storage on the launchpad: 0.02 per account + 0.005 per meme; top up when low. */
  async storageTx(): Promise<PlannedTx | null> {
    const bal = await this.rpc
      .view<{ total: string; available: string } | null>(MEME_COOKING, 'storage_balance_of', { account_id: this.accountId })
      .catch(() => null)
    const need = !bal ? 30_000_000_000_000_000_000_000n : BigInt(bal.available) < 10_000_000_000_000_000_000_000n ? 20_000_000_000_000_000_000_000n : 0n
    if (!need) return null
    return {
      receiverId: MEME_COOKING,
      actions: [transactions.functionCall('storage_deposit', Buffer.from(JSON.stringify({ account_id: this.accountId })), 10n * TGAS, need)],
    }
  }

  depositTx(id: number, nearAmount: bigint): PlannedTx {
    return {
      receiverId: WRAP,
      actions: [
        transactions.functionCall('near_deposit', Buffer.from('{}'), 5n * TGAS, nearAmount),
        ftTransferCall(MEME_COOKING, nearAmount, JSON.stringify({ Deposit: { meme_id: id } }), 100n * TGAS),
      ],
    }
  }

  withdrawTx(id: number, amount: bigint): PlannedTx {
    return {
      receiverId: MEME_COOKING,
      actions: [transactions.functionCall('withdraw', Buffer.from(JSON.stringify({ meme_id: id, amount: amount.toString() })), 60n * TGAS, 1n)],
    }
  }

  claimTx(id: number): PlannedTx {
    return {
      receiverId: MEME_COOKING,
      actions: [transactions.functionCall('claim', Buffer.from(JSON.stringify({ meme_id: id })), 100n * TGAS, 1n)],
    }
  }

  /** Payouts arrive as wNEAR; this turns `amount` back into native NEAR. */
  unwrapTx(amount: bigint): PlannedTx {
    return {
      receiverId: WRAP,
      actions: [transactions.functionCall('near_withdraw', Buffer.from(JSON.stringify({ amount: amount.toString() })), 10n * TGAS, 1n)],
    }
  }

  /** Presales currently open or about to open, soonest-ending first. */
  async listOpen(): Promise<{ meme_id: number; owner: string; symbol: string; name: string; end_timestamp_ms: number | null; total_deposit: string; soft_cap: string; hard_cap: string | null }[]> {
    const res = await fetch(`${this.api}/meme`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`meme.cooking API ${res.status}`)
    const all = (await res.json()) as any[]
    const now = Date.now()
    return all
      .filter((m) => !m.is_finalized && !m.token_id && (m.end_timestamp_ms ?? 0) > now)
      .sort((a, b) => (a.end_timestamp_ms ?? 0) - (b.end_timestamp_ms ?? 0))
  }
}

/** Tokens a new net deposit would earn if the sale closed now (only shrinks as others deposit). */
export function estimateTokens(meme: LiveMeme, depositNet: bigint): bigint {
  const pool = BigInt(meme.total_staked) + depositNet
  return pool > 0n ? (BigInt(meme.amount_to_be_distributed) * depositNet) / pool : 0n
}

/** Tokens an existing deposit would get if the sale closed now. */
export function shareOfExisting(meme: LiveMeme, deposit: bigint): bigint {
  const staked = BigInt(meme.total_staked)
  return staked > 0n ? (BigInt(meme.amount_to_be_distributed) * deposit) / staked : 0n
}
