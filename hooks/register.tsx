import type { EngineInterface as E, Register } from 'claude-code'

type Mood = 'sleeping' | 'working' | 'waiting' | 'done' | 'stopped'
type Prefs = { isHidden: boolean; isMuted: boolean; name: string }
type Call = { tool: string } & Record<string, unknown>

const LINE: Record<Mood, string> = { sleeping: 'Napping', working: 'Working', waiting: 'Needs you', done: 'All done', stopped: 'Stopped' }
const calls = new Map<string, { owner: string; tool: string; isAsked?: boolean }>()
const waiting = new Map<string, string>()
let main: { mood: Mood; detail: string } = { mood: 'sleeping', detail: 'Send a prompt to wake me up' }
let prefs: Prefs = { isHidden: false, isMuted: false, name: 'Cloud' }
let changedAt = 0
let shown = ''
let title = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pet', description: 'Show or hide Cloud, mute its notifications, or rename it', argumentHint: '[show|hide|mute|unmute|name <name>]', immediate: true })
    await setPrefs($, {}, false)
    if ((await readFile($, 'pet.html')) !== page()) await writeFile($, 'pet.html', page())
    await publish($)
    await launch($)
    $.clock.every(60_000, () => void publish($))
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    title = e.session_title ?? (e.source === 'clear' ? '' : title)
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    title = e.session_title ?? title
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') await publish($, 'ended')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await setStatus($, { mood: 'working', detail: 'Thinking…' })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const call = e as unknown as Call
    const isQuestion = call.tool === 'AskUserQuestion'
    calls.set(e.tool_use_id, { owner: e.agentId ?? '', tool: call.tool })
    if (isQuestion) waiting.set(e.tool_use_id, 'Has a question for you')
    await setStatus($, e.agentId || isQuestion ? undefined : { mood: 'working', detail: activity(call) })
    if (isQuestion) await notify($, 'has a question for you', 'Claude is waiting on your answer.')
    try {
      return await next(e)
    } finally {
      calls.delete(e.tool_use_id)
      waiting.delete(e.tool_use_id)
      await setStatus($)
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const call = calls.get(e.tool_use_id ?? '')
    if (call && verdict.decision === 'ask') call.isAsked = true
    return verdict
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const mine = [...calls].reverse().filter(([id, c]) => c.owner === (e.agent_id ?? '') && c.tool === e.tool_name && !waiting.has(id))
    const [id, call] = mine.find(([, c]) => c.isAsked) ?? mine[0] ?? []
    if (id && call) {
      call.isAsked = false
      waiting.set(id, `Wants to use ${label(e.tool_name)}`)
    }
    await setStatus($)
    await notify($, 'needs your OK', `Claude wants to use ${label(e.tool_name)}.`)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const time = took(e.durationMs)
    if (e.reason === 'answer') {
      await setStatus($, { mood: 'done', detail: `Finished in ${time}` })
      await notify($, 'is done', [time, summary(e.answer)].filter(Boolean).join(': '))
    } else {
      const why = e.reason === 'aborted' ? 'You interrupted the turn' : e.reason === 'refusal' ? 'The model declined to continue' : 'The turn ended on an error'
      await setStatus($, { mood: 'stopped', detail: why })
      if (e.reason !== 'aborted') await notify($, 'stopped', `${why}.`)
    }
    return next(e)
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    await setPrefs($, {}, false)
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const changes = new Map<string, Partial<Prefs>>([
      ['', { isHidden: !prefs.isHidden }],
      ['show', { isHidden: false }],
      ['hide', { isHidden: true }],
      ['mute', { isMuted: true }],
      ['unmute', { isMuted: false }],
    ])
    if (rest.length) changes.set('name', { name: rest.join(' ').slice(0, 24) })
    const change = changes.get(verb.toLowerCase())
    if (!change) return { text: 'Usage: /pet [show|hide|mute|unmute|name <name>]' }
    await setPrefs($, change)
    if (change.isHidden === false) await launch($)
    return { text: `${prefs.name} is ${prefs.isHidden ? 'hidden, /pet brings it back' : 'out'}. Notifications are ${prefs.isMuted ? 'muted' : 'on'}.` }
  })
}

const dir = async ($: E) => `${await $.env.get('HOME')}/.claude/cloud-pet`
const readFile = async ($: E, name: string) => $.fs.read(`${await dir($)}/${name}`).catch(() => undefined)
const writeFile = async ($: E, name: string, text: string) => $.fs.write(`${await dir($)}/${name}`, text).catch(() => undefined)
const sessionName = async ($: E) => title || (await $.session.cwd()).split('/').pop()

function current(): { mood: Mood; detail: string } {
  const wait = [...waiting.values()].pop()
  return wait ? { mood: 'waiting', detail: wait } : main
}

async function setStatus($: E, change?: typeof main) {
  if (change) main = change
  const { mood, detail } = current()
  if (`${mood}|${detail}` !== shown) [shown, changedAt] = [`${mood}|${detail}`, Date.now()]
  await publish($)
}

