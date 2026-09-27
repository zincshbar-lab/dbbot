import { randomUUID } from 'node:crypto'
import { transactions } from 'near-api-js'
import type { NearRpc, TxResult } from '../near/rpc.js'
import { eventsOf } from '../near/rpc.js'
import { TGAS } from '../near/tokens.js'
import type { PlannedTx } from '../near/signer.js'

/**
 * shards.market — every launch is its own contract,
 * `lNNNNNN.factory.shardsmarket.near`, which is both the NEP-141 token and
 * its market (a virtual bonding curve that graduates to an AMM inside the
 * same contract).
 *
 * Verified against mainnet (Sep 2026, template 0.2.0):
 *  - Buy: wNEAR.ft_transfer_call(launch, amount, msg
 *    {"v":1,"action":"buy","order_id","min_amount_out","max_total_fee_bps","deadline_ns"}).
 *    Tokens are credited straight to the buyer's balance in the launch.
 *  - Sell: `sell_exact_in` only CREDITS the proceeds inside the launch
 *    (`quote_credit`); `withdraw_quote` then pays them out as native NEAR.
 *    Both go in one transaction here, so proceeds are never left behind.
 *  - Buyers must be storage-registered on the launch (0.005 NEAR).
 *  - Taxes are per launch (seen 1–3% buy, 2–3% sell), from `get_config`.
 *  - The quote asset is per launch too. Recent launches use wNEAR; older
 *    ones used bridged assets — those are refused rather than half-supported.
 */

const LAUNCH_RE = /^l\d+\.factory\.shardsmarket\.near$/
export const isShardsToken = (id: string) => LAUNCH_RE.test(id.trim().toLowerCase())
export const WRAP = 'wrap.near'

const DEADLINE_NS = 120n * 1_000_000_000n
/** Headroom on the declared fee ceiling so a small fee change doesn't fail the trade. */
const FEE_CAP_BUFFER_BPS = 50

export interface ShardsConfig {
  quote_asset_id: string
  token_decimals: number
  buy_tax_bps: number
  sell_tax_bps: number
  curve_lp_fee_bps: number
  amm_lp_fee_bps: number
}

export interface ShardsState {
  phase: string
  progress_bps: number
}

export interface ShardsQuote {
  amountOut: bigint
  tax: bigint
  priceImpactBps: number
}

export interface ShardsAccount {
  registered: boolean
  balance: string
  quote_credit: string
  claimable_dividends: string
}

export interface ShardsTrade {
  side: 'buy' | 'sell'
  amountIn: bigint
  amountOut: bigint
  tax: bigint
}

export class Shards {
  private readonly configs = new Map<string, ShardsConfig>()

  constructor(
    private readonly rpc: NearRpc,
    readonly accountId: string,
  ) {}

  /** Fixed at launch, so cached. */
  async config(tokenId: string): Promise<ShardsConfig> {
    const hit = this.configs.get(tokenId)
    if (hit) return hit
    const cfg = await this.rpc.view<ShardsConfig>(tokenId, 'get_config')
    this.configs.set(tokenId, cfg)
    return cfg
  }

  async state(tokenId: string): Promise<ShardsState | null> {
    return this.rpc.view<ShardsState>(tokenId, 'get_state', {}, 'optimistic').catch(() => null)
  }

  async account(tokenId: string): Promise<ShardsAccount | null> {
    return this.rpc.view<ShardsAccount>(tokenId, 'get_account', { account_id: this.accountId }, 'optimistic').catch(() => null)
  }

  /** Tradable phases: the curve, and the AMM it graduates into. */
  static isLive(state: ShardsState | null): boolean {
    return state?.phase === 'live_curve' || state?.phase === 'live_amm'
  }

