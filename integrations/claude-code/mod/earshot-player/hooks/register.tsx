import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { EarshotClip } from '../types'

const LINE =
  /\n*\[(?:Listen|Listen original|Original)\]\((https?:\/\/[^)\s]+)\)(?:\s*·\s*\[(?:Listen original|Original)\]\((https?:\/\/[^)\s]+)\))?[ \t]*$/i

export function parseClip(text: string): { clip: EarshotClip; body: string } | null {
  const m = LINE.exec(text)
  if (m === null) return null
  const clip: EarshotClip = { edited: m[1] ?? '' }
  if (m[2] !== undefined) clip.original = m[2]
  return { clip, body: text.slice(0, m.index) }
}

const playing = atom({ plugin: 'earshot-player', key: 'playing' } as const, '')

// One clip at a time, across every message. Lost on reload, which also stops nothing
// the engine still plays; acceptable for a short memo.
let current: { id: string; ctl: AbortController } | null = null
const cache = new Map<string, string>()

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Mobile: host audio plays on the Mac, not the phone. No-op: the reply's own
    // links stay as they are so the phone opens them in its native player.
    if (e.surface === 'mobile') return next(e)
    const parsed = parseClip(e.props.text)
    if (parsed === null) return next(e)

    const { Box, Button } = $.ui.resolve(e)
    const { clip, body } = parsed
    const active = await read($, playing)
    const row = await next({ ...e, props: { ...e.props, text: body } })

    // Bytes through curl with no proxy: the host's own fetch can go through a
    // proxy that cannot reach private hosts. Falls back to the URL.
    async function bytes(url: string) {
      const hit = cache.get(url)
      if (hit !== undefined) return { base64: hit, mime: 'audio/mpeg' }
      try {
        const r = await $.process.run(
          ['/bin/sh', '-c', 'curl -fsS --noproxy "*" -m 40 "$0" | base64', url],
          { timeoutMs: 60000 },
        )
        const b64 = r.stdout.replace(/\s+/g, '')
        if (r.exitCode === 0 && b64.length > 0) {
          cache.set(url, b64)
          return { base64: b64, mime: 'audio/mpeg' }
        }
      } catch {}
      return { url }
    }

    async function toggle(id: string, url: string) {
      const was = current
      if (was !== null) {
        current = null
        was.ctl.abort()
      }
      if (was?.id === id) {
        await update($, playing, () => '')
        return
      }
      const mine = { id, ctl: new AbortController() }
      current = mine
      await update($, playing, () => id)
      try {
        const clipData = await bytes(url)
        if (mine.ctl.signal.aborted) return
        await $.audio.play(clipData, { signal: mine.ctl.signal })
      } catch {
        $.ui.toast('Could not play the clip')
      } finally {
        if (current === mine) {
          current = null
          await update($, playing, () => '')
        }
      }
    }

    const items: [string, string, string][] = [['Play', 'play', clip.edited]]
    if (clip.original !== undefined) items.push(['Original', 'original', clip.original])

    const controls = items.map(([label, kind, url]) => {
      const id = `${e.requestId}:${kind}`
      return (
        <Button
          key={kind}
          plain
          onPress={() => toggle(id, url)}
        >
          {active === id ? 'Stop' : label}
        </Button>
      )
    })

    return (
      <Box flexDirection="column">
        {row}
        <Box>{controls}</Box>
      </Box>
    )
  })
}