async function publish($: E, ended?: 'ended') {
  const sessionId = await $.session.id()
  const path = `${await dir($)}/sessions/${sessionId}.json`
  const name = await sessionName($)
  const { mood, detail } = current()
  await $.fs.write(path, JSON.stringify({ sessionId, title: name, mood: ended ?? mood, line: LINE[mood], detail, changedAt, heartbeatAt: Date.now() })).catch(() => undefined)
}

async function setPrefs($: E, change: Partial<Prefs>, isSaved = true) {
  const saved = await readFile($, 'prefs.json').then(text => JSON.parse(text ?? '{}')).catch(() => ({}))
  prefs = { ...prefs, ...saved, ...change }
  if (isSaved) await writeFile($, 'prefs.json', JSON.stringify(prefs))
}

async function notify($: E, what: string, body: string) {
  await setPrefs($, {}, false)
  const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run'
  if (!prefs.isMuted) await $.process.run(['osascript', '-e', script, '--', `${prefs.name} ${what} · ${await sessionName($)}`, body]).catch(() => undefined)
}

async function launch($: E) {
  const app = `${await dir($)}/CloudPet.app`
  if (!(await $.fs.exists(app))) await $.process.run(['/bin/bash', `${$.plugin.root}/float/build.sh`, app], { timeoutMs: 300_000 }).catch(() => undefined)
  await $.process.run(['/usr/bin/open', '-g', app]).catch(() => undefined)
}

function activity(call: Call) {
  const arg = (key: string) => (typeof call[key] === 'string' ? (call[key] as string) : '')
  const file = arg('file_path').split('/').pop()
  switch (call.tool) {
    case 'Read': return `Reading ${file}`
    case 'Edit': case 'Write': return `Editing ${file}`
    case 'Bash': return clip(arg('description')) || 'Running a command'
    case 'Grep': case 'Glob': return 'Searching the code'
    case 'WebSearch': case 'WebFetch': return 'Browsing the web'
    case 'Agent': return 'Sending out a helper'
  }
  return `Using ${label(call.tool)}`
}

