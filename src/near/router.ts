import { transactions } from 'near-api-js'
import type { PlannedTx } from './signer.js'

/**
 * Intear DEX aggregator (router.intear.tech).
 *
 * Returns ready-made NEAR transactions (wrapping, storage registration and the
 * swap itself) across Rhea, Rhea DCL, Intear's own DEX and others. Routes that
 * need a signing flow other than plain NEAR transactions are skipped.
 */

export interface Route {
  dexId: string
  estimatedOut: bigint
  worstOut: bigint
  /** Set on exact-output routes. */
  estimatedIn?: bigint
  worstIn?: bigint
  txs: PlannedTx[]
}

export interface RouteRequest {
  tokenIn: string
  tokenOut: string
  amountIn?: bigint
  amountOut?: bigint
  slippageBps: number
  trader: string
}

const toId = (t: string) => (t === 'near' || t.includes(':') ? t : `nep141:${t}`)

export class Router {
  constructor(private readonly baseUrl: string) {}

  async routes(req: RouteRequest): Promise<Route[]> {
    const params = new URLSearchParams({
      token_in: toId(req.tokenIn),
      token_out: toId(req.tokenOut),
      max_wait_ms: '1500',
      slippage_type: 'Fixed',
      slippage: String(req.slippageBps / 10_000),
      trader_account_id: req.trader,
    })
    if (req.amountOut !== undefined) params.set('amount_out', req.amountOut.toString())
    else if (req.amountIn !== undefined) params.set('amount_in', req.amountIn.toString())
    else throw new Error('route needs amountIn or amountOut')

    let raw: any[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/route?${params}`, { signal: AbortSignal.timeout(8_000) })
        if (!res.ok) throw new Error(`router HTTP ${res.status}`)
        raw = (await res.json()) as any[]
        break
      } catch (err) {
        if (attempt === 2) throw new Error(`router unavailable: ${(err as Error).message}`)
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
      }
    }

    const routes: Route[] = []
    for (const r of raw) {
      const txs = decode(r.execution_instructions ?? [])
      if (!txs) continue
      routes.push({
        dexId: r.dex_id,
        estimatedOut: BigInt(r.estimated_amount?.amount_out ?? 0),
        worstOut: BigInt(r.worst_case_amount?.amount_out ?? 0),
        ...(r.estimated_amount?.amount_in !== undefined ? { estimatedIn: BigInt(r.estimated_amount.amount_in) } : {}),
        ...(r.worst_case_amount?.amount_in !== undefined ? { worstIn: BigInt(r.worst_case_amount.amount_in) } : {}),
        txs,
      })
    }
    // Rank by the guaranteed side: cheapest worst-case cost, or largest floor.
    return req.amountOut !== undefined
      ? routes.sort((a, b) => cmp(a.worstIn ?? 0n, b.worstIn ?? 0n))
      : routes.sort((a, b) => cmp(b.worstOut, a.worstOut))
  }

  async best(req: RouteRequest): Promise<Route | null> {
    return (await this.routes(req))[0] ?? null
  }
}

const cmp = (a: bigint, b: bigint) => (a === b ? 0 : a < b ? -1 : 1)

function decode(instructions: any[]): PlannedTx[] | null {
  const txs: PlannedTx[] = []
  for (const ins of instructions) {
    const t = ins?.NearTransaction
    if (!t) return null
    const actions = []
    for (const a of t.actions ?? []) {
      if (a.FunctionCall) {
        const fc = a.FunctionCall
        actions.push(
          transactions.functionCall(fc.method_name, Buffer.from(fc.args, 'base64'), BigInt(fc.gas ?? 30e12), BigInt(fc.deposit ?? 0)),
        )
      } else if (a.Transfer) {
        actions.push(transactions.transfer(BigInt(a.Transfer.deposit)))
      } else {
        return null
      }
    }
    txs.push({ receiverId: t.receiver_id, actions })
  }
  return txs.length ? txs : null
}
