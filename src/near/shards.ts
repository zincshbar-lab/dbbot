import type { NearRpc } from './rpc.js'

/**
 * Which shard an account lives on, from the live shard layout.
 *
 * Accounts are split by sorted boundary accounts: the shard index is the
 * number of boundaries <= the account id (byte order), and `shard_ids` maps
 * that index to the id used in block/chunk responses.
 */
export class ShardMap {
  private layout: { boundaries: string[]; ids: number[]; at: number } | null = null

  constructor(private readonly rpc: NearRpc) {}

  async refresh(): Promise<void> {
    const cfg = await this.rpc.call<{ shard_layout: Record<string, { boundary_accounts: string[]; shard_ids?: number[] }> }>(
      'EXPERIMENTAL_protocol_config',
      { finality: 'final' },
    )
    const layout = Object.values(cfg.shard_layout)[0]!
    const ids = layout.shard_ids ?? layout.boundary_accounts.map((_, i) => i).concat(layout.boundary_accounts.length)
    this.layout = { boundaries: layout.boundary_accounts, ids, at: Date.now() }
  }

  async shardOf(accountId: string): Promise<number> {
    if (!this.layout || Date.now() - this.layout.at > 3_600_000) await this.refresh()
    return shardIdFor(accountId, this.layout!.boundaries, this.layout!.ids)
  }
}

export function shardIdFor(accountId: string, boundaries: string[], ids: number[]): number {
  let index = 0
  for (const b of boundaries) if (Buffer.compare(Buffer.from(accountId), Buffer.from(b)) >= 0) index++
  return ids[index]!
}
