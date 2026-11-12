import { expect, test } from 'claude-code/testing'

const E = 'https://h.ts.net:8443/b/abc123/edited.mp3'
const O = 'https://h.ts.net:8443/b/abc123/original.mp3'
const WITH = `Done.\n\n[Listen](${E}) · [Listen original](${O})`

const MSG = (text: string) =>
  ({
    plugin: 'earshot-player',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text, isFirstOfReply: true },
  }) as const

declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown
const releases: (() => void)[] = []
const tick = () => new Promise(r => setTimeout(r, 30))

function engine(on: any, plays: string[], urls: string[] = []) {
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    urls.push(e.argv[e.argv.length - 1] ?? '')
    return { value: { exitCode: 0, stdout: 'QUJD\n', stderr: '' } }
  })
  on('audio.play', async ($: any, e: { clip: { base64?: string } }) => {
    plays.push(e.clip.base64 ?? 'url')
    await new Promise<void>(r => releases.push(r))
    return { value: undefined }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
}

test('no button without the earshot line', async ($, on) => {
  engine(on, [])
  const ui = await $.ui.mount({ ...MSG('Plain reply.'), surface: 'desktop' })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('the line is hidden and two controls appear', async ($, on) => {
  engine(on, [])
  const ui = await $.ui.mount({ ...MSG(WITH), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Listen/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'play' }))?.text).toBe('Play')
  expect((await ui.find({ type: 'Button', key: 'original' }))?.text).toBe('Original')
  await ui.unmount()
})

test('play, stop toggle and one clip at a time', async ($, on) => {
  const plays: string[] = []
  engine(on, plays)
  const ui = await $.ui.mount({ ...MSG(WITH), surface: 'desktop' })
  const label = async (key: string) =>
    (await ui.find({ type: 'Button', key }))?.text

  // A press waits for the clip to end, so presses run unawaited here.
  const pending: Promise<unknown>[] = []
  pending.push(ui.press({ key: 'play' }))
  await tick()
  expect(plays.length).toBe(1)
  expect(await label('play')).toBe('Stop')

  pending.push(ui.press({ key: 'play' }))
  await tick()
  expect(plays.length).toBe(1)
  expect(await label('play')).toBe('Play')

  pending.push(ui.press({ key: 'play' }))
  await tick()
  pending.push(ui.press({ key: 'original' }))
  await tick()
  expect(plays.length).toBe(3)
  expect(await label('play')).toBe('Play')
  expect(await label('original')).toBe('Stop')

  releases.forEach(r => r())
  await Promise.all(pending)
  await ui.unmount()
})

test('mobile is a no-op: the reply is untouched and no buttons are added', async ($, on) => {
  engine(on, [])
  const ui = await $.ui.mount({ ...MSG(WITH), surface: 'mobile' })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Listen/ })).toBeDefined()
  await ui.unmount()
})

test('both urls are parsed from the line and fetched on press', async ($, on) => {
  const urls: string[] = []
  engine(on, [], urls)
  const ui = await $.ui.mount({ ...MSG(WITH), surface: 'desktop' })
  const p = [ui.press({ key: 'play' })]
  await tick()
  p.push(ui.press({ key: 'original' }))
  await tick()
  expect(urls).toEqual([E, O])
  releases.forEach(r => r())
  await Promise.all(p)
  await ui.unmount()
})

test('accepts [Listen original] and a lone [Original], any case', async ($, on) => {
  engine(on, [])
  const alt = `Done.\n\n[Listen](${E}) · [Listen original](${O})`
  const ui = await $.ui.mount({ ...MSG(alt), surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'play' }))?.text).toBe('Play')
  expect((await ui.find({ type: 'Button', key: 'original' }))?.text).toBe('Original')
  await ui.unmount()

  const lower = `Done.\n\n[listen](${E}) · [ORIGINAL](${O})`
  const ui2 = await $.ui.mount({ ...MSG(lower), surface: 'desktop' })
  expect((await ui2.find({ type: 'Button', key: 'play' }))?.text).toBe('Play')
  expect((await ui2.find({ type: 'Button', key: 'original' }))?.text).toBe('Original')
  await ui2.unmount()

  const lone = `Done.\n\n[Original](${O})`
  const ui3 = await $.ui.mount({ ...MSG(lone), surface: 'desktop' })
  expect((await ui3.find({ type: 'Button', key: 'play' }))?.text).toBe('Play')
  expect(await ui3.find({ type: 'Button', key: 'original' })).toBeUndefined()
  await ui3.unmount()
})
