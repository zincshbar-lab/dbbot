import { createHash } from 'node:crypto'
import { KeyPair, transactions, utils } from 'near-api-js'
import type { KeyPairString } from '@near-js/crypto'
import { failuresOf, type NearRpc, type TxResult } from './rpc.js'

export type Action = InstanceType<typeof transactions.Action>

export interface PlannedTx {
  receiverId: string
  actions: Action[]
}

export class TxFailedError extends Error {
  constructor(
    readonly hash: string,
    readonly reasons: string[],
  ) {
    super(`transaction ${hash.slice(0, 8)}… failed: ${reasons.join('; ')}`)
    this.name = 'TxFailedError'
  }
}

/**
 * Hot signer for the bot's single wallet.
 *
 * Nonce and a recent block hash are kept in memory so signing a snipe needs
 * zero network round trips. The block hash is refreshed in the background (a
 * transaction stays valid for ~24h of blocks, so a minute-old hash is fine).
 */
export class HotSigner {
  private readonly keyPair: KeyPair
  readonly publicKey: string
  private nonce: bigint | null = null
  private blockHash: Uint8Array | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly rpc: NearRpc,
    readonly accountId: string,
    privateKey: string,
  ) {
    this.keyPair = KeyPair.fromString(privateKey as KeyPairString)
    this.publicKey = this.keyPair.getPublicKey().toString()
  }

  async start(): Promise<void> {
    await this.resync()
    this.timer = setInterval(() => void this.refreshBlockHash().catch(() => {}), 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** Re-reads the nonce from chain. Needed after an InvalidNonce or a key used elsewhere. */
  async resync(): Promise<void> {
    const key = await this.rpc.accessKey(this.accountId, this.publicKey)
    this.nonce = BigInt(key.nonce)
    this.blockHash = utils.serialize.base_decode(key.block_hash)
  }

  private async refreshBlockHash(): Promise<void> {
    this.blockHash = utils.serialize.base_decode(await this.rpc.latestBlockHash('final'))
  }

  /** Signs without touching the network. */
  sign(tx: PlannedTx): { hash: string; signedB64: string } {
    if (this.nonce === null || !this.blockHash) throw new Error('signer not started')
    this.nonce += 1n
    const unsigned = transactions.createTransaction(
      this.accountId,
      this.keyPair.getPublicKey(),
      tx.receiverId,
      this.nonce,
      tx.actions,
      this.blockHash,
    )
    const digest = createHash('sha256').update(transactions.encodeTransaction(unsigned)).digest()
    const { signature } = this.keyPair.sign(digest)
    const signed = new transactions.SignedTransaction({
      transaction: unsigned,
      signature: new transactions.Signature({ keyType: unsigned.publicKey.keyType, data: signature }),
    })
    return {
      hash: utils.serialize.base_encode(digest),
      signedB64: Buffer.from(signed.encode()).toString('base64'),
    }
  }

  /**
   * Sign, submit and wait for every receipt. Throws TxFailedError if any
   * receipt failed, unless `allowFailures` (for flows where an inner failure
   * is expected and handled on chain, like a refunded snipe attempt).
   * `fast` broadcasts to every RPC in parallel first.
   */
  async send(tx: PlannedTx, opts: { fast?: boolean; allowFailures?: boolean } = {}): Promise<TxResult> {
    for (let attempt = 0; ; attempt++) {
      const { hash, signedB64 } = this.sign(tx)
      try {
        let result: TxResult
        if (opts.fast) {
          await this.rpc.broadcast(signedB64)
          result = await this.rpc.waitForTx(hash, this.accountId)
        } else {
          result = await this.rpc.sendAndWait(signedB64).catch(async (err) => {
            const msg = String(err?.message)
            // A rejection of the tx itself is final; anything else (timeouts,
            // HTTP 408/5xx, dropped connections) may hide a tx that went through.
            if (/INVALID_TRANSACTION|InvalidTx|InvalidNonce|Expired|NotEnoughBalance/i.test(msg)) throw err
            return this.rpc.waitForTx(hash, this.accountId, 30_000).catch(() => {
              throw err
            })
          })
        }
        const failures = failuresOf(result)
        if (failures.length && !opts.allowFailures) throw new TxFailedError(hash, failures)
        return result
      } catch (err) {
        const msg = String((err as Error)?.message ?? err)
        if (attempt < 2 && /InvalidNonce|Expired|InvalidTxError.*Nonce/i.test(msg)) {
          await this.resync()
          continue
        }
        throw err
      }
    }
  }

  /** Runs dependent transactions in order, stopping at the first failure. */
  async sendAll(txs: PlannedTx[]): Promise<TxResult[]> {
    const results: TxResult[] = []
    for (const tx of txs) results.push(await this.send(tx))
    return results
  }
}
