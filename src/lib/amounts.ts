/** All on-chain amounts are bigint base units. No floats touch money. */

export const NEAR_DECIMALS = 24
export const ONE_NEAR = 10n ** 24n

export function parseUnits(value: string, decimals: number): bigint {
  const s = value.trim().replace(/_/g, '')
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error(`not a number: "${value}"`)
  const [whole = '', frac = ''] = s.split('.')
  if (frac.length > decimals) throw new Error(`too many decimals (max ${decimals})`)
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

export function formatUnits(value: bigint, decimals: number, maxFrac = 4): string {
  const neg = value < 0n
  const abs = neg ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '')
  // Tiny non-zero values would otherwise print as "0".
  if (whole === 0n && !frac && abs > 0n) {
    const full = (abs % base).toString().padStart(decimals, '0')
    const firstSig = full.search(/[1-9]/)
    frac = full.slice(0, Math.min(firstSig + 3, decimals)).replace(/0+$/, '')
  }
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${wholeStr}${frac ? '.' + frac : ''}`
}

export const formatNear = (yocto: bigint, maxFrac = 4) => formatUnits(yocto, NEAR_DECIMALS, maxFrac)

/** Compact form for large token counts: 1.23M, 4.5B. */
export function formatCompact(value: bigint, decimals: number): string {
  const whole = value / 10n ** BigInt(decimals)
  const units: [bigint, string][] = [
    [10n ** 12n, 'T'],
    [10n ** 9n, 'B'],
    [10n ** 6n, 'M'],
    [10n ** 3n, 'K'],
  ]
  for (const [size, suffix] of units) {
    if (whole >= size) return `${formatUnits((value * 100n) / size / 10n ** BigInt(decimals), 2, 2)}${suffix}`
  }
  return formatUnits(value, decimals, 2)
}

export const applyBps = (amount: bigint, bps: number) => (amount * BigInt(bps)) / 10_000n

/** amount reduced by slippage — the floor passed as a minimum output. */
export const minusBps = (amount: bigint, bps: number) => amount - applyBps(amount, bps)

/** a * num / den, for converting between assets by a quoted rate. */
export const mulDiv = (a: bigint, num: bigint, den: bigint) => (den === 0n ? 0n : (a * num) / den)

export function pct(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0
  return Number((part * 10_000n) / whole) / 100
}
