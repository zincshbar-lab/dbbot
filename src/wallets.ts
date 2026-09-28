import { join } from 'node:path'
import { NearRpc } from './near/rpc.js'
import { Router } from './near/router.js'
import { HotSigner } from './near/signer.js'
import { Gaypad } from './gaypad/contract.js'
import { Store } from './store.js'
import { Trader, TradeError } from './trade.js'
import { Accounts } from './accounts.js'
import { decrypt } from './lib/crypto.js'

/**
 * One trading session for a user: their Trader (built from their key), their
 * position store, and lazy signer startup. Reads work immediately; the signer
 * (nonce/block hash) is only started the first time the user sends a trade, so
 * a wallet that isn't funded yet can still be viewed.
 */
export class UserSession {
  private started = false
  constructor(
    readonly trader: Trader,
    readonly store: Store,
    readonly accountId: string,
    private readonly signer: HotSigner,
  ) {}

  /** Prepare the signer for sending. Friendly error if the account is not on chain yet. */
  async ready(): Promise<void> {
    if (this.started) return
    try {
      await this.signer.start()
      this.started = true
    } catch (err) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist|no matching key/i.test(String((err as Error)?.message ?? err))) {
        throw new TradeError(`this wallet is not active on chain yet — send some NEAR to ${this.accountId} first, then try again`)
      }
      throw err
    }
  }

  stop(): void {
    this.signer.stop()
  }
}

/**
 * Builds and caches a UserSession per Telegram id from that user's stored key.
 *
 * Decrypted keys live only inside a cached session; idle sessions are evicted
 * after IDLE_MS so a key isn't held in memory longer than it's being used
 * (it's re-decrypted from disk on the next action). This shrinks the window in
 * which a memory dump could expose a key.
 */
export class WalletManager {
  private readonly cache = new Map<number, { session: UserSession; lastUsed: number }>()
  /** Evict a session that hasn't been used in this long. */
  static readonly IDLE_MS = 10 * 60_000

  constructor(
    private readonly rpc: NearRpc,
    private readonly router: Router,
    private readonly accounts: Accounts,
    private readonly encryptionSecret: string,
    private readonly dataDir: string,
  ) {
    const sweep = setInterval(() => this.evictIdle(), 60_000)
    sweep.unref()
  }

  private evictIdle(): void {
    const cutoff = Date.now() - WalletManager.IDLE_MS
    for (const [id, entry] of this.cache) {
      if (entry.lastUsed < cutoff) {
        entry.session.stop()
        this.cache.delete(id)
      }
    }
  }

  /** True if the user has a wallet imported/created. */
  has(id: number): boolean {
    return Boolean(this.accounts.getKey(id))
  }

  /** The user's session, or null if they have no wallet yet. */
  get(id: number): UserSession | null {
    const cached = this.cache.get(id)
    if (cached) {
      cached.lastUsed = Date.now()
      return cached.session
    }
    const rec = this.accounts.getKey(id)
    if (!rec) return null

    const key = decrypt(rec.enc, this.encryptionSecret)
    const signer = new HotSigner(this.rpc, rec.accountId, key)
    const gaypad = new Gaypad(this.rpc, rec.accountId)
    const store = new Store(join(this.dataDir, 'users', String(id)))
    const trader = new Trader(this.rpc, signer, this.router, gaypad, store)
    const session = new UserSession(trader, store, rec.accountId, signer)
    this.cache.set(id, { session, lastUsed: Date.now() })
    return session
  }

  /** Drop the cached session (after the user changes or removes their wallet). */
  forget(id: number): void {
    this.cache.get(id)?.session.stop()
    this.cache.delete(id)
  }

  /** Write out any pending per-user state (positions) — call on shutdown. */
  flushAll(): void {
    for (const { session } of this.cache.values()) {
      try {
        session.store.flush()
      } catch {
        /* best effort */
      }
    }
  }
}
