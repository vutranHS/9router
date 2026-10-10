import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Hud, Quota, Window } from '../types'

const hud = atom({ plugin: '9router-hud', key: 'hud' } as const, { quota: null, offline: false, tools: 0, running: [] } as Hud)

// The router injects nothing here: Claude Code already sends X-Claude-Code-Session-Id,
// which the router binds to the account that served the request.
async function refresh($: EngineInterface) {
  const url = await $.env.get('ANTHROPIC_BASE_URL')
  const key = (await $.env.get('ANTHROPIC_AUTH_TOKEN')) || (await $.env.get('ANTHROPIC_API_KEY'))
  if (!url || !key) return
  const base = url.replace(/\/+$/, '').replace(/\/v1$/, '')
  const session = await $.session.id()
  try {
    const r = await $.http.fetch(`${base}/v1/hud/quota?session=${encodeURIComponent(session)}`, { headers: { authorization: `Bearer ${key}` } })
    const quota: Quota = JSON.parse(r.text)
    await update($, hud, s => ({ ...s, offline: !r.ok && r.status >= 500, quota: r.ok ? quota : { ...s.quota, status: quota.error ? String(quota.error) : `HTTP ${r.status}` } }))
  } catch {
    await update($, hud, s => ({ ...s, offline: true }))
  }
}

export function left(w: Window | undefined, now: number) {
  if (!w) return '--'
  const reset = w.resets_at ? Date.parse(w.resets_at) : NaN
  if (reset <= now) return 'awaiting refresh'
  const pct = `${Math.round(100 - w.used_percentage)}% left`
  if (!Number.isFinite(reset)) return pct
  const m = Math.ceil((reset - now) / 60000)
  return `${pct} (${m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : `${Math.floor(m / 60)}h ${m % 60}m`})`
}

const tone = (pctLeft: number) => (pctLeft > 50 ? 'success' : pctLeft > 20 ? 'warning' : 'error')

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    timer?.cancel()
    timer = $.clock.every(60000, () => void refresh($))
    void refresh($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await update($, hud, s => ({ ...s, tools: s.tools + 1, running: [...s.running, e.tool].slice(-3) }))
    try {
      return await next(e)
    } finally {
      await update($, hud, s => {
        const i = s.running.lastIndexOf(e.tool)
        return i < 0 ? s : { ...s, running: s.running.filter((_, j) => j !== i) }
      })
    }
  }).catch(($, e, next) => next(e)) // HUD must never block a tool

  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, hud)
    const { context } = await $.session.usage()
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const q = s.quota ?? {}
    const ctxPct = context.percent != null ? Math.round(context.percent) : null
    const k = (n?: number) => (n != null ? `${(n / 1000).toFixed(1)}k` : '?')
    const status = s.offline ? 'router offline' : q.status && !['ok', 'waiting'].includes(q.status) ? q.status : ''
    const age = q.updated_at ? Math.max(0, Math.floor((now - Date.parse(q.updated_at)) / 60000)) : null
    const win = (label: string, w: Window | undefined) => (
      <Text>
        <Text bold color="suggestion">{label} </Text>
        <Text color={w ? tone(100 - w.used_percentage) : 'subtle'}>{left(w, now)}</Text>
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text bold color="suggestion">Context </Text>
          <Text color={ctxPct == null ? 'subtle' : ctxPct < 50 ? 'success' : ctxPct < 80 ? 'warning' : 'error'}>{ctxPct == null ? '--' : `${ctxPct}%`}</Text>
          <Text dimColor> {k(context.tokens)}/{k(context.window)} · </Text>
          <Text bold color="suggestion">Account </Text>
          <Text>{q.account?.label ?? 'waiting for first response'}</Text>
          {status ? <Text color="warning"> · {status}</Text> : null}
        </Text>
        <Text wrap="truncate">
          {win('5h', q.five_hour)}
          <Text dimColor> · </Text>
          {win('7d', q.seven_day)}
          {age != null ? <Text dimColor> · updated {age}m ago</Text> : null}
        </Text>
        <Text wrap="truncate">
          <Text bold color="suggestion">Tools </Text>
          <Text bold>{s.tools}</Text>
          {s.running.length ? <Text color="warning"> · running {s.running.join(', ')}</Text> : null}
        </Text>
      </Box>
    )
  })
}
