import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One user's trading state, in a single JSON file (data/users/<id>/state.json).
 * A handful of positions and settings per user, so a database would be overkill.
 * Amounts are stored as decimal strings of base units.
 */

export interface Position {
  symbol: string
  decimals: number
  /** Tokens received from all buys. */
  bought: string
  sold: string
  /** NEAR spent, including JAMBO legs valued at the time. */
  costNear: string
  proceedsNear: string
  /** JAMBO spent/received on the curve — exact, no conversion. */
  costJambo: string
  proceedsJambo: string
  firstBuyAt: number
  source: 'manual' | 'presale'
  /** USD value of the NEAR spent/received, at the NEAR price of each trade (display only). */
  costUsd?: number
  proceedsUsd?: number
}

export interface State {
  settings: {
    /** Slippage for trades, in basis points. */
    slippageBps: number
    /** After a curve sell, swap the JAMBO proceeds straight to NEAR. */
    sellToNear: boolean
  }
  positions: Record<string, Position>
  /** Profit/loss (yoctoNEAR) of positions that were fully sold and removed. */
  realizedNear: string
  realizedUsd: number
  closedCount: number
  /** meme.cooking deposits made through the bot: meme id → what was paid. */
  presales: Record<string, { symbol: string; costNear: string; costUsd?: number; at: number }>
}

const defaults = (): State => ({
  settings: { slippageBps: 1500, sellToNear: true },
  positions: {},
  realizedNear: '0',
  realizedUsd: 0,
  closedCount: 0,
  presales: {},
})

export class Store {
  readonly state: State
  private readonly file: string
  private saveTimer: NodeJS.Timeout | null = null

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'state.json')
    this.state = this.load()
  }

  private load(): State {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<State>
      const d = defaults()
      return {
        settings: { ...d.settings, ...parsed.settings },
        positions: parsed.positions ?? {},
        realizedNear: parsed.realizedNear ?? '0',
        realizedUsd: parsed.realizedUsd ?? 0,
        closedCount: parsed.closedCount ?? 0,
        presales: parsed.presales ?? {},
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return defaults()
    }
  }

  /** Coalesces bursts of changes into one write. */
  save(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 200)
  }

  flush(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file)
  }

  recordBuy(
    tokenId: string,
    p: { symbol: string; decimals: number; tokens: bigint; costNear: bigint; costJambo: bigint; source: Position['source']; nearUsd?: number },
  ): void {
    const pos = (this.state.positions[tokenId] ??= {
      symbol: p.symbol,
      decimals: p.decimals,
      bought: '0',
      sold: '0',
      costNear: '0',
      proceedsNear: '0',
      costJambo: '0',
      proceedsJambo: '0',
      firstBuyAt: Date.now(),
      source: p.source,
    })
    pos.bought = (BigInt(pos.bought) + p.tokens).toString()
    pos.costNear = (BigInt(pos.costNear) + p.costNear).toString()
    pos.costJambo = (BigInt(pos.costJambo) + p.costJambo).toString()
    if (p.nearUsd) pos.costUsd = (pos.costUsd ?? 0) + (Number(p.costNear) / 1e24) * p.nearUsd
    this.save()
  }

  /** Removes a fully sold position, folding its profit/loss into the realized total. */
  closePosition(tokenId: string): void {
    const pos = this.state.positions[tokenId]
    if (!pos) return
    const pnl = BigInt(pos.proceedsNear) - BigInt(pos.costNear)
    this.state.realizedNear = (BigInt(this.state.realizedNear) + pnl).toString()
    if (pos.costUsd !== undefined && pos.proceedsUsd !== undefined) this.state.realizedUsd += pos.proceedsUsd - pos.costUsd
    this.state.closedCount += 1
    delete this.state.positions[tokenId]
    this.save()
  }

  recordSell(tokenId: string, p: { tokens: bigint; proceedsNear: bigint; proceedsJambo: bigint; nearUsd?: number }): void {
    const pos = this.state.positions[tokenId]
    if (!pos) return
    pos.sold = (BigInt(pos.sold) + p.tokens).toString()
    pos.proceedsNear = (BigInt(pos.proceedsNear) + p.proceedsNear).toString()
    pos.proceedsJambo = (BigInt(pos.proceedsJambo) + p.proceedsJambo).toString()
    if (p.nearUsd) pos.proceedsUsd = (pos.proceedsUsd ?? 0) + (Number(p.proceedsNear) / 1e24) * p.nearUsd
    this.save()
  }
}
