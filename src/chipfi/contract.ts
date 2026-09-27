import { transactions } from 'near-api-js'
import type { NearRpc, TxResult } from '../near/rpc.js'
import { eventsOf } from '../near/rpc.js'
import { TGAS } from '../near/tokens.js'
import type { PlannedTx } from '../near/signer.js'

/**
 * chipfi.fun — every coin is its own contract, `cN.chipfi.near`, which is both
 * the NEP-141 token and its bonding curve (source: github.com/opengrid1/launchpad).
 *
 * Verified against mainnet (Sep 2026, code 0.2.0):
 *  - NEAR-paired coins: `buy({min_out, for_account: null})` with NEAR attached.
 *    The coin registers the buyer itself, keeping the storage cost (0.004
 *    NEAR) out of the deposit, and transfers the tokens in the same receipt.
 *  - `sell({amount, min_out})`, no deposit, pays native NEAR straight back.
 *  - `claim()` pays the holder's NEAR dividends (some coins send their whole
 *    tax to holders).
 *  - Views: `quote_buy({pair_in})` → tokens, `quote_sell({tokens_in})` → NEAR,
 *    `get_holder({account_id})` → balance / claimable_dividends / credit.
 *  - Phases: Curve → Graduating → Pool. In Pool the coin trades on Rhea, so
 *    the bot's DEX route takes over.
 *  - Coins paired with a token (e.g. NVDAon) are bought with ft_transfer_call
 *    on that token instead; those are refused rather than half-supported.
 */

const COIN_RE = /^c\d+\.chipfi\.near$/
export const isChipfiToken = (id: string) => COIN_RE.test(id.trim().toLowerCase())

/** What a coin keeps from the first buy for registering the buyer (storage_balance_bounds). */
export const CHIPFI_STORAGE = 4_000_000_000_000_000_000_000n

export interface ChipfiInfo {
  symbol: string
  /** NEAR the curve holds to pay sellers. */
  raised: string
  pair: 'Near' | { Token: { account_id: string; symbol: string; decimals: number } }
  phase: 'Curve' | 'Graduating' | 'Pool' | string
  buy_tax_bps: number
  sell_tax_bps: number
  split: { creator_bps: number; dividends_bps: number; burn_bps: number; liquidity_bps: number }
  tokens_sold: string
  curve_supply: string
  holders: number
}

export interface ChipfiHolder {
  balance: string
  claimable_dividends: string
  credit: string
}

export interface ChipfiTrade {
  side: 'buy' | 'sell'
  /** NEAR in (buy, after storage) or tokens in (sell). */
  amountIn: bigint
  /** Tokens out (buy) or NEAR out (sell). */
  amountOut: bigint
  tax: bigint
}

export class Chipfi {
  constructor(
    private readonly rpc: NearRpc,
    readonly accountId: string,
  ) {}

  async info(tokenId: string): Promise<ChipfiInfo> {
    return this.rpc.view<ChipfiInfo>(tokenId, 'get_info', {}, 'optimistic')
  }

  /**
   * The factory owner can pull a coin's curve NEAR at will (`coin_collect_curve`,
   * up to 100%). On 2026-09-26 it did — 371.9 NEAR from c1 and 49 NEAR from c4 —
   * leaving holders unable to sell. A curve with tokens sold but nothing
   * raised has been emptied.
   */
  static drained(info: ChipfiInfo): boolean {
    return BigInt(info.tokens_sold) > 0n && BigInt(info.raised) === 0n
  }

  static pairedWithNear(info: ChipfiInfo): boolean {
    return info.pair === 'Near'
  }

  /** % of the curve sold, towards graduation. */
  static progress(info: ChipfiInfo): number {
    const supply = BigInt(info.curve_supply)
    return supply ? Number((BigInt(info.tokens_sold) * 10_000n) / supply) / 100 : 0
  }

  async holder(tokenId: string): Promise<ChipfiHolder | null> {
    return this.rpc.view<ChipfiHolder>(tokenId, 'get_holder', { account_id: this.accountId }, 'optimistic').catch(() => null)
  }

  async quoteBuy(tokenId: string, nearIn: bigint): Promise<bigint | null> {
    const v = await this.rpc.view<string>(tokenId, 'quote_buy', { pair_in: nearIn.toString() }, 'optimistic').catch(() => null)
    return v && BigInt(v) > 0n ? BigInt(v) : null
  }

  async quoteSell(tokenId: string, tokensIn: bigint): Promise<bigint | null> {
    const v = await this.rpc.view<string>(tokenId, 'quote_sell', { tokens_in: tokensIn.toString() }, 'optimistic').catch(() => null)
    return v && BigInt(v) > 0n ? BigInt(v) : null
  }

  buyTx(tokenId: string, nearIn: bigint, minOut: bigint): PlannedTx {
    return {
      receiverId: tokenId,
      actions: [
        transactions.functionCall('buy', Buffer.from(JSON.stringify({ min_out: minOut.toString(), for_account: null })), 100n * TGAS, nearIn),
      ],
    }
  }

  sellTx(tokenId: string, amount: bigint, minOut: bigint): PlannedTx {
    return {
      receiverId: tokenId,
      actions: [
        transactions.functionCall('sell', Buffer.from(JSON.stringify({ amount: amount.toString(), min_out: minOut.toString() })), 100n * TGAS, 0n),
      ],
    }
  }

  claimTx(tokenId: string): PlannedTx {
    return { receiverId: tokenId, actions: [transactions.functionCall('claim', Buffer.from('{}'), 100n * TGAS, 0n)] }
  }

  /** Our own trade from a finished transaction (`launchpad` trade event; data is an object). */
  tradeIn(tx: TxResult): ChipfiTrade | null {
    for (const e of eventsOf(tx)) {
      if (e.standard !== 'launchpad' || e.event !== 'trade') continue
      for (const d of (Array.isArray(e.data) ? e.data : [e.data]) as any[]) {
        if (d?.account !== this.accountId) continue
        return d.side === 'buy'
          ? { side: 'buy', amountIn: BigInt(d.pair_in), amountOut: BigInt(d.tokens_out), tax: BigInt(d.tax ?? 0) }
          : { side: 'sell', amountIn: BigInt(d.tokens_in), amountOut: BigInt(d.pair_out), tax: BigInt(d.tax ?? 0) }
      }
    }
    return null
  }
}
