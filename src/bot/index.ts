import { Bot, InlineKeyboard, type Context } from 'grammy'
import type { Trader, TokenView } from '../trade.js'
import { TradeError, txLink } from '../trade.js'
import type { UserSession, WalletManager } from '../wallets.js'
import type { Accounts } from '../accounts.js'
import { JAMBO_DECIMALS, soldPct } from '../gaypad/contract.js'
import { isAccountId } from '../near/tokens.js'
import { newWallet, verifyControls } from '../near/keys.js'
import { NearRpc } from '../near/rpc.js'
import { Chipfi, isChipfiToken } from '../chipfi/contract.js'
import { Umbra, isUmbraToken } from '../umbra/contract.js'
import { nearlyInfo, type NearlyInfo } from '../nearly/contract.js'
import { parseMemeRef, shareOfExisting } from '../memecooking/contract.js'
import { encrypt } from '../lib/crypto.js'
import { ONE_NEAR, formatCompact, formatNear, formatUnits, mulDiv, parseUnits, pct } from '../lib/amounts.js'
import { parseAmount, describeAmount, describeChunks } from '../lib/amount-plan.js'
import { errMsg, log } from '../lib/log.js'
import { esc, nearCompact, signedNear, usd, usdNear, usdNearSigned } from './format.js'

interface Deps {
  token: string
  admins: number[]
  accounts: Accounts
  wallets: WalletManager
  rpc: NearRpc
  encryptionSecret: string
}

type Awaiting =
  | { kind: 'importWallet' }
  | { kind: 'adminAdd' }
  | { kind: 'buyCurveAmount'; tokenId: string }
  | { kind: 'buyNear'; tokenId: string }
  | { kind: 'sellPct'; tokenId: string }
  | { kind: 'presaleDeposit'; memeId: number }
  | { kind: 'topUp' }
  | { kind: 'slippage' }

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } }
const AMOUNT_HELP = 'Send an amount:\n<code>5</code> = 5 NEAR\n<code>0.5</code> = 0.5 NEAR\n<code>25k jambo</code> = 25,000 JAMBO'
const tokenCmd = (id: string) => (id.split('.')[0] ?? id).replace(/[^a-z0-9]/gi, '').slice(0, 32)

