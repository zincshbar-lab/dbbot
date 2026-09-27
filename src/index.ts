import { loadConfig } from './config.js'
import { NearRpc } from './near/rpc.js'
import { Router } from './near/router.js'
import { Accounts } from './accounts.js'
import { WalletManager } from './wallets.js'
import { createBot, setCommands } from './bot/index.js'
import { errMsg, log } from './lib/log.js'

async function main() {
  const cfg = loadConfig()
  const rpc = new NearRpc(cfg.NEAR_RPC_URLS)
  const router = new Router(cfg.ROUTER_URL)
  const accounts = new Accounts(cfg.DATA_DIR)
  const wallets = new WalletManager(rpc, router, accounts, cfg.ENCRYPTION_SECRET, cfg.DATA_DIR)

  const bot = createBot({
    token: cfg.TELEGRAM_BOT_TOKEN,
    admins: cfg.ADMIN_TELEGRAM_IDS,
    accounts,
    wallets,
    rpc,
    encryptionSecret: cfg.ENCRYPTION_SECRET,
  })
  await setCommands(bot).catch((err) => log.warn(`could not set commands: ${errMsg(err)}`))

  const stop = (sig: string) => {
    log.info(`${sig} — stopping`)
    bot.stop()
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  log.info(`starting bot — ${cfg.ADMIN_TELEGRAM_IDS.length} admin(s), RPC ${cfg.NEAR_RPC_URLS.join(', ')}`)
  await bot.start({ onStart: (me) => log.info(`@${me.username} is live`) })
}

main().catch((err) => {
  log.error(errMsg(err))
  process.exit(1)
})
