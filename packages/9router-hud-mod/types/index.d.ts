export type Window = { used_percentage: number; resets_at: string | null } | null
export type Quota = {
  status?: string
  account?: { label: string } | null
  five_hour?: Window
  seven_day?: Window
  updated_at?: string | null
  error?: string
}
export type Hud = { quota: Quota | null; offline: boolean; tools: number; running: string[] }

declare module 'claude-code' {
  interface PluginState {
    '9router-hud': { hud: Hud }
  }
}
