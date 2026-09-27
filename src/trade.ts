import { type NearRpc, type TxResult } from './near/rpc.js'
import type { HotSigner, PlannedTx } from './near/signer.js'
import type { Router } from './near/router.js'
import type { Store, Position } from './store.js'
import { Gaypad, JAMBO, isGaypadToken, type SwapState } from './gaypad/contract.js'
import { Shards, WRAP, isShardsToken } from './shards/contract.js'
import { CHIPFI_STORAGE, Chipfi, isChipfiToken } from './chipfi/contract.js'
import { Umbra, isUmbraToken } from './umbra/contract.js'
import { isNearlyToken, nearlyInfo } from './nearly/contract.js'
import { MemeCooking } from './memecooking/contract.js'
import { ftBalance, ftMetadata, registrationTxs, type FtMetadata } from './near/tokens.js'
import { ONE_NEAR, applyBps, formatNear, minusBps, mulDiv } from './lib/amounts.js'
import { planChunks, targetJambo, type Amount } from './lib/amount-plan.js'

export class TradeError extends Error {
  constructor(
    message: string,
    readonly txHash?: string,
  ) {
    super(message)
    this.name = 'TradeError'
  }
}

export type Venue = 'curve' | 'dex' | 'shards' | 'chipfi' | 'umbra' | 'nearly'

export interface TokenView {
  tokenId: string
  meta: FtMetadata
  venue: Venue
  state: SwapState | null
  balance: bigint
  /** NEAR value of the balance, null when nothing can price it. */
  valueNear: bigint | null
}

export interface BuyResult {
  hash: string
  tokens: bigint
  /** Of the bought token (gaypad tokens use 24). */
  decimals: number
  costNear: bigint
  jamboIn: bigint
  latencyMs?: number
}

export interface SellResult {
  hash: string
  tokens: bigint
  proceedsNear: bigint
  jamboOut: bigint
}

export interface PreparedCurveBuy {
  tokenId: string
  size: bigint
  expectedOut: bigint
  minOut: bigint
}

export const txLink = (hash: string) => `https://nearblocks.io/txns/${hash}`

/** Trading on the gaypad curve (in JAMBO) and on DEXes via the router (in NEAR). No fees. */
export class Trader {
  readonly me: string
  private rate: { jamboPerNear: bigint; at: number } | null = null
  private jamboBal: { value: bigint; at: number } | null = null

  constructor(
    readonly rpc: NearRpc,
    readonly signer: HotSigner,
    readonly router: Router,
    readonly gaypad: Gaypad,
    readonly store: Store,
  ) {
    this.me = signer.accountId
    this.shards = new Shards(rpc, signer.accountId)
    this.chipfi = new Chipfi(rpc, signer.accountId)
    this.umbra = new Umbra(rpc, signer.accountId)
    this.meme = new MemeCooking(rpc, signer.accountId)
  }

  readonly meme: MemeCooking

  // ------------------------------------------------------------ meme.cooking

  /** Deposit NEAR into a live presale. Returns what the launchpad credited (after its 0.5% fee). */
  async presaleDeposit(id: number, nearAmount: bigint): Promise<{ hash: string; credited: bigint; symbol: string }> {
    const st = await this.meme.status(id)
    if (st.kind === 'upcoming') throw new TradeError(`this presale opens ${new Date(st.startsAt).toUTCString()}`)
    if (st.kind !== 'live') throw new TradeError('this presale is not open for deposits')
    const hard = st.meme.hard_cap ? BigInt(st.meme.hard_cap) : null
    if (hard !== null && BigInt(st.meme.total_staked) >= hard) throw new TradeError('this presale is already at its hard cap')
    await this.assertSpendable(nearAmount + 30_000_000_000_000_000_000_000n)
    const setup = await registrationTxs(this.rpc, [WRAP], this.me)
    const storage = await this.meme.storageTx()
    await this.signer.sendAll(storage ? [...setup, storage] : setup)
    const before = (await this.meme.deposits()).get(id) ?? 0n
    const tx = await this.signer.send(this.meme.depositTx(id, nearAmount))
    let credited = 0n
    for (let i = 0; i < 10 && credited <= 0n; i++) {
      credited = ((await this.meme.deposits()).get(id) ?? 0n) - before
      if (credited <= 0n) await new Promise((r) => setTimeout(r, 500))
    }
    if (credited <= 0n) throw new TradeError('the deposit was refunded by meme.cooking (sale closed or full?)', tx.transaction.hash)
    const prev = this.store.state.presales[String(id)]
    this.store.state.presales[String(id)] = {
      symbol: st.meme.symbol,
      costNear: ((prev ? BigInt(prev.costNear) : 0n) + nearAmount).toString(),
      costUsd: (prev?.costUsd ?? 0) + (Number(nearAmount) / 1e24) * this.cachedNearUsd(),
      at: prev?.at ?? Date.now(),
    }
    this.store.save()
    return { hash: tx.transaction.hash, credited, symbol: st.meme.symbol }
  }

  /** Pull a deposit out before the presale ends (2% fee), back to native NEAR. */
  async presaleWithdraw(id: number): Promise<{ hash: string; received: bigint }> {
    const st = await this.meme.status(id)
    if (st.kind !== 'live') throw new TradeError('withdrawals are only possible while the presale is open — after it ends, use Claim')
    const amount = (await this.meme.deposits()).get(id) ?? 0n
    if (!amount) throw new TradeError('you have no deposit in this presale')
    const wBefore = await ftBalance(this.rpc, WRAP, this.me, 'freshest')
    const tx = await this.signer.send(this.meme.withdrawTx(id, amount))
    const received = await this.unwrapGained(wBefore)
    delete this.store.state.presales[String(id)]
    this.store.save()
    return { hash: tx.transaction.hash, received }
  }

