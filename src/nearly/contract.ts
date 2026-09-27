/**
 * nearly.trade — token launchpad on NEAR.
 *
 * Tokens are `<symbol>.nearlytrade.near` and trade on **Rhea DCL** concentrated
 * liquidity pools (`pool_id` = "<tokenX>|<tokenY>|<fee>", fee 10000 = 1%). Each
 * token is quoted in one asset: wrap.near (NEAR), the RHEA token, ZEC, $NEARLY,
 * or a bridged tokenized stock (e.g. `bnb-0x….omdep.near`).
 *
 * The Intear router covers these Rhea DCL pools, so:
 *  - NEAR-quoted tokens trade NEAR↔token in one router hop (the normal DEX path).
 *  - Other-quoted tokens need two hops: NEAR↔quote, then quote↔token.
 *
 * This module only reads nearly.trade's public API for pool/price metadata; all
 * trading is done through the router in trade.ts.
 */

const WRAP = 'wrap.near'
const API = 'https://nearly.trade/api'

export const isNearlyToken = (id: string) => /\.nearlytrade\.near$/.test(id.trim().toLowerCase())

export interface NearlyInfo {
  token: string
  symbol: string
  name: string
  /** Quote asset the token is paired against on its Rhea DCL pool. */
  quote: string
  poolId: string
  /** True when the pair's quote is NEAR (wrap.near) — a single router hop. */
  quoteIsNear: boolean
  priceNear: number
  fdvNear: number
  liquidityNear: number
  supply: number
  holders: number
  volume24hNear: number
  change24h: number
  nearUsd: number
}

interface RawLaunch {
  token: string
  symbol: string
  name: string
  quote: string | null
  pool_id: string
  price_near: number
  fdv_near: number
  liquidity_near: number
  supply: number
  holders: number
  volume_24h_near: number
  change_24h: number
  near_usd: number
}

let cache: { at: number; byToken: Map<string, NearlyInfo> } | null = null

function shape(l: RawLaunch): NearlyInfo {
  const quote = l.quote ?? WRAP
  return {
    token: l.token,
    symbol: l.symbol,
    name: l.name,
    quote,
    poolId: l.pool_id,
    quoteIsNear: quote === WRAP || quote === 'near',
    priceNear: l.price_near,
    fdvNear: l.fdv_near,
    liquidityNear: l.liquidity_near,
    supply: l.supply,
    holders: l.holders,
    volume24hNear: l.volume_24h_near,
    change24h: l.change_24h,
    nearUsd: l.near_usd,
  }
}

/** All nearly.trade launches, keyed by token id. Cached for 60s. */
async function all(): Promise<Map<string, NearlyInfo>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.byToken
  const res = await fetch(`${API}/launches?sort=mcap&limit=1000&offset=0`, { signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`nearly.trade API HTTP ${res.status}`)
  const raw = (await res.json()) as RawLaunch[] | { launches?: RawLaunch[]; data?: RawLaunch[] }
  const list = Array.isArray(raw) ? raw : (raw.launches ?? raw.data ?? [])
  const byToken = new Map<string, NearlyInfo>()
  for (const l of list) if (l?.token) byToken.set(l.token, shape(l))
  cache = { at: Date.now(), byToken }
  return byToken
}

/** Pool/price info for one nearly.trade token, or null if the API doesn't list it. */
export async function nearlyInfo(token: string): Promise<NearlyInfo | null> {
  try {
    return (await all()).get(token.trim().toLowerCase()) ?? null
  } catch {
    return null
  }
}
