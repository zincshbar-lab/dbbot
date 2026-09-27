/**
 * Minimal NEAR JSON-RPC client.
 *
 * Reads go to the first URL and fall back through the rest. Broadcasts can go
 * to every URL at once, which is what the sniper uses: whichever node gossips
 * the transaction first wins, and duplicates are harmless (same hash).
 */

export type Finality = 'optimistic' | 'final'

export class RpcError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export interface ExecutionOutcome {
  id: string
  block_hash: string
  outcome: {
    executor_id: string
    logs: string[]
    status: { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown }
  }
}

export interface TxResult {
  status: { SuccessValue?: string; Failure?: unknown }
  transaction: { hash: string; signer_id: string }
  transaction_outcome: ExecutionOutcome
  receipts_outcome: ExecutionOutcome[]
}

export class NearRpc {
  constructor(
    readonly urls: string[],
    private readonly timeoutMs = 10_000,
  ) {
    if (!urls.length) throw new Error('at least one RPC URL is required')
  }

  private async post(url: string, method: string, params: unknown, timeoutMs = this.timeoutMs) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status} from ${new URL(url).host}`)
    const body = (await res.json()) as { result?: unknown; error?: { name?: string; cause?: { name?: string; info?: unknown }; data?: unknown; message?: string } }
    if (body.error) {
      const e = body.error
      const kind = e.cause?.name ?? e.name ?? 'ERROR'
      throw new RpcError(`${method}: ${kind} ${JSON.stringify(e.data ?? e.cause?.info ?? e.message ?? '').slice(0, 300)}`, e)
    }
    return body.result
  }

  /** Tries each URL in order. Errors that are the chain's answer are not retried. */
  async call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    let last: unknown
    for (const url of this.urls) {
      try {
        return (await this.post(url, method, params, timeoutMs)) as T
      } catch (err) {
        last = err
        if (err instanceof RpcError && isDeterministic(err)) throw err
      }
    }
    throw last
  }

  async view<T>(contractId: string, method: string, args: object = {}, finality: Finality = 'final'): Promise<T> {
    const result = await this.call<{ result: number[]; error?: string }>('query', {
      request_type: 'call_function',
      finality,
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    })
    if (result.error) throw new RpcError(`${contractId}.${method}: ${result.error}`)
    const text = Buffer.from(result.result).toString()
    return (text ? JSON.parse(text) : null) as T
  }

  /**
   * View call against every RPC in parallel, keeping the answer from the
   * newest block. A single public node can serve one shard's state minutes
   * behind (seen on mainnet: the JAMBO balance stuck at its pre-swap value).
   */
  async viewFreshest<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    const answers = await Promise.allSettled(
      this.urls.map(async (url) => {
        const r = (await this.post(url, 'query', {
          request_type: 'call_function',
          finality: 'optimistic',
          account_id: contractId,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        }, 5_000)) as { result: number[]; block_height: number; error?: string }
        if (r.error) throw new RpcError(`${contractId}.${method}: ${r.error}`)
        const text = Buffer.from(r.result).toString()
        return { height: r.block_height, value: (text ? JSON.parse(text) : null) as T }
      }),
    )
    const ok = answers.flatMap((a) => (a.status === 'fulfilled' ? [a.value] : []))
    if (!ok.length) throw (answers[0] as PromiseRejectedResult).reason
    return ok.reduce((best, a) => (a.height > best.height ? a : best)).value
  }

  async nativeBalance(accountId: string, finality: Finality = 'optimistic'): Promise<{ amount: bigint; locked: bigint; storageUsage: number }> {
    const r = await this.call<{ amount: string; locked: string; storage_usage: number }>('query', {
      request_type: 'view_account',
      finality,
      account_id: accountId,
    })
    return { amount: BigInt(r.amount), locked: BigInt(r.locked), storageUsage: r.storage_usage }
  }

  async accessKey(accountId: string, publicKey: string) {
    return this.call<{ nonce: number | string; block_hash: string; permission: unknown }>('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    })
  }

  async latestBlockHash(finality: Finality = 'final'): Promise<string> {
    const b = await this.call<{ header: { hash: string } }>('block', { finality })
    return b.header.hash
  }

  /**
   * Submit to every RPC in parallel and resolve once any node has it in a
   * block. `INCLUDED` rather than `NONE`/async: those skip validation, so a
   * stale nonce would only surface as a 60s wait instead of an instant error.
   * A timeout is not a rejection — the tx may still land — so it resolves too.
   */
  async broadcast(signedB64: string): Promise<void> {
    try {
      await Promise.any(
        this.urls.map((url) => this.post(url, 'send_tx', { signed_tx_base64: signedB64, wait_until: 'INCLUDED' }, 10_000)),
      )
    } catch (err) {
      const errors = (err as AggregateError).errors ?? [err]
      if (errors.every((e) => /TIMEOUT|aborted|timed out/i.test(String(e?.message)))) return
      throw new RpcError(`broadcast rejected: ${errors.map((e) => e?.message ?? e).join(' | ')}`)
    }
  }

  /** Submit and wait until every receipt has executed. */
  async sendAndWait(signedB64: string): Promise<TxResult> {
    return this.call<TxResult>('send_tx', { signed_tx_base64: signedB64, wait_until: 'EXECUTED_OPTIMISTIC' }, 30_000)
  }

  /** Polls until the transaction and all its receipts have executed. */
  async waitForTx(hash: string, signerId: string, timeoutMs = 60_000): Promise<TxResult> {
    const deadline = Date.now() + timeoutMs
    let last: unknown
    while (Date.now() < deadline) {
      try {
        return await this.call<TxResult>(
          'EXPERIMENTAL_tx_status',
          { tx_hash: hash, sender_account_id: signerId, wait_until: 'EXECUTED_OPTIMISTIC' },
          15_000,
        )
      } catch (err) {
        // UNKNOWN_TRANSACTION (not yet seen) and TIMEOUT_ERROR both mean "ask again".
        last = err
        await sleep(400)
      }
    }
    throw new RpcError(`timed out waiting for ${hash}: ${String((last as Error)?.message ?? last)}`)
  }
}

/** Errors that are the chain's actual answer, so trying another node won't help. */
function isDeterministic(err: RpcError): boolean {
  return /UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|INVALID_TRANSACTION|CONTRACT_EXECUTION_ERROR|CodeDoesNotExist|MethodNotFound|wasm execution failed|Smart contract panicked|UNKNOWN_TRANSACTION/i.test(
    err.message,
  )
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Every failure anywhere in the receipt tree, as readable strings. */
export function failuresOf(tx: TxResult): string[] {
  const out: string[] = []
  for (const r of [tx.transaction_outcome, ...tx.receipts_outcome]) {
    const f = r.outcome.status.Failure
    if (f) out.push(describeFailure(f))
  }
  return out
}

function describeFailure(f: unknown): string {
  const s = JSON.stringify(f)
  const panic = s.match(/"(?:panic_msg|PanicMsg|ExecutionError)"\s*:\s*"([^"]+)"/)
  return panic?.[1] ?? s.slice(0, 200)
}

/** NEP-297 events emitted anywhere in the transaction. */
export function eventsOf(tx: TxResult): { contract: string; standard: string; event: string; data: any[] }[] {
  const out = []
  for (const r of tx.receipts_outcome) {
    for (const log of r.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length))
        out.push({ contract: r.outcome.executor_id, standard: e.standard, event: e.event, data: e.data ?? [] })
      } catch {
        /* not our business */
      }
    }
  }
  return out
}