  /**
   * After a presale ends: tokens if it launched (registered on the token
   * first, and checked to arrive), or the deposit back if it failed.
   */
  async presaleClaim(id: number): Promise<{ hash: string; kind: 'tokens' | 'refund'; amount: bigint; tokenId?: string; symbol: string }> {
    const st = await this.meme.status(id)
    const record = this.store.state.presales[String(id)]
    if (st.kind === 'launched') {
      const tokens = await this.meme.claimableTokens(id)
      if (!tokens) throw new TradeError('nothing to claim for this meme')
      await this.signer.sendAll(await registrationTxs(this.rpc, [st.tokenId], this.me))
      const tx = await this.signer.send(this.meme.claimTx(id))
      await this.assertDelivered(st.tokenId, tokens, tx.transaction.hash)
      const meta = await ftMetadata(this.rpc, st.tokenId)
      // The presale deposit becomes the position's cost, so Positions shows its PnL and entry MC.
      if (record) {
        this.store.recordBuy(st.tokenId, {
          symbol: meta.symbol,
          decimals: meta.decimals,
          tokens,
          costNear: BigInt(record.costNear),
          costJambo: 0n,
          source: 'presale',
          nearUsd: record.costUsd && Number(record.costNear) ? record.costUsd / (Number(record.costNear) / 1e24) : this.cachedNearUsd(),
        })
        delete this.store.state.presales[String(id)]
        this.store.save()
      }
      return { hash: tx.transaction.hash, kind: 'tokens', amount: tokens, tokenId: st.tokenId, symbol: meta.symbol }
    }
    if (st.kind === 'failed') {
      const wBefore = await ftBalance(this.rpc, WRAP, this.me, 'freshest')
      const tx = await this.signer.send(this.meme.claimTx(id))
      const received = await this.unwrapGained(wBefore)
      delete this.store.state.presales[String(id)]
      this.store.save()
      return { hash: tx.transaction.hash, kind: 'refund', amount: received, symbol: record?.symbol ?? `#${id}` }
    }
    throw new TradeError(st.kind === 'ended' ? 'the presale ended and is waiting to be finalized — try again shortly' : 'this presale has not ended yet')
  }

  /** Unwraps whatever wNEAR arrived since `before` (payouts land a moment later). */
  private async unwrapGained(before: bigint): Promise<bigint> {
    let gained = 0n
    for (let i = 0; i < 10 && gained <= 0n; i++) {
      gained = (await ftBalance(this.rpc, WRAP, this.me, 'freshest')) - before
      if (gained <= 0n) await new Promise((r) => setTimeout(r, 500))
    }
    if (gained > 0n) await this.signer.send(this.meme.unwrapTx(gained))
    return gained
  }

  readonly shards: Shards
  readonly chipfi: Chipfi
  readonly umbra: Umbra

  // ---------------------------------------------------------------- prices (display)

  private usd: { value: number; at: number } | null = null
  private readonly supplies = new Map<string, { value: number; at: number }>()

