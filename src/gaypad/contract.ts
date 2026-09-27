import type { Finality, NearRpc, TxResult } from '../near/rpc.js'
import { eventsOf } from '../near/rpc.js'
import { ftTransferCall } from '../near/tokens.js'
import type { PlannedTx } from '../near/signer.js'

/**
 * pride.j1.gay — bonding-curve launchpad on `gaypad.j1-racing.near`.
 *
 * Facts verified against mainnet (Sep 2026):
 *  - The curve is priced in JAMBO, not NEAR. A buy is one tx:
 *    JAMBO.ft_transfer_call(gaypad, size, {"token", "min_swap_amount"}).
 *  - Only the sizes from `get_allowed_buy_amounts` are accepted. Any other
 *    size is REFUNDED while the tx still reports success.
 *  - A flat commission (60 JAMBO) is taken from every trade, inside the size.
 *  - Buyers need no storage registration on the new token.
 *  - A sell is token.ft_transfer_call(gaypad, amount, {"token": null, ...}).
 *  - Launch lifecycle, as NEP-297 events from the gaypad contract:
 *      token_launch_requested  (creator called launch_new_token; pending)
 *      token_sale_created      (creator's first JAMBO transfer deployed it — tradable)
 *      token_swap              (every trade)
 *  - Once `is_deployed` is true the token has graduated to a DEX pool.
 */

export const GAYPAD = 'gaypad.j1-racing.near'
export const JAMBO = 'jambo-1679.meme-cooking.near'
export const JAMBO_DECIMALS = 18
/** Total supply minted to the curve at creation. */
export const CURVE_SUPPLY = 10n ** 33n

const TOKEN_RE = /^[a-z\d_-]+\.gaypad\.j1-racing\.near$/
export const isGaypadToken = (id: string) => TOKEN_RE.test(id.trim().toLowerCase())

export interface SwapState {
  token_hold: string
  wnear_hold: string
  is_deployed: boolean
  is_tradable: boolean
}

export interface Emulated {
  amountOut: bigint
  commission: bigint
  isDeployed: boolean
  isTradable: boolean
}

export interface SwapEvent {
  userId: string
  inputToken: string
  outputToken: string
  inputAmount: bigint
  outputAmount: bigint
}

export class Gaypad {
  private allowed: { sizes: bigint[]; at: number } | null = null

  constructor(
    private readonly rpc: NearRpc,
    readonly accountId: string,
  ) {}

  async swapState(tokenId: string, finality: Finality = 'final'): Promise<SwapState | null> {
    return this.rpc.view<SwapState | null>(GAYPAD, 'get_swap_state', { token_id: tokenId }, finality).catch(() => null)
  }

  /** Accepted buy sizes in JAMBO base units, ascending. Cached 10 min. */
  async allowedSizes(): Promise<bigint[]> {
    if (this.allowed && Date.now() - this.allowed.at < 600_000) return this.allowed.sizes
    const raw = await this.rpc.view<string[]>(GAYPAD, 'get_allowed_buy_amounts')
    const sizes = raw.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    this.allowed = { sizes, at: Date.now() }
    return sizes
  }

  /** Curve quote, or null when the contract refuses the size (e.g. below commission). */
  async emulate(input: string, output: string, amount: bigint, finality: Finality = 'final'): Promise<Emulated | null> {
    const r = await this.rpc
      .view<[string, string, boolean, boolean]>(
        GAYPAD,
        'emulate_swap',
        { input_token: input, output_token: output, amount: amount.toString() },
        finality,
      )
      .catch(() => null)
    if (!r) return null
    return { amountOut: BigInt(r[0]), commission: BigInt(r[1]), isDeployed: r[2], isTradable: r[3] }
  }

  buyTx(tokenId: string, jamboSize: bigint, minOut: bigint): PlannedTx {
    return {
      receiverId: JAMBO,
      actions: [ftTransferCall(GAYPAD, jamboSize, JSON.stringify({ token: tokenId, min_swap_amount: minOut.toString() }))],
    }
  }

  sellTx(tokenId: string, amount: bigint, minJambo: bigint): PlannedTx {
    return {
      receiverId: tokenId,
      actions: [ftTransferCall(GAYPAD, amount, JSON.stringify({ token: null, min_swap_amount: minJambo.toString() }))],
    }
  }

  /** All of our own swaps in a transaction (a split snipe makes several). */
  swapsIn(tx: TxResult): SwapEvent[] {
    const out: SwapEvent[] = []
    for (const e of eventsOf(tx)) {
      if (e.contract !== GAYPAD || e.event !== 'token_swap') continue
      for (const d of e.data) {
        if (d.user_id !== this.accountId) continue
        out.push({
          userId: d.user_id,
          inputToken: d.input_token,
          outputToken: d.output_token,
          inputAmount: BigInt(d.input_amount),
          outputAmount: BigInt(d.output_amount),
        })
      }
    }
    return out
  }

  /**
   * Our own swap from a finished transaction. Null means the curve refunded
   * (wrong size, slippage, not tradable) even though the tx "succeeded".
   */
  swapIn(tx: TxResult): SwapEvent | null {
    for (const e of eventsOf(tx)) {
      if (e.contract !== GAYPAD || e.event !== 'token_swap') continue
      for (const d of e.data) {
        if (d.user_id !== this.accountId) continue
        return {
          userId: d.user_id,
          inputToken: d.input_token,
          outputToken: d.output_token,
          inputAmount: BigInt(d.input_amount),
          outputAmount: BigInt(d.output_amount),
        }
      }
    }
    return null
  }
}

/**
 * Curve constants read from mainnet `token_sale_created` events: 1e33 tokens
 * against 1.5M virtual JAMBO, x*y=k, commission max(60 JAMBO, 1%) off the input.
 * Checked against $AURORA: 10,123 JAMBO in → 6.6368e30 tokens out (to the last unit ±1).
 */
const VIRTUAL_JAMBO = 1_500_000n * 10n ** 18n
const MIN_COMMISSION = 60n * 10n ** 18n

/** Tokens the curve gives for `jamboIn` at launch state (reserves before any buy). */
export function launchBuyOut(jamboIn: bigint): bigint {
  const fee = jamboIn / 100n > MIN_COMMISSION ? jamboIn / 100n : MIN_COMMISSION
  const net = jamboIn > fee ? jamboIn - fee : 0n
  return (CURVE_SUPPLY * net) / (VIRTUAL_JAMBO + net)
}

/** % of supply the creator's initial buy of `devBuy` JAMBO will take. */
export function expectedSoldPct(devBuy: bigint): number {
  if (devBuy === 0n) return 0
  return Number((launchBuyOut(devBuy) * 10_000n) / CURVE_SUPPLY) / 100
}

/** Share of supply the creator (and anyone else) already bought, in %. */
export function soldPct(state: SwapState): number {
  const sold = CURVE_SUPPLY - BigInt(state.token_hold)
  return Number((sold * 10_000n) / CURVE_SUPPLY) / 100
}
