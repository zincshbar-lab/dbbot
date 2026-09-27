import { transactions } from 'near-api-js'
import type { NearRpc } from '../near/rpc.js'
import { TGAS } from '../near/tokens.js'
import type { PlannedTx } from '../near/signer.js'

/**
 * umbrapad.app — every coin is its own contract, `<name>.umbrafun.near`
 * (factory `umbrafun.near`), both the NEP-141 token and its bonding curve.
 *
 * Verified against mainnet (Sep 2026, code 0.1.0):
 *  - NEAR-paired coins (`quote_token: null`): `buy({min_out})` with NEAR
 *    attached; `sell({amount, min_out})` with 1 yocto, paying native NEAR.
 *    The fee (1%) goes to umbrafun.near on both sides.
 *  - There are no quote views. Prices come from `get_curve_state` with the
 *    formula umbrapad's own site uses; replaying two real trades from their
 *    pre-trade state reproduced both outputs exactly:
 *      x = virtual_reserve + real_reserve,  y = curve_tokens + 73M tokens
 *      buy:  out   = y − x·y / (x + in − fee),        fee = in · fee_bps
 *      sell: gross = x − x·y / (y + tokens_in),       out = gross − gross · fee_bps
 *    206.9M tokens are held back for the DEX pool, capping a single buy.
 *  - `get_owed({account_id})` + `claim()` pay out anything owed to a holder.
 *  - Graduated coins move to a Rhea pool; the bot's DEX route takes over.
 *  - Coins paired with a token (tokenized stocks) are refused.
 */

const COIN_RE = /^[a-z0-9_-]+\.umbrafun\.near$/
export const isUmbraToken = (id: string) => COIN_RE.test(id.trim().toLowerCase())

const DECIMALS = 18n
const VIRTUAL_TOKENS = 73_000_000n * 10n ** DECIMALS
const POOL_TOKENS = 206_900_000n * 10n ** DECIMALS

export interface UmbraCurve {
  quote_token: string | null
  real_reserve: string
  virtual_reserve: string
  curve_tokens: string
  spot_price: string
  fee_bps: number
  graduated: boolean
  migration: string | { Done?: { pool_id: number }; Failed?: unknown }
}

export class Umbra {
  constructor(
    private readonly rpc: NearRpc,
    readonly accountId: string,
  ) {}

  async curve(tokenId: string): Promise<UmbraCurve> {
    return this.rpc.view<UmbraCurve>(tokenId, 'get_curve_state', {}, 'optimistic')
  }

  static pairedWithNear(c: UmbraCurve): boolean {
    return c.quote_token === null
  }

  /** % of the sale inventory (793.1M) sold. */
  static progress(c: UmbraCurve): number {
    const sold = 1_000_000_000n * 10n ** DECIMALS - BigInt(c.curve_tokens)
    return Number((sold * 10_000n) / (793_100_000n * 10n ** DECIMALS)) / 100
  }

  /** Tokens out for `nearIn`, or null if the curve can't fill it whole (graduation cap). */
  static quoteBuy(c: UmbraCurve, nearIn: bigint): bigint | null {
    if (c.graduated || nearIn <= 0n) return null
    const x = BigInt(c.virtual_reserve) + BigInt(c.real_reserve)
    const y = BigInt(c.curve_tokens) + VIRTUAL_TOKENS
    const fee = (nearIn * BigInt(c.fee_bps)) / 10_000n
    // The curve rounds the product up, in its own favour (matches real trades to the unit).
    const out = y - ceilDiv(x * y, x + nearIn - fee)
    const available = BigInt(c.curve_tokens) > POOL_TOKENS ? BigInt(c.curve_tokens) - POOL_TOKENS : 0n
    // Past the cap the contract fills partially and refunds; keep it simple and refuse.
    return out > 0n && out < available ? out : null
  }

  /** NEAR out for selling `tokensIn`. */
  static quoteSell(c: UmbraCurve, tokensIn: bigint): bigint | null {
    if (c.graduated || tokensIn <= 0n) return null
    const x = BigInt(c.virtual_reserve) + BigInt(c.real_reserve)
    const y = BigInt(c.curve_tokens) + VIRTUAL_TOKENS
    const gross = x - ceilDiv(x * y, y + tokensIn)
    if (gross > BigInt(c.real_reserve)) return null
    const out = gross - (gross * BigInt(c.fee_bps)) / 10_000n
    return out > 0n ? out : null
  }

  async owed(tokenId: string): Promise<bigint> {
    const v = await this.rpc.view<string>(tokenId, 'get_owed', { account_id: this.accountId }, 'optimistic').catch(() => '0')
    return BigInt(v ?? '0')
  }

  buyTx(tokenId: string, nearIn: bigint, minOut: bigint): PlannedTx {
    return {
      receiverId: tokenId,
      actions: [transactions.functionCall('buy', Buffer.from(JSON.stringify({ min_out: minOut.toString() })), 100n * TGAS, nearIn)],
    }
  }

  sellTx(tokenId: string, amount: bigint, minOut: bigint): PlannedTx {
    return {
      receiverId: tokenId,
      actions: [
        transactions.functionCall('sell', Buffer.from(JSON.stringify({ amount: amount.toString(), min_out: minOut.toString() })), 100n * TGAS, 1n),
      ],
    }
  }

  claimTx(tokenId: string): PlannedTx {
    return { receiverId: tokenId, actions: [transactions.functionCall('claim', Buffer.from('{}'), 100n * TGAS, 0n)] }
  }
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b