const label = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__').slice(2).join(' ').replace(/_/g, ' ') : tool)
const summary = (answer: string) => clip(answer.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#>|]/g, ''), 140)

function clip(text: string, max = 80) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function took(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`
}

const INK = '#2A1E1A'
const BODY = '#D97757'
const BELLY = '#F2C4AE'
const loop = (attrs: string) => `<animateTransform attributeName="transform" ${attrs} repeatCount="indefinite"/>`
const wag = (deg: number, dur: number) => loop(`type="rotate" values="0 50 47;-${deg} 50 47;0 50 47" dur="${dur}s"`)
const stroke = (d: string, width = 2.2) => `<path d="${d}" stroke="${INK}" stroke-width="${width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
const blink = (attr: string, values: string) => `<animate attributeName="${attr}" values="${values}" keyTimes="0;.9;.95;1" dur="3.6s" repeatCount="indefinite"/>`
const eyes = (ry: number) =>
  `<g>${loop('type="translate" values="-1.5 0;1.5 0;1.5 0;-1.5 0;-1.5 0" keyTimes="0;.2;.5;.7;1" dur="2.6s"')}` +
  [24.5, 39.5].map(cx => `<ellipse cx="${cx}" cy="37" rx="${ry - 0.5}" ry="${ry}" fill="${INK}">${blink('ry', `${ry};${ry};.3;${ry}`)}</ellipse><circle cx="${cx + 1}" cy="${37 - ry / 2.6}" r=".9" fill="#fff">${blink('opacity', '1;1;0;1')}</circle>`).join('') +
  '</g>'
const zee = (x: number, size: number, begin: string) =>
  `<text x="${x}" y="16" font-size="${size}" font-family="Helvetica, sans-serif" font-weight="700" fill="#9A9A9A" opacity="0">z<animate attributeName="opacity" values="0;1;0" dur="2.6s" begin="${begin}" repeatCount="indefinite"/><animate attributeName="y" values="18;6" dur="2.6s" begin="${begin}" repeatCount="indefinite"/></text>`
const dot = (x: number, begin: string) =>
  `<circle cx="${x}" cy="6" r="2.3" fill="${BODY}" opacity=".2"><animate attributeName="opacity" values=".2;1;.2" dur="1.2s" begin="${begin}" repeatCount="indefinite"/></circle>`
const badge = (fill: string, mark: string) => `<circle cx="54" cy="10" r="7.5" fill="${fill}"/>${mark}`

const PARTS: Record<Mood, [face: string, motion: string, tail: string, extra: string]> = {
  sleeping: [stroke('M21 37 q3.5 3 7 0 M36 37 q3.5 3 7 0') + `<ellipse cx="32" cy="44.5" rx="1.6" ry="1.1" fill="${INK}"/>`, loop('type="translate" values="0 0;0 1.2;0 0" dur="3s"'), '', zee(47, 9, '0s') + zee(53, 7, '1.3s')],
  working: [eyes(3.2) + stroke('M29.5 44.5 h5', 2), loop('type="translate" values="0 0;0 -2.5;0 0" dur=".6s"'), wag(10, 1.2), dot(24, '0s') + dot(32, '.2s') + dot(40, '.4s')],
  waiting: [eyes(3.8) + `<ellipse cx="32" cy="45" rx="2" ry="2.4" fill="${INK}"/>`, loop('type="rotate" values="-5 32 56;5 32 56;-5 32 56" dur="1.4s"'), wag(6, 0.8), badge('#E8A33D', '<rect x="53" y="5" width="2" height="6.5" rx="1" fill="#fff"/><circle cx="54" cy="14.4" r="1.2" fill="#fff"/>')],
  done: [stroke('M21 38.5 q3.5 -4.5 7 0 M36 38.5 q3.5 -4.5 7 0', 2.4) + stroke('M27.5 43.5 q4.5 4.5 9 0'), '<animateTransform attributeName="transform" type="translate" values="0 0;0 -6;0 0;0 -3;0 0" keyTimes="0;.25;.5;.75;1" dur="1.1s" repeatCount="2"/>', wag(16, 0.45), badge('#2E9E5B', '<path d="M50.2 10.2 l2.6 2.6 l4.8 -5.2" stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')],
  stopped: [stroke('M21 35 L27 33 M43 35 L37 33', 1.8) + `<circle cx="24.5" cy="39" r="2.3" fill="${INK}"/><circle cx="39.5" cy="39" r="2.3" fill="${INK}"/>` + stroke('M28 47 q4 -3.5 8 0'), '', '', '<path d="M52 17 q-3.5 5 0 7.5 q3.5 -2.5 0 -7.5z" fill="#7DB9E8"/>'],
}

function svg(mood: Mood) {
  const [face, motion, tail, extra] = PARTS[mood]
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><ellipse cx="32" cy="60" rx="15" ry="2.5" fill="#000" opacity=".14"/>' +
    `<g>${motion}<path d="M50 47 q10 -1 9 -13" stroke="${BODY}" stroke-width="4.5" fill="none" stroke-linecap="round">${tail}</path>` +
    `<path d="M14.5 31 L17.5 11.5 L30 22 Z M49.5 31 L46.5 11.5 L34 22 Z" fill="${BODY}"/><path d="M18.5 26 L19.8 16.5 L26 21.8 Z M45.5 26 L44.2 16.5 L38 21.8 Z" fill="${BELLY}"/>` +
    `<ellipse cx="32" cy="38" rx="21" ry="18" fill="${BODY}"/><ellipse cx="32" cy="48" rx="10" ry="6.5" fill="${BELLY}" opacity=".6"/>` +
    '<ellipse cx="23" cy="55.5" rx="5.5" ry="3" fill="#C4623F"/><ellipse cx="41" cy="55.5" rx="5.5" ry="3" fill="#C4623F"/>' +
    `<circle cx="19.5" cy="42" r="2.8" fill="#F28B7A" opacity=".55"/><circle cx="44.5" cy="42" r="2.8" fill="#F28B7A" opacity=".55"/>${face}</g>${extra}</svg>`
  )
}

function page() {
  const drawings = JSON.stringify(Object.fromEntries(Object.keys(PARTS).map(mood => [mood, svg(mood as Mood)]))).replace(/<\//g, '<\\/')
  return `<!doctype html><meta charset="utf-8"><style>
:root { color-scheme: light dark; --bg: #fff; --ink: #1f1e1d; --dim: #6b6862; --edge: rgba(0, 0, 0, .12) }
@media (prefers-color-scheme: dark) { :root { --bg: #2b2a27; --ink: #f3f1ec; --dim: #a8a49c; --edge: rgba(255, 255, 255, .14) } }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; -webkit-user-select: none; cursor: default }
body { display: flex; align-items: center; gap: 6px; padding: 0 4px; box-sizing: border-box; font: 12px/1.3 -apple-system, sans-serif }
body.right { flex-direction: row-reverse }
#pet { width: 56px; height: 56px; flex: none }
#pet svg { display: block }
#bubble { flex: 1; min-width: 0; background: var(--bg); color: var(--ink); border: 1px solid var(--edge); border-radius: 12px; padding: 6px 10px; box-shadow: 0 1px 4px rgba(0, 0, 0, .18) }
#bubble[hidden] { display: none }
#title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
#sub { color: var(--dim); font-size: 11px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden }
</style><div id="bubble" hidden><div id="title"></div><div id="sub"></div></div><div id="pet"></div><script>
const drawings = ${drawings}
let mood
function show(state) {
  if (state.mood !== mood) pet.innerHTML = drawings[mood = state.mood]
  title.textContent = state.title
  sub.textContent = state.sub
  bubble.hidden = !state.bubble
  document.body.className = state.side
}
</script>`
}
