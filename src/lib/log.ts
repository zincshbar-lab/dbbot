const ts = () => new Date().toISOString()

export const log = {
  info: (...a: unknown[]) => console.log(ts(), 'INFO', ...a),
  warn: (...a: unknown[]) => console.warn(ts(), 'WARN', ...a),
  error: (...a: unknown[]) => console.error(ts(), 'ERROR', ...a),
}

export const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))
