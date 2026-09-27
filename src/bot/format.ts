export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Parses "1k", "10K", "500000", "0.5m" into a whole-unit decimal string. */
export function parseShorthand(input: string): string | null {
  const m = input.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/)
  if (!m) return null
  const mult = m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1
  const n = Number(m[1]) * mult
  return Number.isFinite(n) && n > 0 ? String(n) : null
}

export function signedNear(s: string): string {
  return s.startsWith('-') ? s : `+${s}`
}

/** "$1.23M", "$12.3K", "$4.56", "$0.0123", "$0.00000919" — display only. */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '$?'
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}K`
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(2)}K`
  if (a >= 1) return `${sign}$${a.toFixed(2)}`
  if (a === 0) return '$0'
  if (a >= 0.01) return `${sign}$${a.toFixed(3)}`
  return `${sign}$${a.toPrecision(3)}`
}

/** Compact NEAR for large figures like market caps: 1.2K N, 3.4M N. */
export function nearCompact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M N`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K N`
  return `${n.toFixed(a >= 10 ? 0 : 2)} N`
}

/** "$5.20 (1.31 N)" from yoctoNEAR — dollars first, as asked. */
export function usdNear(yocto: bigint, nearUsd: number, nearDigits = 3): string {
  const near = Number(yocto) / 1e24
  const nearStr = `${trimZeros(near.toFixed(nearDigits))} N`
  return nearUsd > 0 ? `${usd(near * nearUsd)} (${nearStr})` : nearStr
}

/** Signed variant for profit/loss: "+$1.10 (+0.23 N)". */
export function usdNearSigned(yocto: bigint, nearUsd: number): string {
  const s = usdNear(yocto < 0n ? -yocto : yocto, nearUsd)
  const sign = yocto < 0n ? '-' : '+'
  return nearUsd > 0 ? s.replace(/^\$/, `${sign}$`).replace(/\(/, `(${sign}`) : `${sign}${s}`
}

/** "1.500" → "1.5", "100" stays "100", "2.000" → "2". */
export const trimZeros = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)
