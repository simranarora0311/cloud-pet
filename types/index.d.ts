export type Mood = 'sleeping' | 'working' | 'waiting' | 'done' | 'stopped'
export type Status = { mood: Mood; detail: string; changedAt: number }
export type Prefs = { isHidden: boolean; isMuted: boolean; name: string }

declare module 'claude-code' {
  interface PluginState {
    'cloud-pet': { status: Status; prefs: Prefs }
  }
}
