export type EarshotClip = { edited: string; original?: string }

declare module 'claude-code' {
  interface PluginState {
    'earshot-player': { playing: string }
  }
}