  /** NEAR in USD, from Intear's price feed (router quote as fallback). Cached 60s. */
  async nearUsd(): Promise<number> {
    if (this.usd && Date.now() - this.usd.at < 60_000) return this.usd.value
    let value = await fetch('https://prices.intear.tech/price?token_id=wrap.near', { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.json() as Promise<number>)
      .catch(() => 0)
    if (!(value > 0)) {
      const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
      const route = await this.router.best({ tokenIn: 'near', tokenOut: USDC, amountIn: ONE_NEAR, slippageBps: 100, trader: this.me }).catch(() => null)
      value = route ? Number(route.estimatedOut) / 1e6 : this.usd?.value ?? 0
    }
    this.usd = { value, at: Date.now() }
    return value
  }

  /** Last known NEAR price, without waiting (0 if never fetched). */
  cachedNearUsd(): number {
    return this.usd?.value ?? 0
  }

  /** Whole tokens in existence. Cached 5 min. */
  async supply(tokenId: string, decimals: number): Promise<number> {
    const hit = this.supplies.get(tokenId)
    if (hit && Date.now() - hit.at < 300_000) return hit.value
    const raw = await this.rpc.view<string>(tokenId, 'ft_total_supply')
    const value = Number(BigInt(raw)) / 10 ** decimals
    this.supplies.set(tokenId, { value, at: Date.now() })
    return value
  }

  /**
   * Current price of one whole token in NEAR. Launchpad curves are read from
   * their own contracts (exact, live); everything else from Intear's price feed.
   */
  async priceNear(tokenId: string, decimals: number): Promise<number | null> {
    try {
      if (isNearlyToken(tokenId)) {
        const info = await nearlyInfo(tokenId)
        if (info && info.priceNear > 0) return info.priceNear
      } else if (isShardsToken(tokenId)) {
        const st = await this.rpc.view<any>(tokenId, 'get_state', {}, 'optimistic')
        const [q, t] = st.phase === 'live_amm' ? [st.pool_quote, st.pool_token] : [st.virtual_quote, st.virtual_token]
        const cfg = await this.shards.config(tokenId)
        if (cfg.quote_asset_id === WRAP && BigInt(t) > 0n) return Number(BigInt(q)) / 1e24 / (Number(BigInt(t)) / 10 ** decimals)
      } else if (isChipfiToken(tokenId)) {
        const info = await this.chipfi.info(tokenId)
        if (info.phase === 'Curve' && Chipfi.pairedWithNear(info)) return Chipfi.drained(info) ? 0 : Number(BigInt((info as any).price)) / 1e24
      } else if (isUmbraToken(tokenId)) {
        const c = await this.umbra.curve(tokenId)
        if (!c.graduated && Umbra.pairedWithNear(c)) return Number(BigInt(c.spot_price)) / 1e24
      } else if (isGaypadToken(tokenId)) {
        const st = await this.gaypad.swapState(tokenId, 'optimistic')
        if (st && !st.is_deployed && BigInt(st.token_hold) > 0n) {
          // wnear_hold is the curve's JAMBO side (virtual + real).
          const jamboPerToken = Number(BigInt(st.wnear_hold)) / 1e18 / (Number(BigInt(st.token_hold)) / 10 ** decimals)
          const jamboPerNear = Number(await this.jamboPerNear()) / 1e18
          return jamboPerToken / jamboPerNear
        }
      }
    } catch {
      /* fall through to the price feed */
    }
    const [usdPrice, nearUsd] = await Promise.all([
      fetch(`https://prices.intear.tech/price?token_id=${encodeURIComponent(tokenId)}`, { signal: AbortSignal.timeout(5_000) })
        .then((r) => r.json() as Promise<number>)
        .catch(() => 0),
      this.nearUsd(),
    ])
    return usdPrice > 0 && nearUsd > 0 ? usdPrice / nearUsd : null
  }

  /** Market cap in NEAR: price × supply. */
  async marketCapNear(tokenId: string, decimals: number): Promise<number | null> {
    const [price, supply] = await Promise.all([this.priceNear(tokenId, decimals), this.supply(tokenId, decimals).catch(() => 0)])
    return price === null || !supply ? null : price * supply
  }

  private recordBuy(tokenId: string, p: Parameters<Store['recordBuy']>[1]): void {
    this.store.recordBuy(tokenId, { ...p, nearUsd: this.cachedNearUsd() })
  }

  private recordSell(tokenId: string, p: Parameters<Store['recordSell']>[1]): void {
    this.store.recordSell(tokenId, { ...p, nearUsd: this.cachedNearUsd() })
  }

  // ---------------------------------------------------------------- pricing

  /** JAMBO base units per 1 NEAR, from the best DEX route. Cached 60s. */
  async jamboPerNear(): Promise<bigint> {
    if (this.rate && Date.now() - this.rate.at < 60_000) return this.rate.jamboPerNear
    const route = await this.router.best({ tokenIn: 'near', tokenOut: JAMBO, amountIn: ONE_NEAR, slippageBps: 100, trader: this.me })
    if (!route) throw new TradeError('no NEAR→JAMBO route right now')
    this.rate = { jamboPerNear: route.estimatedOut, at: Date.now() }
    return route.estimatedOut
  }

  async jamboInNear(jambo: bigint): Promise<bigint> {
    return mulDiv(jambo, ONE_NEAR, await this.jamboPerNear())
  }

  async jamboBalance(force = false): Promise<bigint> {
    if (!force && this.jamboBal && Date.now() - this.jamboBal.at < 20_000) return this.jamboBal.value
    // Newest block, not "final": final lags 1–2 blocks, so right after a
    // conversion it still shows the old balance (this once cancelled a snipe).
    const value = await ftBalance(this.rpc, JAMBO, this.me, 'freshest')
    this.jamboBal = { value, at: Date.now() }
    return value
  }

  /**
   * NEAR gained since `before`. Payouts can land a block after the tx
   * "finishes" (NEAR bundles them with the gas refund), so this waits up to
   * ~5s for the balance to rise instead of reading it once.
   */
  private async nearReceived(before: bigint): Promise<bigint> {
    let after = await this.nearBalance()
    for (let i = 0; i < 10 && after <= before; i++) {
      await new Promise((r) => setTimeout(r, 500))
      after = await this.nearBalance()
    }
    return after > before ? after - before : 0n
  }

  async nearBalance(): Promise<bigint> {
    return (await this.rpc.nativeBalance(this.me)).amount
  }

  async venueOf(tokenId: string): Promise<{ venue: Venue; state: SwapState | null }> {
    if (isNearlyToken(tokenId)) return { venue: 'nearly', state: null }
    if (isShardsToken(tokenId)) return { venue: 'shards', state: null }
    if (isUmbraToken(tokenId)) {
      const c = await this.umbra.curve(tokenId).catch(() => null)
      return { venue: c?.graduated ? 'dex' : 'umbra', state: null }
    }
    if (isChipfiToken(tokenId)) {
      // Graduated coins trade on Rhea like any other token.
      const info = await this.chipfi.info(tokenId).catch(() => null)
      return { venue: info?.phase === 'Pool' ? 'dex' : 'chipfi', state: null }
    }
    if (!isGaypadToken(tokenId)) return { venue: 'dex', state: null }
    const state = await this.gaypad.swapState(tokenId)
    return { venue: state?.is_tradable && !state.is_deployed ? 'curve' : 'dex', state }
  }

  async view(tokenId: string): Promise<TokenView> {
    const [meta, { venue, state }, balance] = await Promise.all([
      ftMetadata(this.rpc, tokenId),
      this.venueOf(tokenId),
      ftBalance(this.rpc, tokenId, this.me),
    ])
    return { tokenId, meta, venue, state, balance, valueNear: await this.valueOf(tokenId, venue, balance) }
  }

  /** What `amount` of the token would sell for right now, in NEAR. */
  async valueOf(tokenId: string, venue: Venue, amount: bigint): Promise<bigint | null> {
    if (amount === 0n) return 0n
    try {
      if (venue === 'chipfi') {
        // An emptied curve still quotes a price, but can't pay it: worth nothing until refilled.
        if (Chipfi.drained(await this.chipfi.info(tokenId))) return 0n
        return await this.chipfi.quoteSell(tokenId, amount)
      }
      if (venue === 'umbra') {
        const c = await this.umbra.curve(tokenId)
        const q = Umbra.quoteSell(c, amount)
        if (q === null || Umbra.pairedWithNear(c)) return q
        // Stock-quoted: value the stock-token proceeds back in NEAR.
        const r = await this.router.best({ tokenIn: c.quote_token!, tokenOut: 'near', amountIn: q, slippageBps: 100, trader: this.me })
        return r?.estimatedOut ?? null
      }
      if (venue === 'shards') {
        const cfg = await this.shards.config(tokenId)
        if (cfg.quote_asset_id !== WRAP) return null
        return (await this.shards.quote(tokenId, 'sell', amount))?.amountOut ?? null
      }
      if (venue === 'curve') {
        const emu = await this.gaypad.emulate(tokenId, JAMBO, amount)
        if (emu) return this.jamboInNear(emu.amountOut)
        // Too small to clear the flat 60 JAMBO fee: value it at the spot price instead.
        const probe = 10n ** 21n
        const spot = await this.gaypad.emulate(JAMBO, tokenId, probe)
        return spot?.amountOut ? this.jamboInNear(mulDiv(amount, probe, spot.amountOut)) : null
      }
      if (venue === 'nearly') {
        const info = await nearlyInfo(tokenId)
        if (info && !info.quoteIsNear) {
          // Two hops: token → quote → NEAR, estimated only (no transaction).
          const r1 = await this.router.best({ tokenIn: tokenId, tokenOut: info.quote, amountIn: amount, slippageBps: 100, trader: this.me })
          if (r1?.estimatedOut) {
            const r2 = await this.router.best({ tokenIn: info.quote, tokenOut: 'near', amountIn: r1.estimatedOut, slippageBps: 100, trader: this.me })
            if (r2) return r2.estimatedOut
          }
          // Fall back to nearly.trade's own price.
          const meta = await ftMetadata(this.rpc, tokenId)
          return info.priceNear > 0 ? BigInt(Math.round(info.priceNear * (Number(amount) / 10 ** meta.decimals) * 1e24)) : null
        }
        // NEAR-quoted: a single router hop.
      }
      const route = await this.router.best({ tokenIn: tokenId, tokenOut: 'near', amountIn: amount, slippageBps: 100, trader: this.me })
      return route?.estimatedOut ?? null
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------ JAMBO

  /** NEAR always left in the wallet for gas. */
  static readonly GAS_RESERVE = ONE_NEAR / 20n // 0.05 NEAR

  /** JAMBO conversions run one at a time, so parallel launches never double-buy. */
  private jamboLock: Promise<unknown> = Promise.resolve()
  private withJamboLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.jamboLock.then(fn, fn)
    this.jamboLock = run.catch(() => {})
    return run
  }

  /** Registers the wallet on JAMBO if it never held any ("account is not registered"). */
  private async registerJambo(): Promise<void> {
    await this.signer.sendAll(await registrationTxs(this.rpc, [JAMBO], this.me))
  }

  private async assertSpendable(nearNeeded: bigint): Promise<void> {
    const near = await this.nearBalance()
    if (near < nearNeeded + Trader.GAS_RESERVE) {
      throw new TradeError(
        `not enough NEAR to convert to JAMBO: need ~${formatNear(nearNeeded + Trader.GAS_RESERVE, 3)}, have ${formatNear(near, 3)}`,
      )
    }
  }

  /** Buy JAMBO with a NEAR amount. */
  async topUpJambo(nearAmount: bigint, slippageBps: number): Promise<{ hash: string; jambo: bigint }> {
    return this.withJamboLock(async () => {
      await this.assertSpendable(nearAmount)
      await this.registerJambo()
      const route = await this.router.best({ tokenIn: 'near', tokenOut: JAMBO, amountIn: nearAmount, slippageBps, trader: this.me })
      if (!route) throw new TradeError('no NEAR→JAMBO route right now')
      const before = await ftBalance(this.rpc, JAMBO, this.me, 'freshest')
      const results = await this.signer.sendAll(route.txs)
      const jambo = (await this.jamboBalance(true)) - before
      return { hash: lastHash(results), jambo }
    })
  }

  /** Slippage for NEAR→JAMBO conversions: JAMBO has deep pools, so keep this tight. */
  static readonly CONVERT_SLIPPAGE_BPS = 200
  /** Refuse a conversion that would pay this much more than the spot price. */
  static readonly MAX_CONVERT_PREMIUM_BPS = 2_500

  /**
   * Make sure at least `amount` JAMBO is in the wallet, converting the
   * shortfall from NEAR automatically. Returns the NEAR spent (0 if none).
   *
   * Always "spend exactly X NEAR" (exact-in): the router's "buy exactly X
   * JAMBO" (exact-out) quotes only come from one thin pool and cost ~6× more.
   * X is sized from the spot price, then checked against the route's
   * guaranteed output and bumped if short.
   */
  async ensureJambo(amount: bigint, _slippageBps?: number): Promise<bigint> {
    return this.withJamboLock(async () => {
      const bal = await this.jamboBalance(true)
      if (bal >= amount) return 0n
      const short = amount - bal
      this.rate = null
      const spot = mulDiv(short, ONE_NEAR, await this.jamboPerNear())
      let nearIn = (spot * 10_350n) / 10_000n // spot + slippage + a little headroom
      let route = null
      for (let attempt = 0; attempt < 3; attempt++) {
        route = await this.router.best({
          tokenIn: 'near',
          tokenOut: JAMBO,
          amountIn: nearIn,
          slippageBps: Trader.CONVERT_SLIPPAGE_BPS,
          trader: this.me,
        })
        if (!route) throw new TradeError('no route to convert NEAR to JAMBO right now')
        if (route.worstOut >= short) break
        // Scale up by how far short the guaranteed output fell, plus 1%.
        nearIn = (mulDiv(nearIn, short, route.worstOut || 1n) * 10_100n) / 10_000n
        route = null
      }
      if (!route) throw new TradeError('could not find a NEAR→JAMBO route that delivers enough JAMBO')
      if (nearIn > spot + applyBps(spot, Trader.MAX_CONVERT_PREMIUM_BPS)) {
        throw new TradeError(`NEAR→JAMBO price is unusually bad right now (${formatNear(nearIn, 3)} NEAR for ~${formatNear(spot, 3)} worth) — not converting`)
      }
      await this.assertSpendable(nearIn)
      await this.registerJambo()
      await this.signer.sendAll(route.txs)
      this.jamboBal = null
      await this.waitForJambo(amount)
      return nearIn
    })
  }

  /** Waits until the wallet shows at least `amount` JAMBO (a swap's payout can land a block later). */
  private async waitForJambo(amount: bigint): Promise<void> {
    for (let i = 0; i < 10; i++) {
      if ((await this.jamboBalance(true)) >= amount) return
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new TradeError('converted NEAR to JAMBO but the JAMBO has not shown up in the wallet yet — check the wallet before retrying')
  }

  /** Swap JAMBO to NEAR. Returns the NEAR received (measured). */
  async jamboToNear(amount: bigint, slippageBps: number): Promise<{ hash: string; near: bigint }> {
    const route = await this.router.best({ tokenIn: JAMBO, tokenOut: 'near', amountIn: amount, slippageBps, trader: this.me })
    if (!route) throw new TradeError('no JAMBO→NEAR route right now')
    const before = await this.nearBalance()
    const results = await this.signer.sendAll(route.txs)
    this.jamboBal = null
    const got = await this.nearReceived(before)
    // Measured, so it is net of gas; the estimate is the fallback if gas outweighs a tiny swap.
    return { hash: lastHash(results), near: got > 0n ? got : route.estimatedOut }
  }

  // ------------------------------------------------------------------ curve

  /** Quote a curve buy. Uses optimistic finality: fresher state for snipes. */
  async prepareCurveBuy(tokenId: string, size: bigint, slippageBps: number): Promise<PreparedCurveBuy> {
    const sizes = await this.gaypad.allowedSizes()
    if (!sizes.includes(size)) throw new TradeError('gaypad only accepts its fixed buy sizes')
    const emu = await this.gaypad.emulate(JAMBO, tokenId, size, 'optimistic')
    if (!emu || !emu.isTradable) throw new TradeError('the curve is not accepting buys for this token')
    if (emu.isDeployed) throw new TradeError('token already graduated to a DEX')
    return { tokenId, size, expectedOut: emu.amountOut, minOut: minusBps(emu.amountOut, slippageBps) }
  }

  async executeCurveBuy(p: PreparedCurveBuy, opts: { fast?: boolean; source: Position['source'] }): Promise<BuyResult> {
    // gaypad pays out with a plain ft_transfer: unregistered buyers lose the tokens.
    await this.signer.sendAll(await registrationTxs(this.rpc, [p.tokenId], this.me))
    const tx = await this.signer.send(this.gaypad.buyTx(p.tokenId, p.size, p.minOut), { fast: opts.fast })
    this.jamboBal = null
    const swap = this.gaypad.swapIn(tx)
    if (!swap) {
      throw new TradeError('the curve refunded the buy (price moved past slippage, or the size was rejected)', tx.transaction.hash)
    }
    await this.assertDelivered(p.tokenId, swap.outputAmount, tx.transaction.hash)
    const [meta, costNear] = await Promise.all([ftMetadata(this.rpc, p.tokenId), this.jamboInNear(swap.inputAmount).catch(() => 0n)])
    this.recordBuy(p.tokenId, {
      symbol: meta.symbol,
      decimals: meta.decimals,
      tokens: swap.outputAmount,
      costNear,
      costJambo: swap.inputAmount,
      source: opts.source,
    })
    return { hash: tx.transaction.hash, tokens: swap.outputAmount, decimals: meta.decimals, costNear, jamboIn: swap.inputAmount }
  }

  // ------------------------------------------------------------ curve amounts

  /** Resolve a NEAR/JAMBO amount to the gaypad-sized buys that will be sent. */
  async planBuy(amount: Amount): Promise<{ chunks: bigint[]; total: bigint }> {
    const [rate, allowed] = await Promise.all([
      amount.unit === 'near' ? this.jamboPerNear() : Promise.resolve(0n),
      this.gaypad.allowedSizes(),
    ])
    const chunks = planChunks(targetJambo(amount, rate), allowed)
    return { chunks, total: chunks.reduce((a, b) => a + b, 0n) }
  }

  /**
   * Manual curve buy of any amount: split into gaypad's sizes, NEAR converted
   * to JAMBO as needed, each chunk bought in turn with the manual slippage.
   */
  async buyCurveAmount(tokenId: string, amount: Amount): Promise<BuyResult & { chunks: bigint[] }> {
    const { chunks, total } = await this.planBuy(amount)
    const slip = this.store.state.settings.slippageBps
    await this.ensureJambo(total, slip)
    let tokens = 0n
    let costNear = 0n
    let jamboIn = 0n
    let last: BuyResult | null = null
    for (const size of chunks) {
      last = await this.executeCurveBuy(await this.prepareCurveBuy(tokenId, size, slip), { source: 'manual' })
      tokens += last.tokens
      costNear += last.costNear
      jamboIn += last.jamboIn
    }
    return { hash: last!.hash, tokens, decimals: last!.decimals, costNear, jamboIn, chunks }
  }

  /**
   * gaypad swaps first and pays out afterwards with a plain ft_transfer. If
   * that transfer fails the tokens are stranded in gaypad, and the swap event
   * still says we bought — so check the wallet actually received them.
   */
  private async assertDelivered(tokenId: string, tokens: bigint, hash: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const bal = await ftBalance(this.rpc, tokenId, this.me, 'freshest').catch(() => null)
      if (bal !== null && bal >= tokens) return
      await new Promise((r) => setTimeout(r, 800))
    }
    throw new TradeError(`gaypad took the JAMBO but the ${tokenId} tokens did not arrive in the wallet`, hash)
  }

  /** Manual curve buy: tops up JAMBO from NEAR if needed. */
  async buyCurve(tokenId: string, size: bigint): Promise<BuyResult> {
    const slip = this.store.state.settings.slippageBps
    await this.ensureJambo(size, slip)
    return this.executeCurveBuy(await this.prepareCurveBuy(tokenId, size, slip), { source: 'manual' })
  }

  // -------------------------------------------------------------------- dex

  /** Buy with a NEAR amount on whatever market the token trades on (not the gaypad curve). */
  async buyWithNear(tokenId: string, nearAmount: bigint): Promise<BuyResult> {
    const { venue } = await this.venueOf(tokenId)
    if (venue === 'shards') return this.buyShards(tokenId, nearAmount)
    if (venue === 'chipfi') return this.buyChipfi(tokenId, nearAmount)
    if (venue === 'umbra') return this.buyUmbra(tokenId, nearAmount)
    if (venue === 'nearly') return this.buyNearly(tokenId, nearAmount)
    return this.buyDex(tokenId, nearAmount)
  }

  // Storage registrations already satisfied this session — so repeat trades
  // don't re-send the same storage_deposit and pay the round trip again.
  private readonly registered = new Set<string>()

  private isStorageDeposit(tx: PlannedTx): boolean {
    return tx.actions.length === 1 && (tx.actions[0] as unknown as { functionCall?: { methodName?: string } }).functionCall?.methodName === 'storage_deposit'
  }

  /**
   * Sends a router's transactions, but first drops any storage_deposit that is
   * already done (checked in parallel, read-only). This is the main speed win:
   * a repeat buy on a token you already hold sends only the swap. The swap is
   * fast-broadcast to every RPC at once.
   */
  private async sendRoute(txs: PlannedTx[]): Promise<TxResult[]> {
    const needed = await Promise.all(
      txs.map(async (tx) => {
        if (!this.isStorageDeposit(tx)) return true
        if (this.registered.has(tx.receiverId)) return false
        const reg = await this.rpc.view<unknown>(tx.receiverId, 'storage_balance_of', { account_id: this.me }).catch(() => 'unknown')
        if (reg !== null) {
          this.registered.add(tx.receiverId) // registered, or no storage mgmt — either way skip
          return false
        }
        return true
      }),
    )
    const filtered = txs.filter((_, i) => needed[i])
    const results: TxResult[] = []
    for (const tx of filtered) {
      results.push(await this.signer.send(tx, { fast: true }))
      if (this.isStorageDeposit(tx)) this.registered.add(tx.receiverId)
    }
    return results
  }

  /**
   * One router swap, sent and measured. `out` is the actual amount received
   * (native NEAR is measured net of gas; a token by its balance delta).
   */
  private async routerSwap(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<{ hash: string; out: bigint }> {
    const slip = this.store.state.settings.slippageBps
    const route = await this.router.best({ tokenIn, tokenOut, amountIn, slippageBps: slip, trader: this.me })
    const nameOf = (t: string) => (t === 'near' ? 'NEAR' : (t.split('.')[0] ?? t))
    if (!route) throw new TradeError(`no route ${nameOf(tokenIn)} → ${nameOf(tokenOut)} (liquidity too thin?)`)
    if (tokenOut === 'near') {
      const before = await this.nearBalance()
      const results = await this.sendRoute(route.txs)
      const got = await this.nearReceived(before)
      return { hash: lastHash(results), out: got > 0n ? got : route.estimatedOut }
    }
    const before = await ftBalance(this.rpc, tokenOut, this.me, 'freshest')
    const results = await this.sendRoute(route.txs)
    // The swap credits the output in the same transaction; a couple of quick
    // freshest reads cover the case where a node is a block behind.
    let out = 0n
    for (let i = 0; i < 4 && out <= 0n; i++) {
      out = (await ftBalance(this.rpc, tokenOut, this.me, 'freshest')) - before
      if (out <= 0n) await new Promise((r) => setTimeout(r, 300))
    }
    return { hash: lastHash(results), out: out > 0n ? out : route.estimatedOut }
  }

  /**
   * nearly.trade buy with NEAR. NEAR-quoted pairs go straight through the DEX
   * path; other quotes (NEARLY, RHEA, ZEC, a tokenized stock) are reached in
   * two router hops: NEAR → quote → token, both on Rhea DCL.
   */
  async buyNearly(tokenId: string, nearAmount: bigint): Promise<BuyResult> {
    const info = await nearlyInfo(tokenId)
    if (!info || info.quoteIsNear) return this.buyDex(tokenId, nearAmount)
    await this.assertSpendable(nearAmount)
    const hop1 = await this.routerSwap('near', info.quote, nearAmount)
    const hop2 = await this.routerSwap(info.quote, tokenId, hop1.out)
    const meta = await ftMetadata(this.rpc, tokenId)
    this.recordBuy(tokenId, { symbol: meta.symbol, decimals: meta.decimals, tokens: hop2.out, costNear: nearAmount, costJambo: 0n, source: 'manual' })
    return { hash: hop2.hash, tokens: hop2.out, decimals: meta.decimals, costNear: nearAmount, jamboIn: 0n }
  }

  /** umbrapad: register, then `buy` with NEAR attached; priced with umbrapad's own curve formula. */
  async buyUmbra(tokenId: string, nearAmount: bigint): Promise<BuyResult> {
    const curve = await this.umbra.curve(tokenId)
    if (curve.graduated) throw new TradeError('this coin has graduated — it trades on Rhea now')
    await this.assertSpendable(nearAmount)
    if (!Umbra.pairedWithNear(curve)) return this.buyUmbraStock(tokenId, curve, nearAmount)
    const quoted = Umbra.quoteBuy(curve, nearAmount)
    if (!quoted) throw new TradeError('that buy is too big for what is left on the curve')
    // The coin refuses unregistered buyers ("storage_deposit first").
    await this.signer.sendAll(await registrationTxs(this.rpc, [tokenId], this.me))
    const before = await ftBalance(this.rpc, tokenId, this.me, 'freshest')
    const tx = await this.signer.send(this.umbra.buyTx(tokenId, nearAmount, minusBps(quoted, this.store.state.settings.slippageBps)))
    // No trade event on umbrapad: the tokens received are measured.
    let tokens = 0n
    for (let i = 0; i < 10 && tokens <= 0n; i++) {
      tokens = (await ftBalance(this.rpc, tokenId, this.me, 'freshest')) - before
      if (tokens <= 0n) await new Promise((r) => setTimeout(r, 500))
    }
    if (tokens <= 0n) throw new TradeError('the buy went through but no tokens arrived — check the wallet', tx.transaction.hash)
    const meta = await ftMetadata(this.rpc, tokenId)
    this.recordBuy(tokenId, { symbol: meta.symbol, decimals: meta.decimals, tokens, costNear: nearAmount, costJambo: 0n, source: 'manual' })
    return { hash: tx.transaction.hash, tokens, decimals: meta.decimals, costNear: nearAmount, jamboIn: 0n }
  }

  /**
   * umbrapad coin quoted in a tokenized stock (e.g. AAPLon / NVDAon, which are
   * `bnb-….omdep.near`): buy the stock token with NEAR via the router, then buy
   * the coin on its curve by sending that stock token with ft_transfer_call.
   * Best-effort message format — if the coin rejects it, the stock is refunded
   * and left in the wallet (sell it back from the token panel).
   */
  private async buyUmbraStock(tokenId: string, curve: Awaited<ReturnType<Umbra['curve']>>, nearAmount: bigint): Promise<BuyResult> {
    const quoteToken = curve.quote_token!
    const hop1 = await this.routerSwap('near', quoteToken, nearAmount) // NEAR -> stock token
    const quoted = Umbra.quoteBuy(curve, hop1.out)
    if (!quoted) throw new TradeError(`bought the stock token but that buy is too big for what is left on the curve — the ${quoteToken.split('.')[0]} is now in your wallet`)
    await this.signer.sendAll(await registrationTxs(this.rpc, [tokenId], this.me))
    const before = await ftBalance(this.rpc, tokenId, this.me, 'freshest')
    const tx = await this.signer.send(this.umbra.buyWithQuoteTx(tokenId, quoteToken, hop1.out, minusBps(quoted, this.store.state.settings.slippageBps)))
    let tokens = 0n
    for (let i = 0; i < 8 && tokens <= 0n; i++) {
      tokens = (await ftBalance(this.rpc, tokenId, this.me, 'freshest')) - before
      if (tokens <= 0n) await new Promise((r) => setTimeout(r, 500))
    }
    if (tokens <= 0n) {
      throw new TradeError(
        `umbrapad refunded the stock token (the buy message format wasn't accepted). Your NEAR bought ${quoteToken.split('.')[0]}, which is now in your wallet — paste that token to sell it back.`,
        tx.transaction.hash,
      )
    }
    const meta = await ftMetadata(this.rpc, tokenId)
    this.recordBuy(tokenId, { symbol: meta.symbol, decimals: meta.decimals, tokens, costNear: nearAmount, costJambo: 0n, source: 'manual' })
    return { hash: tx.transaction.hash, tokens, decimals: meta.decimals, costNear: nearAmount, jamboIn: 0n }
  }

  /** chipfi.fun: `buy` with NEAR attached; the coin registers us out of the deposit. */
  async buyChipfi(tokenId: string, nearAmount: bigint): Promise<BuyResult> {
    const info = await this.chipfi.info(tokenId)
    if (!Chipfi.pairedWithNear(info)) throw new TradeError('this chipfi coin is paired with a token, not NEAR — not supported')
    if (info.phase !== 'Curve') throw new TradeError(info.phase === 'Graduating' ? 'this coin is moving to its Rhea pool — try again in a minute' : 'this coin is not on its curve')
    if (Chipfi.drained(info)) throw new TradeError('refusing to buy: the chipfi owner has withdrawn this curve\'s NEAR, so nobody can sell it back')
    await this.assertSpendable(nearAmount)
    const registered = (await this.rpc.view<unknown>(tokenId, 'storage_balance_of', { account_id: this.me }).catch(() => null)) !== null
    const pairIn = registered ? nearAmount : nearAmount - CHIPFI_STORAGE
    if (pairIn <= 0n) throw new TradeError('amount is too small')
    const quoted = await this.chipfi.quoteBuy(tokenId, pairIn)
    if (!quoted) throw new TradeError('chipfi will not take a buy of that size')
    const tx = await this.signer.send(this.chipfi.buyTx(tokenId, nearAmount, minusBps(quoted, this.store.state.settings.slippageBps)))
    const trade = this.chipfi.tradeIn(tx)
    if (!trade) throw new TradeError('chipfi did not report the buy', tx.transaction.hash)
    await this.assertDelivered(tokenId, trade.amountOut, tx.transaction.hash)
    const meta = await ftMetadata(this.rpc, tokenId)
    this.recordBuy(tokenId, { symbol: meta.symbol, decimals: meta.decimals, tokens: trade.amountOut, costNear: nearAmount, costJambo: 0n, source: 'manual' })
    return { hash: tx.transaction.hash, tokens: trade.amountOut, decimals: meta.decimals, costNear: nearAmount, jamboIn: 0n }
  }

  /** NEAR a holder can claim on a launchpad that shares fees (shards dividends/credit, chipfi dividends). */
  async claimable(tokenId: string): Promise<bigint> {
    if (isShardsToken(tokenId)) {
      const a = await this.shards.account(tokenId)
      return BigInt(a?.claimable_dividends ?? 0) + BigInt(a?.quote_credit ?? 0)
    }
    if (isChipfiToken(tokenId)) {
      const h = await this.chipfi.holder(tokenId)
      return BigInt(h?.claimable_dividends ?? 0) + BigInt(h?.credit ?? 0)
    }
    if (isUmbraToken(tokenId)) return this.umbra.owed(tokenId)
    return 0n
  }

  async claimRewards(tokenId: string): Promise<{ hash: string; amount: bigint }> {
    if (isChipfiToken(tokenId) || isUmbraToken(tokenId)) {
      const amount = await this.claimable(tokenId)
      if (!amount) throw new TradeError('nothing to claim on this coin')
      const tx = await this.signer.send(isUmbraToken(tokenId) ? this.umbra.claimTx(tokenId) : this.chipfi.claimTx(tokenId))
      return { hash: tx.transaction.hash, amount }
    }
    const r = await this.claimShards(tokenId)
    return { hash: r.hash, amount: r.dividends + r.credit }
  }

  /** shards.market: wrap + buy in one tx, after registering on the launch. */
  async buyShards(tokenId: string, nearAmount: bigint): Promise<BuyResult> {
    const cfg = await this.shards.config(tokenId)
    if (cfg.quote_asset_id !== WRAP) {
      throw new TradeError(`this shards launch trades against ${cfg.quote_asset_id}, not NEAR — not supported`)
    }
    if (!Shards.isLive(await this.shards.state(tokenId))) throw new TradeError('this shards launch is not open for trading')
    await this.assertSpendable(nearAmount)
    const q = await this.shards.quote(tokenId, 'buy', nearAmount)
    if (!q) throw new TradeError('shards will not take a buy of that size')
    // Registered on both, or the tokens / the wNEAR have nowhere to go.
    await this.signer.sendAll(await registrationTxs(this.rpc, [tokenId, WRAP], this.me))
    const tx = await this.signer.send(await this.shards.buyTx(tokenId, nearAmount, minusBps(q.amountOut, this.store.state.settings.slippageBps)))
    const trade = this.shards.tradeIn(tx)
    if (!trade) throw new TradeError('shards refunded the buy (price moved past slippage?)', tx.transaction.hash)
    await this.assertDelivered(tokenId, trade.amountOut, tx.transaction.hash)
    const meta = await ftMetadata(this.rpc, tokenId)
    this.recordBuy(tokenId, { symbol: meta.symbol, decimals: meta.decimals, tokens: trade.amountOut, costNear: trade.amountIn, costJambo: 0n, source: 'manual' })
    return { hash: tx.transaction.hash, tokens: trade.amountOut, decimals: meta.decimals, costNear: trade.amountIn, jamboIn: 0n }
  }

  /** shards pays dividends to holders and may hold unwithdrawn proceeds; this pays both out. */
  async claimShards(tokenId: string): Promise<{ hash: string; dividends: bigint; credit: bigint }> {
    const acct = await this.shards.account(tokenId)
    const dividends = BigInt(acct?.claimable_dividends ?? 0)
    const credit = BigInt(acct?.quote_credit ?? 0)
    if (!dividends && !credit) throw new TradeError('nothing to claim on this launch')
    const tx = await this.signer.send(this.shards.claimTx(tokenId, { dividends: dividends > 0n, credit: credit > 0n }))
    return { hash: tx.transaction.hash, dividends, credit }
  }

  async buyDex(tokenId: string, nearAmount: bigint): Promise<BuyResult> {
    const route = await this.router.best({
      tokenIn: 'near',
      tokenOut: tokenId,
      amountIn: nearAmount,
      slippageBps: this.store.state.settings.slippageBps,
      trader: this.me,
    })
    if (!route) throw new TradeError('no route found for this token')
    const before = await ftBalance(this.rpc, tokenId, this.me, 'freshest')
    const results = await this.sendRoute(route.txs)
    let tokens = 0n
    for (let i = 0; i < 4 && tokens <= 0n; i++) {
      tokens = (await ftBalance(this.rpc, tokenId, this.me, 'freshest')) - before
      if (tokens <= 0n) await new Promise((r) => setTimeout(r, 300))
    }
    if (tokens <= 0n) tokens = route.estimatedOut
    const meta = await ftMetadata(this.rpc, tokenId)
    this.recordBuy(tokenId, { symbol: meta.symbol, decimals: meta.decimals, tokens, costNear: nearAmount, costJambo: 0n, source: 'manual' })
    return { hash: lastHash(results), tokens, decimals: meta.decimals, costNear: nearAmount, jamboIn: 0n }
  }

  // ------------------------------------------------------------------- sell

  /** Sell `pct` percent (1..100) of the holding; a position sold to zero is removed. */
  async sell(tokenId: string, pct: number): Promise<SellResult> {
    const result = await this.sellInner(tokenId, pct)
    const left = await ftBalance(this.rpc, tokenId, this.me, 'freshest').catch(() => null)
    if (left === 0n) this.store.closePosition(tokenId)
    return result
  }

  private async sellInner(tokenId: string, pct: number): Promise<SellResult> {
    const slip = this.store.state.settings.slippageBps
    const [balance, { venue }] = await Promise.all([ftBalance(this.rpc, tokenId, this.me), this.venueOf(tokenId)])
    const amount = pct >= 100 ? balance : (balance * BigInt(Math.round(pct * 100))) / 10_000n
    if (amount <= 0n) throw new TradeError('nothing to sell')

    if (venue === 'umbra') {
      const curve = await this.umbra.curve(tokenId)
      const quoted = Umbra.quoteSell(curve, amount)
      if (!quoted) throw new TradeError('umbrapad will not take a sell of that size')
      if (!Umbra.pairedWithNear(curve)) {
        // Stock-quoted coin: sell on the curve for the stock token, then route it back to NEAR.
        const quoteToken = curve.quote_token!
        const qBefore = await ftBalance(this.rpc, quoteToken, this.me, 'freshest')
        await this.signer.send(this.umbra.sellTx(tokenId, amount, minusBps(quoted, slip)))
        let quoteOut = 0n
        for (let i = 0; i < 8 && quoteOut <= 0n; i++) {
          quoteOut = (await ftBalance(this.rpc, quoteToken, this.me, 'freshest')) - qBefore
          if (quoteOut <= 0n) await new Promise((r) => setTimeout(r, 500))
        }
        if (quoteOut <= 0n) throw new TradeError('the umbrapad sell did not pay out the stock token — check the wallet')
        const back = await this.routerSwap(quoteToken, 'near', quoteOut)
        this.recordSell(tokenId, { tokens: amount, proceedsNear: back.out, proceedsJambo: 0n })
        return { hash: back.hash, tokens: amount, proceedsNear: back.out, jamboOut: 0n }
      }
      const before = await this.nearBalance()
      const tx = await this.signer.send(this.umbra.sellTx(tokenId, amount, minusBps(quoted, slip)))
      const got = await this.nearReceived(before)
      // Measured net of gas; the quote (which matched real trades exactly) covers a tiny sell swallowed by gas.
      const proceedsNear = got > 0n ? got : quoted
      this.recordSell(tokenId, { tokens: amount, proceedsNear, proceedsJambo: 0n })
      return { hash: tx.transaction.hash, tokens: amount, proceedsNear, jamboOut: 0n }
    }

    if (venue === 'chipfi') {
      const info = await this.chipfi.info(tokenId)
      if (!Chipfi.pairedWithNear(info)) throw new TradeError('this chipfi coin is paired with a token, not NEAR — not supported')
      if (Chipfi.drained(info)) {
        throw new TradeError('cannot sell: the chipfi owner withdrew this curve\'s NEAR (coin_collect_curve), so it has nothing to pay sellers with. You can still claim dividends.')
      }
      const quoted = await this.chipfi.quoteSell(tokenId, amount)
      if (!quoted) throw new TradeError('chipfi will not take a sell of that size')
      const tx = await this.signer.send(this.chipfi.sellTx(tokenId, amount, minusBps(quoted, slip)))
      const trade = this.chipfi.tradeIn(tx)
      if (!trade) throw new TradeError('chipfi did not report the sell', tx.transaction.hash)
      this.recordSell(tokenId, { tokens: trade.amountIn, proceedsNear: trade.amountOut, proceedsJambo: 0n })
      return { hash: tx.transaction.hash, tokens: trade.amountIn, proceedsNear: trade.amountOut, jamboOut: 0n }
    }

    if (venue === 'shards') {
      const cfg = await this.shards.config(tokenId)
      if (cfg.quote_asset_id !== WRAP) throw new TradeError(`this shards launch trades against ${cfg.quote_asset_id}, not NEAR — not supported`)
      const q = await this.shards.quote(tokenId, 'sell', amount)
      if (!q) throw new TradeError('shards will not take a sell of that size')
      const tx = await this.signer.send(await this.shards.sellTx(tokenId, amount, minusBps(q.amountOut, slip)))
      const trade = this.shards.tradeIn(tx)
      if (!trade) throw new TradeError('shards refunded the sell (price moved past slippage?)', tx.transaction.hash)
      // The sale is credited inside the launch; withdraw_quote in the same tx paid it out. Make sure.
      const left = BigInt((await this.shards.account(tokenId))?.quote_credit ?? 0)
      if (left > 0n) await this.signer.send(this.shards.claimTx(tokenId, { dividends: false, credit: true }))
      this.recordSell(tokenId, { tokens: trade.amountIn, proceedsNear: trade.amountOut, proceedsJambo: 0n })
      return { hash: tx.transaction.hash, tokens: trade.amountIn, proceedsNear: trade.amountOut, jamboOut: 0n }
    }

    if (venue === 'curve') {
      const emu = await this.gaypad.emulate(tokenId, JAMBO, amount)
      if (!emu) throw new TradeError('the curve refuses a sell this small (its flat 60 JAMBO fee is larger than the proceeds)')
      await this.signer.sendAll(await registrationTxs(this.rpc, [JAMBO], this.me))
      const tx = await this.signer.send(this.gaypad.sellTx(tokenId, amount, minusBps(emu.amountOut, slip)))
      const swap = this.gaypad.swapIn(tx)
      if (!swap) throw new TradeError('the curve refunded the sell (price moved past slippage)', tx.transaction.hash)
      this.jamboBal = null

      let proceedsNear: bigint
      let hash = tx.transaction.hash
      if (this.store.state.settings.sellToNear) {
        const conv = await this.jamboToNear(swap.outputAmount, slip)
        proceedsNear = conv.near
        hash = conv.hash
      } else {
        proceedsNear = await this.jamboInNear(swap.outputAmount).catch(() => 0n)
      }
      this.recordSell(tokenId, { tokens: swap.inputAmount, proceedsNear, proceedsJambo: swap.outputAmount })
      return { hash, tokens: swap.inputAmount, proceedsNear, jamboOut: swap.outputAmount }
    }

    if (venue === 'nearly') {
      const info = await nearlyInfo(tokenId)
      if (info && !info.quoteIsNear) {
        // Two hops back to NEAR: token → quote → NEAR, both on Rhea DCL.
        const hop1 = await this.routerSwap(tokenId, info.quote, amount)
        const hop2 = await this.routerSwap(info.quote, 'near', hop1.out)
        this.recordSell(tokenId, { tokens: amount, proceedsNear: hop2.out, proceedsJambo: 0n })
        return { hash: hop2.hash, tokens: amount, proceedsNear: hop2.out, jamboOut: 0n }
      }
      // NEAR-quoted: fall through to the single-hop router sell below.
    }

    const route = await this.router.best({ tokenIn: tokenId, tokenOut: 'near', amountIn: amount, slippageBps: slip, trader: this.me })
    if (!route) throw new TradeError('no route to sell this token')
    const before = await this.nearBalance()
    const results = await this.sendRoute(route.txs)
    const got = await this.nearReceived(before)
    const proceedsNear = got > 0n ? got : route.estimatedOut
    this.recordSell(tokenId, { tokens: amount, proceedsNear, proceedsJambo: 0n })
    return { hash: lastHash(results), tokens: amount, proceedsNear, jamboOut: 0n }
  }
}

const lastHash = (r: TxResult[]) => r[r.length - 1]?.transaction.hash ?? ''