  async quote(tokenId: string, side: 'buy' | 'sell', amountIn: bigint): Promise<ShardsQuote | null> {
    const q = await this.rpc
      .view<{ amount_out: string; tax: string; price_impact_bps: number; executable: boolean }>(
        tokenId,
        side === 'buy' ? 'quote_buy' : 'quote_sell',
        { amount_in: amountIn.toString() },
        'optimistic',
      )
      .catch(() => null)
    if (!q?.executable || BigInt(q.amount_out) <= 0n) return null
    return { amountOut: BigInt(q.amount_out), tax: BigInt(q.tax), priceImpactBps: q.price_impact_bps }
  }

  /** Ceiling the contract enforces on total fees; must cover what it will charge. */
  async maxFeeBps(tokenId: string, side: 'buy' | 'sell'): Promise<number> {
    const c = await this.config(tokenId)
    return (side === 'buy' ? c.buy_tax_bps : c.sell_tax_bps) + Math.max(c.curve_lp_fee_bps, c.amm_lp_fee_bps) + FEE_CAP_BUFFER_BPS
  }

  private deadline(): string {
    return (BigInt(Date.now()) * 1_000_000n + DEADLINE_NS).toString()
  }

  /** Wrap NEAR and buy, in one transaction (wNEAR-quoted launches only). */
  async buyTx(tokenId: string, nearIn: bigint, minOut: bigint): Promise<PlannedTx> {
    const msg = JSON.stringify({
      v: 1,
      action: 'buy',
      order_id: randomUUID(),
      min_amount_out: minOut.toString(),
      max_total_fee_bps: await this.maxFeeBps(tokenId, 'buy'),
      deadline_ns: this.deadline(),
    })
    return {
      receiverId: WRAP,
      actions: [
        transactions.functionCall('near_deposit', Buffer.from('{}'), 5n * TGAS, nearIn),
        transactions.functionCall(
          'ft_transfer_call',
          Buffer.from(JSON.stringify({ receiver_id: tokenId, amount: nearIn.toString(), msg })),
          120n * TGAS,
          1n,
        ),
      ],
    }
  }

  /** Sell and withdraw the proceeds as native NEAR, in one transaction. */
  async sellTx(tokenId: string, amount: bigint, minOut: bigint): Promise<PlannedTx> {
    const args = {
      amount: amount.toString(),
      min_amount_out: minOut.toString(),
      max_total_fee_bps: await this.maxFeeBps(tokenId, 'sell'),
      deadline_ns: this.deadline(),
    }
    return {
      receiverId: tokenId,
      actions: [
        transactions.functionCall('sell_exact_in', Buffer.from(JSON.stringify(args)), 60n * TGAS, 1n),
        transactions.functionCall('withdraw_quote', Buffer.from('{}'), 150n * TGAS, 1n),
      ],
    }
  }

  /**
   * Pays out what the launch holds for us: dividends (`claim_dividends`, no
   * deposit, pays out itself) and any sale proceeds left credited
   * (`withdraw_quote`, 1 yocto).
   */
  claimTx(tokenId: string, opts: { dividends: boolean; credit: boolean }): PlannedTx {
    const actions = []
    if (opts.dividends) actions.push(transactions.functionCall('claim_dividends', Buffer.from('{}'), 120n * TGAS, 0n))
    if (opts.credit) actions.push(transactions.functionCall('withdraw_quote', Buffer.from('{}'), 150n * TGAS, 1n))
    return { receiverId: tokenId, actions }
  }

  /** Our own trade from a finished transaction (the `nearlaunch` trade_executed event). */
  tradeIn(tx: TxResult): ShardsTrade | null {
    for (const e of eventsOf(tx)) {
      if (e.standard !== 'nearlaunch' || e.event !== 'trade_executed') continue
      for (const d of e.data) {
        if (d.account_id !== this.accountId) continue
        return { side: d.side, amountIn: BigInt(d.amount_in), amountOut: BigInt(d.amount_out), tax: BigInt(d.tax) }
      }
    }
    return null
  }
}
