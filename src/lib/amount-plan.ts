import { formatCompact, parseUnits } from './amounts.js'

/** What the user asked to spend: "5" / "5 near" (NEAR) or "25k jambo" (JAMBO). */
export interface Amount {
  unit: 'near' | 'jambo'
  /** Whole-unit decimal string, e.g. "2.5" or "25000". */
  value: string
}

/** Most buys sent in one go for a single amount. */
export const MAX_CHUNKS = 4

export function parseAmount(input: string): Amount | null {
  const m = input
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([km])?\s*(near|n|jambo|j)?$/)
  if (!m) return null
  const mult = m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1
  const n = Number(m[1]) * mult
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[3]?.startsWith('j') ? 'jambo' : 'near'
  return { unit, value: String(n) }
}

export function describeAmount(a: Amount): string {
  return a.unit === 'near' ? `${a.value} NEAR` : `${formatCompact(parseUnits(a.value, 18), 18)} JAMBO`
}

/** JAMBO base units the amount stands for, at `jamboPerNear` (JAMBO base units per 1 NEAR). */
export function targetJambo(a: Amount, jamboPerNear: bigint): bigint {
  if (a.unit === 'jambo') return parseUnits(a.value, 18)
  return (parseUnits(a.value, 24) * jamboPerNear) / 10n ** 24n
}

/**
 * Split a JAMBO target into gaypad's allowed sizes, at most MAX_CHUNKS buys,
 * picking the combination closest to the target (ties: fewer buys, then the
 * smaller total). Never returns nothing: the minimum is one smallest size.
 */
export function planChunks(target: bigint, allowed: bigint[], maxChunks = MAX_CHUNKS): bigint[] {
  const sizes = [...allowed].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
  let best: bigint[] = [sizes[sizes.length - 1]!]
  const score = (combo: bigint[]) => {
    const sum = combo.reduce((a, b) => a + b, 0n)
    return { diff: sum > target ? sum - target : target - sum, n: combo.length, sum }
  }
  const better = (a: bigint[], b: bigint[]) => {
    const x = score(a)
    const y = score(b)
    if (x.diff !== y.diff) return x.diff < y.diff
    if (x.n !== y.n) return x.n < y.n
    return x.sum < y.sum
  }
  // Multisets of up to maxChunks sizes, largest first: tiny search (70 combos for 4 sizes).
  const walk = (start: number, combo: bigint[]) => {
    if (combo.length && better(combo, best)) best = [...combo]
    if (combo.length === maxChunks) return
    for (let i = start; i < sizes.length; i++) walk(i, [...combo, sizes[i]!])
  }
  walk(0, [])
  return best
}

/** "2×10K + 1K JAMBO" */
export function describeChunks(chunks: bigint[]): string {
  const counts = new Map<bigint, number>()
  for (const c of chunks) counts.set(c, (counts.get(c) ?? 0) + 1)
  const parts = [...counts].map(([size, n]) => `${n > 1 ? `${n}×` : ''}${formatCompact(size, 18)}`)
  return `${parts.join(' + ')} JAMBO`
}