export function createBot(d: Deps): Bot {
  const bot = new Bot(d.token)
  const { accounts, wallets, rpc } = d
  const awaiting = new Map<number, Awaiting>()
  const busy = new Set<string>()

  const isAdmin = (id?: number) => id !== undefined && d.admins.includes(id)
  const hasAccess = (id?: number) => id !== undefined && (isAdmin(id) || accounts.isAllowed(id))

  // Token ids can be 64 chars; callback data is limited to 64 bytes. Buttons carry a short key.
  const keys: string[] = []
  const keyOf = (tokenId: string) => {
    let i = keys.indexOf(tokenId)
    if (i < 0) i = keys.push(tokenId) - 1
    return i.toString(36)
  }
  const tokenOf = (key: string) => keys[parseInt(key, 36)]

  // Access control: only admins and allow-listed ids are answered.
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id
    if (hasAccess(id)) return next()
    if (id) log.warn(`ignored update from Telegram user ${id} (@${ctx.from?.username ?? '?'}) — no access`)
  })

  // ---------------------------------------------------------------- helpers

  const reply = async (ctx: Context, text: string, kb?: InlineKeyboard) => {
    if (ctx.callbackQuery?.message) {
      try {
        return void (await ctx.editMessageText(text, { ...HTML, reply_markup: kb }))
      } catch (err) {
        if (/not modified/.test(errMsg(err))) return
      }
    }
    await ctx.reply(text, { ...HTML, reply_markup: kb })
  }

  const ask = async (ctx: Context, a: Awaiting, prompt: string) => {
    awaiting.set(ctx.chat!.id, a)
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {})
    await ctx.reply(prompt, HTML)
  }

  /** The caller's trading session, or null (after showing the wallet-setup panel). */
  const requireWallet = async (ctx: Context): Promise<UserSession | null> => {
    const w = wallets.get(ctx.from!.id)
    if (!w) {
      await walletSetup(ctx)
      return null
    }
    return w
  }

  /** Runs a trade with a status message that becomes the outcome. Starts the signer first. */
  const runTrade = async (ctx: Context, w: UserSession, lockKey: string, label: string, work: () => Promise<string>) => {
    const gate = `${ctx.from!.id}:${lockKey}`
    if (busy.has(gate)) return void (await ctx.reply('⏳ Already working on that one.'))
    busy.add(gate)
    const status = await ctx.reply(`⏳ ${label}…`, HTML)
    let text: string
    try {
      await w.ready()
      text = await work()
    } catch (err) {
      const hash = err instanceof TradeError ? err.txHash : undefined
      text = `❌ ${esc(label)} failed\n${esc(errMsg(err))}${hash ? `\n<a href="${txLink(hash)}">tx</a>` : ''}`
      log.warn(`${label}: ${errMsg(err)}`)
    } finally {
      busy.delete(gate)
    }
    await ctx.api.editMessageText(status.chat.id, status.message_id, text, HTML).catch(() => ctx.reply(text, HTML))
  }

  const nearOfJambo = async (trader: Trader, jambo: bigint) => {
    try {
      return `~${formatNear(mulDiv(jambo, ONE_NEAR, await trader.jamboPerNear()), 2)} N`
    } catch {
      return '? N'
    }
  }

  // ------------------------------------------------------- wallet setup

  const walletSetup = async (ctx: Context) => {
    const text =
      `👛 <b>Set up your wallet</b>\n\n` +
      `To trade, connect a NEAR wallet. You can:\n` +
      `• <b>Create</b> a fresh wallet here (you get the keys), or\n` +
      `• <b>Import</b> an existing wallet with its private key.\n\n` +
      `🔒 Your private key is encrypted at rest and never shown back or logged.`
    const kb = new InlineKeyboard().text('🆕 Create new wallet', 'w:create').row().text('🔑 Import existing wallet', 'w:import').row()
    if (isAdmin(ctx.from!.id)) kb.text('🛠 Admin panel', 'admin').row()
    await reply(ctx, text, kb)
  }

  bot.callbackQuery('w:create', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    const id = ctx.from!.id
    const wallet = newWallet()
    accounts.setKey(id, { accountId: wallet.accountId, publicKey: wallet.publicKey, source: 'created', enc: encrypt(wallet.privateKey, d.encryptionSecret), updatedAt: new Date().toISOString() })
    wallets.forget(id)
    await ctx.reply(
      `🆕 <b>New NEAR wallet created</b>\n\n` +
        `<b>Address:</b>\n<code>${esc(wallet.accountId)}</code>\n\n` +
        `<b>Private key</b> — shown once, save it now:\n<code>${esc(wallet.privateKey)}</code>\n\n` +
        `⚠️ Anyone with this key controls the wallet. Save it, then delete this message. ` +
        `Send NEAR to the address above to activate and fund it, then use the menu to trade.`,
      HTML,
    )
    await menu(ctx)
  })

  bot.callbackQuery('w:import', (ctx) =>
    ask(
      ctx,
      { kind: 'importWallet' },
      'Send your <b>private key</b> and <b>address</b> together in one message, e.g.\n' +
        '<code>ed25519:xxxxxxxx alice.near</code>\n\n' +
        '🔒 Your message is deleted the instant it arrives; the key is encrypted and never shown back or logged.',
    ),
  )

  const handleImport = async (ctx: Context, input: string) => {
    const id = ctx.from!.id
    await ctx.deleteMessage().catch(() => {}) // remove the secret from chat asap
    const parts = input.split(/\s+/).filter(Boolean)
    const key = parts.find((p) => /^ed25519:/i.test(p)) ?? ''
    const accountId = (parts.find((p) => p !== key) ?? '').toLowerCase()
    if (!key || !accountId || !isAccountId(accountId)) {
      return void (await ctx.reply('Send the private key and address together, e.g.\n<code>ed25519:xxxxxxxx alice.near</code>', HTML))
    }
    const status = await ctx.reply('⏳ Verifying…', HTML)
    const edit = (t: string) => ctx.api.editMessageText(status.chat.id, status.message_id, t, HTML).catch(() => ctx.reply(t, HTML))
    let res
    try {
      res = await verifyControls(rpc, accountId, key)
    } catch (err) {
      return void (await edit(`❌ Couldn't verify: ${esc(errMsg(err))}\nCheck the key format and try again.`))
    }
    if (!res.accountExists) return void (await edit(`⚠️ Account <code>${esc(accountId)}</code> does not exist on chain. Nothing saved.`))
    if (!res.ok) return void (await edit(`❌ That key does <b>not</b> control <code>${esc(accountId)}</code>. Nothing saved.`))
    accounts.setKey(id, { accountId, publicKey: res.publicKey, source: 'imported', enc: encrypt(key, d.encryptionSecret), updatedAt: new Date().toISOString() })
    wallets.forget(id)
    await edit(`✅ <b>Wallet connected:</b> <code>${esc(accountId)}</code> (${res.permission === 'FullAccess' ? 'full-access key' : 'function-call key'}).\nOpen /menu to trade.`)
  }

  bot.callbackQuery('w:remove', async (ctx) => {
    accounts.clearKey(ctx.from!.id)
    wallets.forget(ctx.from!.id)
    await ctx.answerCallbackQuery('Wallet removed')
    await menu(ctx)
  })

  // ------------------------------------------------------------------ menu

  const menu = async (ctx: Context) => {
    const w = wallets.get(ctx.from!.id)
    if (!w) return walletSetup(ctx)
    const { trader } = w
    const [near, jambo, nu] = await Promise.all([
      trader.nearBalance().catch(() => null),
      trader.jamboBalance().catch(() => null),
      trader.nearUsd().catch(() => 0),
    ])
    const text =
      `💠 <b>NEAR Trading Bot</b>\n<code>${esc(trader.me)}</code>\n` +
      (nu ? `NEAR ${usd(nu)}\n\n` : '\n') +
      `NEAR: <b>${near === null ? '?' : usdNear(near, nu)}</b>\n` +
      `JAMBO: <b>${jambo === null ? '?' : formatCompact(jambo, JAMBO_DECIMALS)}</b>${jambo ? ` (${await nearOfJambo(trader, jambo)})` : ''}\n\n` +
      `Paste any token contract to trade it.`
    const kb = new InlineKeyboard()
      .text('📊 Positions', 'positions')
      .text('💼 Wallet', 'wallet')
      .row()
      .text('🍳 Presales', 'presales')
      .text('⚙️ Settings', 'settings')
      .row()
    if (isAdmin(ctx.from!.id)) kb.text('🛠 Admin', 'admin').row()
    kb.text('🔄 Refresh', 'menu')
    await reply(ctx, text, kb)
  }

  // ---------------------------------------------------------------- wallet

  const walletPanel = async (ctx: Context) => {
    const w = await requireWallet(ctx)
    if (!w) return
    const { trader } = w
    const [near, jambo, nu] = await Promise.all([trader.nearBalance(), trader.jamboBalance(true), trader.nearUsd().catch(() => 0)])
    const rec = accounts.getKey(ctx.from!.id)
    const text =
      `💼 <b>Wallet</b>\n<code>${esc(trader.me)}</code>\n${rec?.source === 'created' ? '<i>created here</i>' : '<i>imported</i>'}\n\n` +
      `NEAR: <b>${usdNear(near, nu, 4)}</b>\n` +
      `JAMBO: <b>${formatUnits(jambo, JAMBO_DECIMALS, 2)}</b> (${await nearOfJambo(trader, jambo)})\n\n` +
      `Curve (pride.j1.gay) buys are paid in JAMBO; NEAR is converted automatically when you buy. You only need NEAR here.`
    const kb = new InlineKeyboard()
      .text('➕ Buy JAMBO with NEAR', 'w:topup')
      .row()
      .text('JAMBO → NEAR 50%', 'w:j2n:50')
      .text('JAMBO → NEAR 100%', 'w:j2n:100')
      .row()
      .text('🔑 Change / remove wallet', 'w:remove')
      .row()
      .text('⬅ Menu', 'menu')
      .text('🔄', 'wallet')
    await reply(ctx, text, kb)
  }

  bot.callbackQuery('w:topup', (ctx) => ask(ctx, { kind: 'topUp' }, 'How much NEAR to swap into JAMBO? e.g. <code>5</code>'))

  bot.callbackQuery(/^w:j2n:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const w = await requireWallet(ctx)
    if (!w) return
    const p = BigInt(ctx.match[1]!)
    await runTrade(ctx, w, 'jambo', `Swapping ${p}% of JAMBO to NEAR`, async () => {
      const amount = ((await w.trader.jamboBalance(true)) * p) / 100n
      if (amount <= 0n) throw new TradeError('no JAMBO to swap')
      const r = await w.trader.jamboToNear(amount, w.store.state.settings.slippageBps)
      return `✅ Swapped ${formatCompact(amount, JAMBO_DECIMALS)} JAMBO → <b>${formatNear(r.near, 4)} NEAR</b>\n<a href="${txLink(r.hash)}">tx</a>`
    })
  })

  const topUp = async (ctx: Context, w: UserSession, input: string) => {
    let near: bigint
    try {
      near = parseUnits(input, 24)
    } catch {
      return void (await ctx.reply('Send a NEAR amount, like 5 or 0.5'))
    }
    await runTrade(ctx, w, 'jambo', `Buying JAMBO with ${formatNear(near)} NEAR`, async () => {
      const r = await w.trader.topUpJambo(near, w.store.state.settings.slippageBps)
      return `✅ Got <b>${formatUnits(r.jambo, JAMBO_DECIMALS, 2)} JAMBO</b> for ${usdNear(near, w.trader.cachedNearUsd())}\n<a href="${txLink(r.hash)}">tx</a>`
    })
  }

  // ------------------------------------------------------------- positions

  const positionsPanel = async (ctx: Context) => {
    const w = await requireWallet(ctx)
    if (!w) return
    const { trader, store } = w
    const s = store.state
    const kb = new InlineKeyboard()
    const all = Object.entries(s.positions)
    const allViews = await Promise.all(all.map(([id]) => trader.view(id).catch(() => null)))
    all.forEach(([id], i) => {
      if (allViews[i]?.balance === 0n) store.closePosition(id)
    })
    const entries = all.filter((_, i) => allViews[i]?.balance !== 0n)
    const views = allViews.filter((v) => v?.balance !== 0n)
    const realized = BigInt(s.realizedNear)
    const nuNow = trader.cachedNearUsd()
    const realizedLine = s.closedCount
      ? `\nClosed trades (${s.closedCount}): realized <b>${s.realizedUsd ? `${s.realizedUsd >= 0 ? '+' : ''}${usd(s.realizedUsd)} (${signedNear(formatNear(realized, 3))} N)` : usdNearSigned(realized, nuNow)}</b>`
      : ''
    if (!entries.length) {
      return reply(ctx, `📊 <b>Positions</b>\n\n<i>No open positions.</i>${realizedLine}`, kb.text('⬅ Menu', 'menu'))
    }
    const nu = await trader.nearUsd().catch(() => 0)
    const mcs = await Promise.all(
      entries.map(async ([id]) => {
        const dec = views[entries.findIndex(([x]) => x === id)]?.meta.decimals ?? 18
        const [price, supply] = await Promise.all([trader.priceNear(id, dec).catch(() => null), trader.supply(id, dec).catch(() => 0)])
        return { now: price !== null && supply ? price * supply : null, supply }
      }),
    )
    let totalCost = 0n
    let totalNow = 0n
    const lines: string[] = []
    entries.forEach(([id, p], i) => {
      const v = views[i]
      const cost = BigInt(p.costNear)
      const proceeds = BigInt(p.proceedsNear)
      const value = v?.valueNear ?? 0n
      const pnl = value + proceeds - cost
      totalCost += cost
      totalNow += value + proceeds
      if (!v) {
        lines.push(`▫️ $${esc(p.symbol)} · couldn't load`)
        return
      }
      const { now, supply } = mcs[i]!
      const bought = Number(BigInt(p.bought)) / 10 ** v.meta.decimals
      const entryMcNear = bought && supply ? (Number(cost) / 1e24 / bought) * supply : null
      const entryMcUsd = p.costUsd !== undefined && bought && supply ? (p.costUsd / bought) * supply : entryMcNear !== null ? entryMcNear * nu : null
      const mcLine =
        entryMcNear !== null && now !== null
          ? `\n    MC ${nu && entryMcUsd !== null ? usd(entryMcUsd) : nearCompact(entryMcNear)} → ${nu ? usd(now * nu) : nearCompact(now)} (${now >= entryMcNear ? '+' : ''}${((now / entryMcNear - 1) * 100).toFixed(1)}%)`
          : ''
      lines.push(
        `${pnl >= 0n ? '🟢' : '🔴'} <b>$${esc(p.symbol)}</b> ${formatCompact(v.balance, v.meta.decimals)} · ` +
          `${v.valueNear === null ? 'value ?' : usdNear(value, nu)} · ` +
          `PnL ${usdNearSigned(pnl, nu)} (${cost ? pct(pnl, cost).toFixed(1) : '–'}%)` +
          mcLine,
      )
      if (kb.inline_keyboard.flat().length < 30) kb.text(`$${p.symbol}`, `tk:${keyOf(id)}`)
      if (kb.inline_keyboard.at(-1)!.length >= 3) kb.row()
    })
    const pnl = totalNow - totalCost
    const text =
      `📊 <b>Positions</b>${nu ? ` · NEAR ${usd(nu)}` : ''}\n\n${lines.join('\n')}\n\n` +
      `Open: cost ${usdNear(totalCost, nu)} · now ${usdNear(totalNow, nu)}\n<b>PnL ${usdNearSigned(pnl, nu)}</b>` +
      realizedLine +
      `\n<i>MC = your average entry market cap → now. Fully sold tokens are removed; their result stays in the realized total.</i>`
    kb.row().text('⬅ Menu', 'menu').text('🔄', 'positions')
    await reply(ctx, text, kb)
  }

  // ------------------------------------------------------------ token card

  const tokenPanel = async (ctx: Context, tokenId: string) => {
    const w = await requireWallet(ctx)
    if (!w) return
    const { trader, store } = w
    const s = store.state
    let v: TokenView
    try {
      v = await trader.view(tokenId)
    } catch (err) {
      return reply(ctx, `Couldn't load <code>${esc(tokenId)}</code>: ${esc(errMsg(err))}`)
    }
    const k = keyOf(tokenId)
    const p = s.positions[tokenId]

    // ---- venue / launchpad line + claimable dividends ----
    let venueLine =
      v.venue === 'curve'
        ? `pride.j1.gay curve · ${v.state ? soldPct(v.state).toFixed(1) : '?'}% sold · priced in JAMBO`
        : v.state?.is_deployed
          ? 'graduated from pride.j1.gay · trading on a DEX'
          : 'DEX (via Intear router)'
    let claimable = 0n
    if (v.venue === 'shards') {
      const [cfg, st, acct] = await Promise.all([trader.shards.config(tokenId), trader.shards.state(tokenId), trader.shards.account(tokenId)])
      const phase =
        st?.phase === 'live_curve' ? `bonding curve ${(st.progress_bps / 100).toFixed(1)}% to graduation` : st?.phase === 'live_amm' ? 'graduated (shards AMM)' : `not trading (${esc(st?.phase ?? '?')})`
      venueLine = `shards.market · ${phase} · tax ${cfg.buy_tax_bps / 100}% buy / ${cfg.sell_tax_bps / 100}% sell` + (cfg.quote_asset_id === 'wrap.near' ? '' : `\n⚠️ priced in ${esc(cfg.quote_asset_id)} — not supported`)
      claimable = BigInt(acct?.claimable_dividends ?? 0) + BigInt(acct?.quote_credit ?? 0)
    }
    if (v.venue === 'chipfi' || (isChipfiToken(tokenId) && v.venue === 'dex')) {
      const [info, holder] = await Promise.all([trader.chipfi.info(tokenId), trader.chipfi.holder(tokenId)])
      const phase = info.phase === 'Curve' ? `bonding curve ${Chipfi.progress(info).toFixed(1)}% sold` : info.phase === 'Pool' ? 'graduated · trading on Rhea' : 'moving to its Rhea pool'
      venueLine =
        `chipfi.fun · ${phase} · tax ${info.buy_tax_bps / 100}% buy / ${info.sell_tax_bps / 100}% sell · ${info.holders} holders` +
        (Chipfi.pairedWithNear(info) ? '' : `\n⚠️ paired with a token — not supported`) +
        (Chipfi.drained(info) ? `\n🚨 <b>Curve emptied by the chipfi owner</b> — sells cannot be paid. Buying is blocked.` : '')
      claimable = BigInt(holder?.claimable_dividends ?? 0) + BigInt(holder?.credit ?? 0)
    }
    if (v.venue === 'umbra' || (isUmbraToken(tokenId) && v.venue === 'dex')) {
      const c = await trader.umbra.curve(tokenId)
      venueLine =
        `umbrapad · ${c.graduated ? 'graduated · trading on Rhea' : `bonding curve ${Umbra.progress(c).toFixed(1)}% sold`} · fee ${c.fee_bps / 100}%` +
        (Umbra.pairedWithNear(c) ? '' : `\n<i>paired with a tokenized stock (${esc((c.quote_token ?? '').split('.')[0] ?? '?')}) · bought/sold via NEAR ↔ stock ↔ coin</i>`)
      claimable = await trader.umbra.owed(tokenId)
    }
    let nearly: NearlyInfo | null = null
    if (v.venue === 'nearly') {
      nearly = await nearlyInfo(tokenId)
      const q = nearly ? (nearly.quoteIsNear ? 'NEAR' : (nearly.quote.split('.')[0] ?? nearly.quote).toUpperCase()) : '?'
      venueLine = `nearly.trade · paired with ${esc(q)} · Rhea DCL 1%` + (nearly && !nearly.quoteIsNear ? `\n<i>bought/sold via NEAR ↔ ${esc(q)} ↔ token</i>` : '')
    }

    // ---- market data ----
    const [nu, price, supply] = await Promise.all([
      trader.nearUsd().catch(() => 0),
      trader.priceNear(tokenId, v.meta.decimals).catch(() => null),
      trader.supply(tokenId, v.meta.decimals).catch(() => 0),
    ])
    const mcNear = price !== null && supply ? price * supply : null
    const liqNear =
      v.venue === 'curve' && v.state
        ? await trader.jamboInNear(BigInt(v.state.wnear_hold)).catch(() => null)
        : nearly && nearly.liquidityNear > 0
          ? BigInt(Math.round(nearly.liquidityNear * 1e24))
          : null
    const liqLabel = v.venue === 'curve' ? ' (curve reserve)' : v.venue === 'nearly' ? ' (pool)' : ''

    // ---- position block (entry MC → exit/now MC) ----
    let posBlock = ''
    if (p) {
      const cost = BigInt(p.costNear)
      const proceeds = BigInt(p.proceedsNear)
      const pnl = (v.valueNear ?? 0n) + proceeds - cost
      const bought = Number(BigInt(p.bought)) / 10 ** v.meta.decimals
      const entryMcNear = bought && supply ? (Number(cost) / 1e24 / bought) * supply : null
      const entryUsd = p.costUsd !== undefined && bought && supply ? (p.costUsd / bought) * supply : entryMcNear !== null ? entryMcNear * nu : null
      const change = entryMcNear && mcNear !== null ? ((mcNear / entryMcNear - 1) * 100).toFixed(1) : null
      posBlock =
        `\n<b>Your position</b>\n` +
        `Balance:  <b>${formatCompact(v.balance, v.meta.decimals)}</b>${v.balance ? ` · ${v.valueNear === null ? 'value ?' : usdNear(v.valueNear, nu)}` : ''}\n` +
        `Entry MC: ${entryUsd !== null && nu ? usd(entryUsd) : entryMcNear !== null ? nearCompact(entryMcNear) : '?'} → ${mcNear !== null ? (nu ? usd(mcNear * nu) : nearCompact(mcNear)) : '?'}${change !== null ? ` (${Number(change) >= 0 ? '+' : ''}${change}%)` : ''}\n` +
        `Cost:     ${usdNear(cost, nu)}\n` +
        `PnL:      <b>${usdNearSigned(pnl, nu)}</b>${cost ? ` (${pct(pnl, cost).toFixed(1)}%)` : ''}`
    }

    // ---- links ----
    const links =
      `\n\n🔗 <a href="https://nearblocks.io/address/${encodeURIComponent(tokenId)}">Contract</a>` +
      (v.venue === 'nearly' ? ` · <a href="https://nearly.trade/${encodeURIComponent(tokenId)}">nearly.trade</a>` : '') +
      (v.venue === 'dex' || v.state?.is_deployed ? ` · <a href="https://dexscreener.com/near/${encodeURIComponent(tokenId)}">Chart</a>` : '') +
      (claimable ? `\n💰 Claimable: <b>${formatNear(claimable, 4)} NEAR</b>` : '')

    const text =
      `💠 <b>$${esc(v.meta.symbol)}</b> — ${esc(v.meta.name)}\n<code>${esc(tokenId)}</code>\n${venueLine}\n\n` +
      `Market cap: <b>${mcNear === null ? '?' : nu ? `${usd(mcNear * nu)} (${nearCompact(mcNear)})` : nearCompact(mcNear)}</b>\n` +
      `Price:      ${price === null ? '?' : nu ? usd(price * nu) : `${price.toPrecision(3)} N`}\n` +
      `Supply:     ${supply ? formatCompact(BigInt(Math.round(supply)) * 10n ** BigInt(v.meta.decimals), v.meta.decimals) : '?'}\n` +
      (liqNear !== null ? `Liquidity:  ~${formatNear(liqNear, 2)} N${liqLabel}\n` : '') +
      posBlock +
      links

    const kb = new InlineKeyboard()
    if (v.venue === 'curve') {
      const sizes = await trader.gaypad.allowedSizes()
      for (const [i, size] of sizes.entries()) {
        kb.text(`Buy ${formatCompact(size, JAMBO_DECIMALS)} (${await nearOfJambo(trader, size)})`, `bc:${k}:${i}`)
        if (i % 2 === 1 || i === sizes.length - 1) kb.row()
      }
      kb.text('Buy custom amount ✏️', `bca:${k}`).row()
    } else {
      for (const n of ['0.5', '1', '5']) kb.text(`Buy ${n} N`, `bn:${k}:${n}`)
      kb.text('Buy X N', `bx:${k}`).row()
    }
    if (claimable) kb.text(`💰 Claim ${formatNear(claimable, 3)} NEAR`, `cl:${k}`).row()
    kb.text('Sell 25%', `sl:${k}:25`).text('50%', `sl:${k}:50`).text('100%', `sl:${k}:100`).text('X%', `sx:${k}`).row()
    kb.text('⬅ Menu', 'menu').text('🔄', `tk:${k}`)
    await reply(ctx, text, kb)
  }

  const withToken = (ctx: Context & { match: RegExpMatchArray | string }, fn: (id: string) => Promise<void>) => {
    const id = tokenOf((ctx.match as RegExpMatchArray)[1]!)
    if (!id) return ctx.answerCallbackQuery('Button expired — paste the token again')
    return fn(id)
  }

  bot.callbackQuery(/^tk:(\w+)$/, (ctx) =>
    withToken(ctx, async (id) => {
      await ctx.answerCallbackQuery()
      await tokenPanel(ctx, id)
    }),
  )

  bot.callbackQuery(/^bc:(\w+):(\d+)$/, (ctx) =>
    withToken(ctx, async (id) => {
      await ctx.answerCallbackQuery('Buying…')
      const w = await requireWallet(ctx)
      if (!w) return
      const size = (await w.trader.gaypad.allowedSizes())[Number(ctx.match[2])]!
      await runTrade(ctx, w, id, `Buying ${formatCompact(size, JAMBO_DECIMALS)} JAMBO of ${id.split('.')[0]}`, async () => {
        const r = await w.trader.buyCurve(id, size)
        return `✅ Bought <b>${formatUnits(r.tokens, r.decimals, 0)}</b> for ${formatCompact(r.jamboIn, 18)} JAMBO (${usdNear(r.costNear, w.trader.cachedNearUsd())})\n<a href="${txLink(r.hash)}">tx</a> · /t_${tokenCmd(id)}`
      })
    }),
  )

  bot.callbackQuery(/^bca:(\w+)$/, (ctx) => withToken(ctx, (id) => ask(ctx, { kind: 'buyCurveAmount', tokenId: id }, `How much? ${AMOUNT_HELP}`)))

  const buyCurveAmount = async (ctx: Context, w: UserSession, id: string, input: string) => {
    const amount = parseAmount(input)
    if (!amount) return void (await ctx.reply(`Couldn't read that amount. ${AMOUNT_HELP.replace(/<\/?code>/g, '')}`))
    await runTrade(ctx, w, id, `Buying ${describeAmount(amount)} of ${id.split('.')[0]}`, async () => {
      const r = await w.trader.buyCurveAmount(id, amount)
      return `✅ Bought <b>${formatUnits(r.tokens, r.decimals, 0)}</b> in ${r.chunks.length} buy${r.chunks.length > 1 ? 's' : ''} (${describeChunks(r.chunks)}, ${usdNear(r.costNear, w.trader.cachedNearUsd())})\n<a href="${txLink(r.hash)}">tx</a> · /t_${tokenCmd(id)}`
    })
  }

  const buyNear = async (ctx: Context, w: UserSession, id: string, amount: string) => {
    let near: bigint
    try {
      near = parseUnits(amount, 24)
    } catch {
      return void (await ctx.reply('Send a NEAR amount, like 1 or 0.25'))
    }
    await runTrade(ctx, w, id, `Buying ${formatNear(near)} NEAR of ${id}`, async () => {
      const r = await w.trader.buyWithNear(id, near)
      const meta = w.store.state.positions[id]
      return `✅ Bought <b>${formatUnits(r.tokens, r.decimals, 2)}</b> $${esc(meta?.symbol ?? '')} for ${usdNear(near, w.trader.cachedNearUsd())}\n<a href="${txLink(r.hash)}">tx</a>`
    })
  }

  bot.callbackQuery(/^bn:(\w+):([\d.]+)$/, (ctx) =>
    withToken(ctx, async (id) => {
      await ctx.answerCallbackQuery('Buying…')
      const w = await requireWallet(ctx)
      if (w) await buyNear(ctx, w, id, ctx.match[2]!)
    }),
  )
  bot.callbackQuery(/^bx:(\w+)$/, (ctx) => withToken(ctx, (id) => ask(ctx, { kind: 'buyNear', tokenId: id }, 'How much NEAR?')))

  bot.callbackQuery(/^cl:(\w+)$/, (ctx) =>
    withToken(ctx, async (id) => {
      await ctx.answerCallbackQuery('Claiming…')
      const w = await requireWallet(ctx)
      if (!w) return
      await runTrade(ctx, w, id, `Claiming from ${id.split('.')[0]}`, async () => {
        const r = await w.trader.claimRewards(id)
        return `✅ Claimed <b>${formatNear(r.amount, 4)} NEAR</b>\n<a href="${txLink(r.hash)}">tx</a>`
      })
    }),
  )

  const sell = async (ctx: Context, w: UserSession, id: string, p: number) => {
    await runTrade(ctx, w, id, `Selling ${p}% of ${id.split('.')[0]}`, async () => {
      const r = await w.trader.sell(id, p)
      const pos = w.store.state.positions[id]
      return (
        `✅ Sold <b>${formatUnits(r.tokens, pos?.decimals ?? 18, 0)}</b> → <b>${usdNear(r.proceedsNear, w.trader.cachedNearUsd(), 4)}</b>` +
        (r.jamboOut ? ` (${formatCompact(r.jamboOut, 18)} JAMBO${w.store.state.settings.sellToNear ? ' swapped to NEAR' : ', kept as JAMBO'})` : '') +
        `\n<a href="${txLink(r.hash)}">tx</a>`
      )
    })
  }

  bot.callbackQuery(/^sl:(\w+):(\d+)$/, (ctx) =>
    withToken(ctx, async (id) => {
      await ctx.answerCallbackQuery('Selling…')
      const w = await requireWallet(ctx)
      if (w) await sell(ctx, w, id, Number(ctx.match[2]))
    }),
  )
  bot.callbackQuery(/^sx:(\w+)$/, (ctx) => withToken(ctx, (id) => ask(ctx, { kind: 'sellPct', tokenId: id }, 'What % to sell? (1–100)')))

  // --------------------------------------------------------- meme.cooking

  const timeLeft = (ms: number) => {
    const m = Math.max(0, Math.round((ms - Date.now()) / 60_000))
    return m >= 60 * 24 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
  }

  const presalePanel = async (ctx: Context, id: number) => {
    const w = await requireWallet(ctx)
    if (!w) return
    const { trader } = w
    const [st, deposits, nu, unclaimed] = await Promise.all([
      trader.meme.status(id),
      trader.meme.deposits(),
      trader.nearUsd().catch(() => 0),
      trader.meme.unclaimed(),
    ])
    const mine = deposits.get(id) ?? 0n
    const kb = new InlineKeyboard()
    let text = ''
    if (st.kind === 'launched') {
      text = `🍳 <b>$${esc(st.meme.symbol)}</b> — ${esc(st.meme.name)} (#${id})\n✅ Launched · <code>${st.tokenId}</code>\nRaised ${usdNear(BigInt(st.meme.total_staked), nu)}` + (unclaimed.includes(id) ? `\n\nYou have tokens to claim.` : '')
      if (unclaimed.includes(id)) kb.text('🎁 Claim tokens', `pc:${id}`).row()
      kb.text(`Trade $${st.meme.symbol}`, `tk:${keyOf(st.tokenId)}`).row()
    } else if (st.kind === 'failed') {
      text = `🍳 Presale #${id}\n❌ Ended without reaching its soft cap (or doesn't exist).` + (unclaimed.includes(id) ? `\n\nYour deposit can be refunded.` : '')
      if (unclaimed.includes(id)) kb.text('↩️ Claim refund', `pc:${id}`).row()
    } else {
      const m = st.meme
      const raised = BigInt(m.total_staked)
      const soft = BigInt(m.soft_cap)
      const hard = m.hard_cap ? BigInt(m.hard_cap) : null
      const pctSoft = soft ? Number((raised * 10_000n) / soft) / 100 : 0
      const phase = st.kind === 'upcoming' ? `⏳ Opens in ${timeLeft(st.startsAt)}` : st.kind === 'live' ? `🟢 Live · ends in ${st.endsAt ? timeLeft(st.endsAt) : '?'}` : '⌛ Ended — waiting to be finalized'
      text =
        `🍳 <b>$${esc(m.symbol)}</b> — ${esc(m.name)} (#${id})\nby <code>${esc(m.owner)}</code>\n${phase}\n\n` +
        `Raised <b>${usdNear(raised, nu)}</b> · soft cap ${usdNear(soft, nu)} (${pctSoft.toFixed(1)}%)` +
        (hard ? ` · hard cap ${usdNear(hard, nu)}` : '') +
        `\n${formatCompact(BigInt(m.amount_to_be_distributed), m.decimals)} tokens to depositors` +
        (mine ? `\n\nYour deposit: <b>${usdNear(mine, nu)}</b> → ~${formatCompact(shareOfExisting(m, mine), m.decimals)} tokens if it closed now` : '') +
        `\n\n<i>Presale, not a curve: tokens are shared pro rata when it ends. Fees: 0.5% on deposit, 2% to withdraw early. Below soft cap = refunded.</i>`
      if (st.kind === 'live') {
        for (const n of ['0.5', '1', '5']) kb.text(`Deposit ${n} N`, `pd:${id}:${n}`)
        kb.text('X N', `px:${id}`).row()
        if (mine) kb.text('↩️ Withdraw (2% fee)', `pw:${id}`).row()
      }
    }
    kb.text('⬅ Presales', 'presales').text('🔄', `pp:${id}`)
    await reply(ctx, text, kb)
  }

  const presalesList = async (ctx: Context) => {
    const w = await requireWallet(ctx)
    if (!w) return
    const { trader, store } = w
    const [open, deposits, nu] = await Promise.all([
      trader.meme.listOpen().catch(() => []),
      trader.meme.deposits().catch(() => new Map<number, bigint>()),
      trader.nearUsd().catch(() => 0),
    ])
    const kb = new InlineKeyboard()
    const lines = open.slice(0, 12).map((m) => {
      if (kb.inline_keyboard.flat().length < 24) kb.text(`$${m.symbol}`, `pp:${m.meme_id}`)
      if (kb.inline_keyboard.at(-1)!.length >= 3) kb.row()
      const soft = BigInt(m.soft_cap)
      const pctSoft = soft ? Number((BigInt(m.total_deposit) * 10_000n) / soft) / 100 : 0
      return `• <b>$${esc(m.symbol)}</b> #${m.meme_id} · ${usdNear(BigInt(m.total_deposit), nu)} raised (${pctSoft.toFixed(0)}%) · ends in ${m.end_timestamp_ms ? timeLeft(m.end_timestamp_ms) : '?'}`
    })
    const mineLines = [...deposits].map(([id, amt]) => {
      if (kb.inline_keyboard.flat().length < 30) kb.text(`My #${id}`, `pp:${id}`)
      return `• #${id} ${esc(store.state.presales[String(id)]?.symbol ? '$' + store.state.presales[String(id)]!.symbol : '')} · ${usdNear(amt, nu)} deposited`
    })
    const text =
      `🍳 <b>meme.cooking presales</b>\n\n` +
      (lines.length ? lines.join('\n') : '<i>No presales open right now.</i>') +
      (mineLines.length ? `\n\n<b>Your deposits</b>\n${mineLines.join('\n')}` : '') +
      `\n\n<i>Open any presale with <code>meme 1987</code> or its meme.cooking link.</i>`
    kb.row().text('⬅ Menu', 'menu').text('🔄', 'presales')
    await reply(ctx, text, kb)
  }

  bot.callbackQuery(/^pp:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    await presalePanel(ctx, Number(ctx.match[1]))
  })

  const presaleDeposit = async (ctx: Context, w: UserSession, id: number, input: string) => {
    let near: bigint
    try {
      near = parseUnits(input, 24)
    } catch {
      return void (await ctx.reply('Send a NEAR amount, like 1 or 0.5'))
    }
    await runTrade(ctx, w, `meme-${id}`, `Depositing ${formatNear(near)} NEAR into presale #${id}`, async () => {
      const r = await w.trader.presaleDeposit(id, near)
      return `✅ Deposited <b>${usdNear(near, w.trader.cachedNearUsd())}</b> into <b>$${esc(r.symbol)}</b> (#${id}) — credited ${formatNear(r.credited, 4)} after the 0.5% fee\nClaim it from the presale panel when it ends.\n<a href="${txLink(r.hash)}">tx</a>`
    })
  }
  bot.callbackQuery(/^pd:(\d+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery('Depositing…')
    const w = await requireWallet(ctx)
    if (w) await presaleDeposit(ctx, w, Number(ctx.match[1]), ctx.match[2]!)
  })
  bot.callbackQuery(/^px:(\d+)$/, (ctx) => ask(ctx, { kind: 'presaleDeposit', memeId: Number(ctx.match[1]) }, 'How much NEAR to deposit?'))
  bot.callbackQuery(/^pw:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery('Withdrawing…')
    const w = await requireWallet(ctx)
    if (!w) return
    const id = Number(ctx.match[1])
    await runTrade(ctx, w, `meme-${id}`, `Withdrawing from presale #${id}`, async () => {
      const r = await w.trader.presaleWithdraw(id)
      return `✅ Withdrew — got back <b>${usdNear(r.received, w.trader.cachedNearUsd())}</b> (after the 2% fee)\n<a href="${txLink(r.hash)}">tx</a>`
    })
  })
  bot.callbackQuery(/^pc:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery('Claiming…')
    const w = await requireWallet(ctx)
    if (!w) return
    const id = Number(ctx.match[1])
    await runTrade(ctx, w, `meme-${id}`, `Claiming presale #${id}`, async () => {
      const r = await w.trader.presaleClaim(id)
      return r.kind === 'tokens'
        ? `✅ Claimed <b>${formatUnits(r.amount, 18, 0)} $${esc(r.symbol)}</b>\n<code>${r.tokenId}</code> · <a href="${txLink(r.hash)}">tx</a>`
        : `✅ Refunded <b>${usdNear(r.amount, w.trader.cachedNearUsd())}</b> · <a href="${txLink(r.hash)}">tx</a>`
    })
  })

  // --------------------------------------------------------------- settings

  const settingsPanel = async (ctx: Context) => {
    const w = await requireWallet(ctx)
    if (!w) return
    const s = w.store.state
    const text =
      `⚙️ <b>Settings</b>\n\n` +
      `Slippage: ${s.settings.slippageBps / 100}%\n` +
      `After a curve sell: ${s.settings.sellToNear ? 'swap JAMBO → NEAR' : 'keep JAMBO'}\n\n` +
      `No bot fees — only network gas and pride.j1.gay's own 60 JAMBO per curve trade.`
    const kb = new InlineKeyboard()
      .text('Slippage', 'set:slip')
      .text(s.settings.sellToNear ? 'Sells → NEAR ✅' : 'Sells → keep JAMBO', 'set:s2n')
      .row()
      .text('⬅ Menu', 'menu')
    await reply(ctx, text, kb)
  }
  bot.callbackQuery('set:slip', (ctx) => ask(ctx, { kind: 'slippage' }, 'Slippage in %? e.g. <code>15</code>'))
  bot.callbackQuery('set:s2n', async (ctx) => {
    const w = await requireWallet(ctx)
    if (!w) return
    w.store.state.settings.sellToNear = !w.store.state.settings.sellToNear
    w.store.save()
    await ctx.answerCallbackQuery()
    await settingsPanel(ctx)
  })

  // ----------------------------------------------------------- admin panel

  const adminPanel = async (ctx: Context) => {
    if (!isAdmin(ctx.from!.id)) return void (await ctx.answerCallbackQuery?.('Admins only'))
    const allowed = accounts.listAllowed()
    const lines = allowed.length ? allowed.map(([uid, e]) => `• <code>${uid}</code>${e.note ? ` — ${esc(e.note)}` : ''} (by ${e.addedBy})`).join('\n') : '<i>no ids granted yet</i>'
    const text =
      `🛠 <b>Admin panel</b>\n\n` +
      `<b>Admins</b> (from env, always allowed):\n${d.admins.map((a) => `• <code>${a}</code>`).join('\n')}\n\n` +
      `<b>Granted access:</b>\n${lines}\n\n<i>Only these ids can use the bot.</i>`
    const kb = new InlineKeyboard().text('➕ Grant access', 'admin:add').row()
    for (const [uid] of allowed.slice(0, 20)) kb.text(`✖ remove ${uid}`, `admin:rm:${uid}`).row()
    kb.text('⬅ Menu', 'menu').text('🔄', 'admin')
    await reply(ctx, text, kb)
  }
  bot.callbackQuery('admin', adminPanel)
  bot.callbackQuery('admin:add', async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return void (await ctx.answerCallbackQuery('Admins only'))
    await ask(ctx, { kind: 'adminAdd' }, 'Send the Telegram user id to grant access to (numbers only). Optional note after it, e.g. <code>123456789 ops</code>.')
  })
  bot.callbackQuery(/^admin:rm:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return void (await ctx.answerCallbackQuery('Admins only'))
    const uid = Number(ctx.match[1])
    accounts.disallow(uid)
    wallets.forget(uid)
    await ctx.answerCallbackQuery(`Removed ${uid}`)
    await adminPanel(ctx)
  })
  const handleAdminAdd = async (ctx: Context, input: string) => {
    if (!isAdmin(ctx.from!.id)) return
    const [idStr = '', ...noteParts] = input.trim().split(/\s+/)
    const uid = Number(idStr)
    if (!Number.isInteger(uid) || uid <= 0) return void (await ctx.reply('That is not a valid Telegram user id. Send a number.'))
    accounts.allow(uid, ctx.from!.id, noteParts.join(' ') || undefined)
    await ctx.reply(`✅ Granted access to <code>${uid}</code>.`, HTML)
    await adminPanel(ctx)
  }

  // ----------------------------------------------------- navigation / commands

  for (const [name, panel] of [
    ['menu', menu],
    ['wallet', walletPanel],
    ['positions', positionsPanel],
    ['settings', settingsPanel],
    ['presales', presalesList],
  ] as const) {
    bot.callbackQuery(name, async (ctx) => {
      await ctx.answerCallbackQuery()
      await panel(ctx)
    })
    if (name !== 'menu') bot.command(name, panel)
  }
  bot.command(['start', 'menu'], menu)

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        '<b>Commands</b>',
        '/menu — overview',
        '/wallet — NEAR / JAMBO balances, create/import wallet',
        '/positions — holdings and PnL',
        '/presales · /meme 1987 — meme.cooking presales',
        '/settings — slippage and options',
        '/buy &lt;token&gt; &lt;amount&gt; (5 = 5 NEAR, 25k jambo) · /sell &lt;token&gt; &lt;%&gt;',
        '',
        'Or just paste a token contract to trade it.',
      ].join('\n'),
      HTML,
    ),
  )

  bot.command('meme', async (ctx) => {
    const id = parseMemeRef(ctx.match)
    if (id === null) return void (await ctx.reply('Usage: /meme 1987  (or paste a meme.cooking link)'))
    await presalePanel(ctx, id)
  })

  bot.command('buy', async (ctx) => {
    const w = await requireWallet(ctx)
    if (!w) return
    const [id = '', ...rest] = ctx.match.trim().toLowerCase().split(/\s+/)
    if (!isAccountId(id) || !rest.length) return void (await ctx.reply('Usage: /buy <token> <amount>   e.g. 5 (NEAR) or 25k jambo'))
    const { venue } = await w.trader.venueOf(id)
    if (venue === 'dex') return buyNear(ctx, w, id, rest[0]!)
    await buyCurveAmount(ctx, w, id, rest.join(' '))
  })

  bot.command('sell', async (ctx) => {
    const w = await requireWallet(ctx)
    if (!w) return
    const [id = '', p = '100'] = ctx.match.trim().toLowerCase().split(/\s+/)
    const n = Number(p.replace('%', ''))
    if (!isAccountId(id) || !(n > 0 && n <= 100)) return void (await ctx.reply('Usage: /sell <token> <1-100>'))
    await sell(ctx, w, id, n)
  })

  // /t_bober → bober.gaypad.j1-racing.near (or any traded token whose short form matches)
  bot.hears(/^\/t_(\w+)/, async (ctx) => {
    const w = wallets.get(ctx.from!.id)
    const short = ctx.match[1]!
    const known = w ? Object.keys(w.store.state.positions).find((id) => tokenCmd(id) === short) : undefined
    await tokenPanel(ctx, known ?? `${short}.gaypad.j1-racing.near`)
  })

  // ------------------------------------------------------------ free text

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim()
    const a = awaiting.get(ctx.chat.id)
    if (a) {
      awaiting.delete(ctx.chat.id)
      switch (a.kind) {
        case 'importWallet':
          return handleImport(ctx, text)
        case 'adminAdd':
          return handleAdminAdd(ctx, text)
        case 'topUp': {
          const w = await requireWallet(ctx)
          return w && topUp(ctx, w, text)
        }
        case 'buyCurveAmount': {
          const w = await requireWallet(ctx)
          return w && buyCurveAmount(ctx, w, a.tokenId, text)
        }
        case 'buyNear': {
          const w = await requireWallet(ctx)
          return w && buyNear(ctx, w, a.tokenId, text)
        }
        case 'sellPct': {
          const n = Number(text.replace('%', ''))
          if (!(n > 0 && n <= 100)) return void (await ctx.reply('Send a number from 1 to 100.'))
          const w = await requireWallet(ctx)
          return w && sell(ctx, w, a.tokenId, n)
        }
        case 'presaleDeposit': {
          const w = await requireWallet(ctx)
          return w && presaleDeposit(ctx, w, a.memeId, text)
        }
        case 'slippage': {
          const n = Number(text.replace('%', ''))
          if (!(n > 0 && n <= 90)) return void (await ctx.reply('Slippage must be between 0 and 90%.'))
          const w = await requireWallet(ctx)
          if (!w) return
          w.store.state.settings.slippageBps = Math.round(n * 100)
          w.store.save()
          return settingsPanel(ctx)
        }
      }
    }

    // meme.cooking: a link, "meme 1987" or "#1987".
    const memeId = /meme\.cooking|^#?\d{1,6}$|^meme\s+\d+/i.test(text) ? parseMemeRef(text) : null
    if (memeId !== null) return presalePanel(ctx, memeId)

    // A bare contract id, or a link containing one.
    const candidate = text.toLowerCase().match(/[a-z0-9_.-]+\.(?:near|tg|testnet)\b|[a-z0-9_-]+\.gaypad\.j1-racing\.near/)?.[0] ?? text
    if (isAccountId(candidate) && candidate.includes('.')) return tokenPanel(ctx, candidate)
    await ctx.reply('Paste a token contract (e.g. <code>bober.gaypad.j1-racing.near</code>) or use /menu.', HTML)
  })

  bot.catch((err) => log.error('bot handler error:', errMsg(err.error)))

  return bot
}

export async function setCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'menu', description: 'Overview' },
    { command: 'wallet', description: 'Balances · create/import wallet' },
    { command: 'positions', description: 'Holdings and PnL' },
    { command: 'presales', description: 'meme.cooking presales' },
    { command: 'settings', description: 'Slippage and options' },
    { command: 'help', description: 'All commands' },
  ])
}
