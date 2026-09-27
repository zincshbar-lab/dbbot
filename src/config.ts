import { z } from 'zod'

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d{6,12}:[A-Za-z0-9_-]{30,}$/, 'must look like 123456789:AA... (copy it again from @BotFather)'),

  /** Admin Telegram ids. Admins can open the admin panel and grant/revoke access. Comma-separated. */
  ADMIN_TELEGRAM_IDS: z
    .string()
    .min(1)
    .transform((s) => s.split(',').map((id) => Number(id.trim())).filter(Number.isFinite)),

  /** Secret used to derive the AES-256-GCM key that encrypts each user's stored private key. */
  ENCRYPTION_SECRET: z.string().min(16, 'set a long random ENCRYPTION_SECRET (>= 16 chars)'),

  /** Reads fall back through these in order. */
  NEAR_RPC_URLS: z
    .string()
    .default('https://free.rpc.fastnear.com,https://near.drpc.org')
    .transform((s) => s.split(',').map((u) => u.trim()).filter(Boolean)),

  ROUTER_URL: z.string().url().default('https://router.intear.tech'),

  /** Where state is stored. On Railway, mount a volume here. */
  DATA_DIR: z.string().default('./data'),
})

export type Config = z.infer<typeof schema>

/** Pasted values often carry stray whitespace or wrapping quotes (e.g. from a dashboard). */
function clean(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) out[k] = v?.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  return out
}

export function loadConfig(env = process.env): Config {
  const parsed = schema.safeParse(clean(env))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment:\n${issues}`)
  }
  if (!parsed.data.ADMIN_TELEGRAM_IDS.length) throw new Error('ADMIN_TELEGRAM_IDS has no valid ids')
  return parsed.data
}
