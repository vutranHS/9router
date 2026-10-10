import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: '9router-hud',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('band shows account and quota fetched with the Claude session id', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', () => ({ cwd: '/tmp' }))
  mock.env(on, { ANTHROPIC_BASE_URL: 'https://router.example/v1', ANTHROPIC_API_KEY: 'k1' })
  const seen: { url: string; auth?: string }[] = []
  on('session.id', () => ({ value: 'sess-0123456789abcdef' }))
  on('http.fetch', (_$, e) => {
    seen.push({ url: e.url, auth: e.init?.headers?.authorization })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({
      status: 'ok', account: { label: 'a@b.c' },
      five_hour: { used_percentage: 25, resets_at: new Date(3600000).toISOString() },
      seven_day: null, updated_at: new Date(0).toISOString() }) } }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 50000, window: 200000, percent: 25 }, rateLimits: [] } }))

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  expect(seen[0]).toEqual({ url: 'https://router.example/v1/hud/quota?session=sess-0123456789abcdef', auth: 'Bearer k1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /a@b\.c/ })).toBeDefined()
    expect(await ui.find({ text: /75% left \(1h 0m\)/ })).toBeDefined()
    expect(await ui.find({ text: /25%/ })).toBeDefined()
    await ui.unmount()
  }
})
