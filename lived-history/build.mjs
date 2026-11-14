// Build presets/lived-history*.rp-team.json from the prompt sources in ./prompts.
// Usage: node presets/lived-history/build.mjs [plugin root]
// Emits the canonical exportPreset form so the files round-trip through the plugin unchanged.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const presetsDir = resolve(here, '..')
const pluginRoot = process.argv[2] ?? resolve(presetsDir, '../GitHub/rp-agent-team')
const load = rel => import(pathToFileURL(join(pluginRoot, rel)).href)
const { parsePreset, exportPreset } = await load('src/shared/schema.mjs')
const { resolveAuthorParameters } = await load('src/shared/author-parameters.mjs')
const { describeStateToolAccess } = await load('src/host/state-store.mjs')
const { validateValueSchema } = await load('src/shared/value-schema.mjs')

const VERSION = '0.3.2'
const S = 'shared'
const read = name => readFileSync(join(here, 'prompts', `${name}.md`), 'utf8').replace(/\r\n/g, '\n')
const invariants = read('_invariants').trim()
const eventFields = read('_event-fields').trim()

function prompt(name, variant) {
  const keep = variant === 'plus' ? 'plus' : 'std'
  const drop = variant === 'plus' ? 'std' : 'plus'
  return read(name)
    .replace(new RegExp(`\\[\\[${drop}\\]\\][\\s\\S]*?\\[\\[/${drop}\\]\\]\\n?`, 'g'), '')
    .replace(new RegExp(`\\[\\[/?${keep}\\]\\]\\n?`, 'g'), '')
    .replace('{{INVARIANTS}}', invariants)
    .replace('{{EVENT_FIELDS}}', eventFields)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------- shared schema pieces ----------
const str = { type: 'string' }
const num = { type: 'number' }
const bool = { type: 'boolean' }
const strs = { type: 'array', items: str }
const anyArr = { type: 'array' }
const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) })
const arr = items => ({ type: 'array', items })
const envelope = (data, required) => obj({ summary: str, data: obj(data, required) }, ['data'])
const responseOf = (data, required) => obj({ data: obj(data, required) }, ['data'])
const SOURCES = ['裁定', '用户', '用户指定', '幕外', '正文', '正文越权', '开卷', '揭示', '补充', '找补', '作者补充', '作者修订', '摘要', '更正']
const HOW = ['亲历', '目击', '听说', '可察觉', '不知']

const beat = obj({
  who: str, says: strs, does: str, withheld: str, if_then: strs, intent: str,
  options: arr(obj({ option: str, why_not: str }, ['option', 'why_not'])),
  grounds: arr(obj({ ref: str, note: str }, ['ref', 'note'])),
  departs: str, self_explanation: str, wrote: strs
}, ['who', 'says', 'does', 'grounds', 'wrote'])

// ---------- time and request ceilings ----------
// An await timeout is a ceiling that must cover everything its target waits for in turn, or the outer timer
// cancels inner work still within its own limit (0.3.0 gave 世事 240 s for 调卷, whose two 推演 alone could take
// 300 s). Derived from the inside out for the largest 接力次数. Ceilings, not expected durations.
const MAX_RELAYS = 2
// 世事's own time covers an opening round: building the records and then adjudicating the first beat took
// about 320 s of its own work in the 0.3.1 trial, before counting the wait for 调卷.
const OWN_SECONDS = { narrator: 180, world: 360, clerk: 90 }
const SIM_SECONDS = 180
// Checking a beat took 47 s in the 0.3.1 trial; checking a full draft first answered after 164 s, so the shared
// 120 s cut it off and the draft went out unchecked.
const CHECK_SIM_SECONDS = 120
const CHECK_DRAFT_SECONDS = 240
function ceilings(plus) {
  const askFile = OWN_SECONDS.clerk + (2 + MAX_RELAYS) * SIM_SECONDS + (plus ? CHECK_SIM_SECONDS : 0)
  const askWorld = OWN_SECONDS.world + askFile
  return {
    askSim: SIM_SECONDS, checkSim: CHECK_SIM_SECONDS, checkDraft: CHECK_DRAFT_SECONDS, askFile, askWorld,
    elapsed: OWN_SECONDS.narrator + askWorld + (plus ? CHECK_DRAFT_SECONDS : 0)
  }
}
// Every tool round trip is one model request, so count requests per activation, not members (0.3.0 counted
// about 15 for a deep beat; 世事 alone made 28 in the first trial, 13 for an opening in the 0.3.1 trial, and
// 核验 4–5 per check). Upper estimates plus a margin for retries.
const CALLS = { narrator: 6, world: 18, clerk: 8, sim: 4, checker: 5, chronicler: 8, margin: 10 }
function requestBudget(plus) {
  return CALLS.narrator + CALLS.world + CALLS.clerk + (2 + MAX_RELAYS) * CALLS.sim + CALLS.chronicler + CALLS.margin
    + (plus ? 2 * CALLS.checker : 0)
}

function handoffsFor(plus) {
  const T = ceilings(plus)
  return {
    askWorld: {
      id: 'ask-world', to: 'world', mode: 'await', timeoutMs: T.askWorld * 1000, onFailure: 'return_error',
      requestSchema: envelope({ mode: { type: 'string', enum: ['裁定', '开卷', '补充', '修订'] }, input: str, question: str, elapsed: str }, ['mode', 'input', 'question']),
      requestSelectors: ['/summary', '/data'],
      responseSchema: responseOf({
        established: arr(obj({ event: str, content: str }, ['content'])), attempts: anyArr,
        perceivable: arr(obj({ who: str, what: str }, ['who', 'what'])), surface: strs, not_reveal: strs, open: strs,
        now: str, refusal: str, tier: { type: 'string', enum: ['中', '深', '代演', '无'] }
      }, ['established', 'attempts', 'now', 'tier']),
      responseSelectors: ['/data']
    },
    tickWorld: {
      id: 'tick-world', to: 'world', mode: 'notify', timeoutMs: 240000, onFailure: 'return_error',
      requestSchema: envelope({ from: str, to: str }, ['to']), requestSelectors: ['/summary', '/data']
    },
    askFile: {
      id: 'ask-file', to: 'clerk', mode: 'await', timeoutMs: T.askFile * 1000, onFailure: 'return_error',
      requestSchema: envelope({
        mode: { type: 'string', enum: ['推演', '建档', '幕外'] }, player: str, present: strs,
        stimulus: arr(obj({ event: str, content: str }, ['content'])), midbeat: arr(obj({ content: str, when: str }, ['content'])),
        first: str, material: arr(obj({ who: str, text: str }, ['who', 'text'])), notes: strs
      }, ['mode', 'player', 'present', 'stimulus']),
      requestSelectors: ['/summary', '/data'],
      responseSchema: responseOf({
        groups: arr(obj({ slot: num, people: strs, beats: arr(beat) }, ['slot', 'people', 'beats'])),
        relays: num, untreated: strs, check: str
      }, ['groups', 'untreated']),
      responseSelectors: ['/data']
    },
    askSim: slot => ({
      id: `ask-sim-${slot}`, to: `sim-${slot}`, mode: 'await', timeoutMs: T.askSim * 1000, onFailure: 'return_error',
      requestSchema: envelope({
        seq: num, slot: { type: 'number', enum: [1, 2] }, mode: { type: 'string', enum: ['推演', '建档', '幕外', '接力'] },
        player: str, group: strs, now: str, stimulus: anyArr, relay: anyArr, people: { type: 'object' }, facing: str, check_issues: anyArr
      }, ['seq', 'slot', 'mode', 'player', 'group', 'now', 'stimulus', 'people', 'facing']),
      requestSelectors: ['/summary', '/data'],
      responseSchema: responseOf({ beats: arr(beat) }, ['beats']),
      responseSelectors: ['/data']
    }),
    checkSim: {
      id: 'check-sim', to: 'checker', mode: 'await', timeoutMs: T.checkSim * 1000, onFailure: 'return_error',
      requestSchema: envelope({ packs: anyArr, beats: anyArr }, ['packs', 'beats']), requestSelectors: ['/summary', '/data'],
      responseSchema: responseOf({
        pass: bool,
        issues: arr(obj({ who: str, kind: { type: 'string', enum: ['依据不在材料包', '背离缺依据', '读心', '替用户角色写', '解释多于动作'] }, note: str }, ['kind', 'note']))
      }, ['pass', 'issues']),
      responseSelectors: ['/data']
    },
    checkDraft: {
      id: 'check-draft', to: 'checker', mode: 'await', timeoutMs: T.checkDraft * 1000, onFailure: 'return_error',
      requestSchema: envelope({ draft: str, world_return: { type: 'object' } }, ['draft', 'world_return']), requestSelectors: ['/summary', '/data'],
      responseSchema: responseOf({
        pass: bool,
        issues: arr(obj({ kind: { type: 'string', enum: ['未确立的事', '知情越界', '暗线越过表面', '替用户角色写', '过度解释', '不合设置'] }, quote: str, note: str }, ['kind', 'note']))
      }, ['pass', 'issues']),
      responseSelectors: ['/data']
    }
  }
}

// ---------- state ----------
const eventSchema = obj({
  id: str, createdAt: str, updatedAt: str, active: bool,
  content: str, storyTime: str, people: strs, tags: strs,
  source: { type: 'string', enum: SOURCES },
  perceivers: arr(obj({ who: str, how: { type: 'string', enum: HOW }, what: str }, ['who', 'how'])),
  weight: { type: 'string', enum: ['寻常', '要紧', '转折'] },
  shown: { type: 'string', enum: ['已呈现', '仅痕迹', '未呈现', '待呈现'] },
  because: strs, changed: str, confidence: { type: 'number', minimum: 0, maximum: 1 }, covers: strs, corrects: str
}, ['content', 'storyTime', 'people', 'source', 'perceivers', 'weight', 'shown'])

const hiddenSchema = obj({
  id: str, createdAt: str, updatedAt: str, active: bool,
  content: str, people: strs, tags: strs, known_to: strs, surface: strs, ways_out: strs, since: str,
  status: { type: 'string', enum: ['隐', '已揭示'] }
}, ['content', 'known_to', 'surface', 'ways_out', 'since', 'status'])

const definitions = [
  {
    namespace: S, path: '/canon/world', type: 'object',
    valueSchema: obj({
      now: obj({ storyTime: str, place: str, present: strs, doing: str }, ['storyTime', 'place', 'present', 'doing']),
      clocks: arr(obj({ what: str, due: str, if_nothing: str, known_to: strs }, ['what', 'due', 'known_to'])),
      ties: arr(obj({ between: str, kind: str, content: str, since: str }, ['between', 'kind', 'content'])),
      agendas: arr(obj({ who: str, plan: str, next: str, known_to: strs }, ['who', 'plan', 'known_to'])),
      offstage_until: str
    }, ['now', 'clocks', 'ties', 'agendas', 'offstage_until']),
    default: { now: { storyTime: '', place: '', present: [], doing: '' }, clocks: [], ties: [], agendas: [], offstage_until: '' },
    description: '世事写：此刻、时钟、客观牵连、离场人物的议程、幕外推进到哪儿了。'
  },
  { namespace: S, path: '/canon/events', type: 'array', valueSchema: arr(eventSchema), default: [], description: '集合 events：事件只追加。世事写裁定、用户、幕外、揭示、开卷、找补、作者修订；编年写转录、摘要、呈现状态。' },
  { namespace: S, path: '/canon/hidden', type: 'array', valueSchema: arr(hiddenSchema), default: [], description: '集合 hidden：暗线，世事写。执笔只能写 surface 里的痕迹。' },
  { namespace: S, path: '/situations', type: 'object', default: {}, description: '按人名分项的客观处境，世事写。' },
  { namespace: S, path: '/selves', type: 'object', default: {}, description: '按人名分项的自述：account、commitments、toward、carrying、wants、last。只有推演能写，按键写，推演读不到。' },
  { namespace: S, path: '/memories', type: 'object', default: {}, description: '按人名分项的记忆，键以字母开头。只有推演能写，推演读不到。' },
  { namespace: S, path: '/practices', type: 'object', default: {}, description: '按人名分项的过往做法数组，编年写。' },
  { namespace: S, path: '/readings', type: 'object', default: {}, description: '按人名分项的作者暂定、错位、变化。只有编年能读写。' },
  {
    namespace: S, path: '/story/direction', type: 'object',
    valueSchema: obj({ genre: str, limits: strs, intents: arr(obj({ text: str, since: str }, ['text'])) }, ['genre', 'limits', 'intents']),
    default: { genre: '', limits: [], intents: [] },
    description: '作者设定：题材、禁区、作者意向。执笔写。文风、字数、镜头在作者参数（设置）里。'
  },
  {
    namespace: S, path: '/story/notes', type: 'object',
    valueSchema: obj({ threads: anyArr, clocks_near: strs, rhythm: str, bridging: str, audit: anyArr, style_patterns: anyArr }, ['threads', 'clocks_near', 'rhythm', 'bridging', 'audit', 'style_patterns']),
    default: { threads: [], clocks_near: [], rhythm: '', bridging: '', audit: [], style_patterns: [] },
    description: '叙事笔记，编年写。'
  },
  {
    namespace: S, path: '/story/packs', type: 'array',
    valueSchema: arr(obj({ seq: num, storyTime: str, groups: arr(obj({ slot: num, people: strs, ids: strs, omitted: { type: 'object' } }, ['slot', 'people', 'ids'])), relays: num }, ['seq', 'groups'])),
    default: [], description: '材料包日志：最近 10 次分组的名单和装进去的记录 id。调卷写，编年核对。'
  },
  {
    namespace: S, path: '/story/settings-log', type: 'array',
    valueSchema: arr(obj({ from: str, realism: str, refusal: str, cowrite: str }, ['from', 'realism', 'refusal', 'cowrite'])),
    default: [], description: '设定日志：裁定层设置从何时起用哪一档。世事写，编年按事发时的档位审查。'
  }
]

// ---------- agents ----------
const capabilities = ['builtin:web', 'builtin:setting-library', 'builtin:variables', 'builtin:workflow', 'builtin:roleplay-workflow']
  .map(id => ({ id, enabled: false }))
const perms = list => list.map(([path, access]) => ({ namespace: S, path, access }))
const names = [
  { type: 'character_card', selector: '/persona/assistant_name' },
  { type: 'character_card', selector: '/persona/user_name' }
]
const OPENING_SHOWN = { type: 'character_card', selector: '/persona/show_opening' }
const agent = fields => ({
  modelRef: 'inherit', presetId: '', capabilities, compaction: {},
  execution: { after: [], onFailure: 'continue', trustedTools: [] },
  ...fields
})

function agents(variant) {
  const plus = variant === 'plus'
  const handoffs = handoffsFor(plus)
  const list = [
    agent({
      id: 'narrator', name: '执笔',
      description: '唯一写正文、唯一发布的成员。每轮运行：读记录、分档；有后果的事交给世事裁定，再按回传写正文。',
      systemPrompt: prompt('narrator', variant),
      // No maxTokens: on reasoning models the cap also counts thinking, and 3000 was used up before any prose.
      parameters: { temperature: 0.8 },
      triggers: [{ type: 'always' }],
      // The card opening is shown in the chat but is not part of its history, so 执笔 reads whether it was shown
      // to avoid rewriting it on the opening round. Appended last: 运行.执笔读卡 is bound to sources/2.
      context: { sources: [{ type: 'current_input' }, { type: 'recent_history', limit: 12 }, ...names, OPENING_SHOWN] },
      communication: {
        sendTo: ['world'], receiveFrom: ['world', ...(plus ? ['checker'] : [])],
        requestTo: ['world', ...(plus ? ['checker'] : [])], requestFrom: [],
        handoffs: [handoffs.askWorld, handoffs.tickWorld, ...(plus ? [handoffs.checkDraft] : [])]
      },
      statePermissions: perms([
        ['/canon/world', 'read'], ['/canon/events', 'read'], ['/canon/hidden', 'read'], ['/situations', 'read'],
        ['/selves', 'read'], ['/practices', 'read'], ['/story/notes', 'read'], ['/story/direction', 'readwrite']
      ]),
      outputAuthority: { internal: true, draft: false, state: true, user: true },
      execution: { after: [], onFailure: 'stop', trustedTools: [] }
    }),
    agent({
      id: 'world', name: '世事',
      description: '唯一确立事实的成员：登记刺激、交调卷推演、按世界条件裁定结果、推进幕外。不替人物做决定。',
      systemPrompt: prompt('world', variant),
      parameters: { temperature: 0.5 },
      triggers: [
        { type: 'requested_by_agent', from: ['narrator'], id: 'world-request' },
        { type: 'message_received', from: ['narrator'], id: 'world-tick' }
      ],
      context: { sources: [{ type: 'agent_messages', agentIds: ['narrator'] }, { type: 'current_input' }, { type: 'recent_history', limit: 12 }, { type: 'character_card' }, { type: 'worldbook' }] },
      communication: { sendTo: ['narrator'], receiveFrom: ['narrator', 'clerk'], requestTo: ['clerk'], requestFrom: ['narrator'], handoffs: [handoffs.askFile] },
      statePermissions: perms([
        ['/canon/world', 'readwrite'], ['/canon/events', 'readwrite'], ['/canon/hidden', 'readwrite'], ['/situations', 'readwrite'],
        ['/story/settings-log', 'readwrite'], ['/story/direction', 'read'], ['/story/notes', 'read']
      ]),
      outputAuthority: { internal: true, draft: false, state: true, user: false }
    }),
    agent({
      id: 'clerk', name: '调卷',
      description: '按知情范围分组、装材料包、找先例，依次交给推演一和推演二，把回执原样交回世事。不提建议。',
      systemPrompt: prompt('clerk', variant),
      parameters: { temperature: 0.2 },
      triggers: [{ type: 'requested_by_agent', from: ['world'], id: 'clerk-request' }],
      context: { sources: [{ type: 'agent_messages', agentIds: ['world'] }, { type: 'current_input' }] },
      communication: {
        sendTo: ['world'], receiveFrom: ['world', 'sim-1', 'sim-2', ...(plus ? ['checker'] : [])],
        requestTo: ['sim-1', 'sim-2', ...(plus ? ['checker'] : [])], requestFrom: ['world'],
        handoffs: [handoffs.askSim(1), handoffs.askSim(2), ...(plus ? [handoffs.checkSim] : [])]
      },
      statePermissions: perms([
        ['/canon/world', 'read'], ['/canon/events', 'read'], ['/canon/hidden', 'read'], ['/situations', 'read'],
        ['/selves', 'read'], ['/memories', 'read'], ['/practices', 'read'], ['/story/packs', 'readwrite']
      ]),
      outputAuthority: { internal: true, draft: false, state: true, user: false }
    }),
    ...[1, 2].map(slot => agent({
      id: `sim-${slot}`, name: slot === 1 ? '推演一' : '推演二',
      description: `只看调卷发来的材料包，替一组人决定这一拍各自怎么做；只写不读本组人的自述和记忆。${slot === 1 ? '先推演的一组。' : '后推演的一组。'}`,
      systemPrompt: prompt('sim', variant),
      parameters: { temperature: 0.95 },
      triggers: [{ type: 'requested_by_agent', from: ['clerk'], id: `sim-${slot}-request` }],
      context: { sources: [{ type: 'agent_messages', agentIds: ['clerk'] }] },
      communication: { sendTo: ['clerk'], receiveFrom: ['clerk'], requestTo: [], requestFrom: ['clerk'] },
      statePermissions: perms([['/selves', 'write'], ['/memories', 'write']]),
      outputAuthority: { internal: true, draft: false, state: true, user: false }
    })),
    agent({
      id: 'chronicler', name: '编年',
      description: '后台成员，隔几轮与执笔并行：转录、过往做法、作者暂定、错位与变化、材料包核对、审查、叙事笔记、压缩。',
      systemPrompt: prompt('chronicler', variant),
      parameters: { temperature: 0.3 },
      triggers: [
        { type: 'periodic', every: 2, offset: 0, id: 'chronicler-periodic' },
        { type: 'keyword', keywords: ['【开卷】'], match: 'any', id: 'chronicler-opening' }
      ],
      context: { sources: [{ type: 'current_input' }, { type: 'recent_history', limit: 6 }, ...names] },
      communication: { sendTo: [], receiveFrom: [], requestTo: [], requestFrom: [] },
      statePermissions: perms([
        ['/canon/events', 'readwrite'], ['/practices', 'readwrite'], ['/readings', 'readwrite'], ['/story/notes', 'readwrite'],
        ['/canon/world', 'read'], ['/canon/hidden', 'read'], ['/situations', 'read'], ['/selves', 'read'], ['/memories', 'read'],
        ['/story/direction', 'read'], ['/story/packs', 'read'], ['/story/settings-log', 'read']
      ]),
      outputAuthority: { internal: true, draft: false, state: true, user: false }
    })
  ]
  if (plus) list.push(agent({
    id: 'checker', name: '核验',
    description: '增强版：发布前核对推演回执（调卷请求）和正文草稿（执笔请求），只指出问题。读不到作者暂定、暗线库、过往做法。',
    systemPrompt: prompt('checker', variant),
    parameters: { temperature: 0.2 },
    triggers: [{ type: 'requested_by_agent', from: ['clerk', 'narrator'], id: 'checker-request' }],
    context: { sources: [{ type: 'agent_messages', agentIds: ['clerk', 'narrator'] }] },
    communication: { sendTo: ['clerk', 'narrator'], receiveFrom: [], requestTo: [], requestFrom: ['clerk', 'narrator'] },
    statePermissions: perms([['/canon/events', 'read']]),
    outputAuthority: { internal: true, draft: false, state: false, user: false }
  }))
  return list
}

// ---------- settings (author parameters) ----------
// Plugin 0.7.0 inserts a choice's option text, or a switch's on/off text, at its {{param:id}} slot, so every
// setting is a dropdown or a switch, like toggling preset entries. The 【档位】 prefix in each text tells the
// members (and 世事's settings-log) which tier is in effect. Free-text 附加 fields stay text.
const textBind = ids => ids.map(agentId => ({ target: { kind: 'agent', agentId, path: '/systemPrompt' }, mode: 'text' }))
const setBind = (agentId, path) => ({ target: { kind: 'agent', agentId, path }, mode: 'set' })
const deliverNote = deliver => `送达：${deliver.map(a => AGENT_NAMES[a]).join('、')}。`
const groupOf = id => id.split('.')[0]

function settings(variant) {
  const plus = variant === 'plus'
  const C = plus ? ['checker'] : []
  const choice = (id, name, deliver, def, options, note = '') => ({
    id, name, group: groupOf(id), type: 'choice', description: deliverNote(deliver) + note,
    options: options.map(({ tier, label = tier, text }) => ({ label, value: tier, text: `【${tier}】${text}` })),
    default: def, bindings: textBind(deliver)
  })
  const free = (id, name, deliver, note) => ({
    id, name, group: groupOf(id), type: 'text', description: deliverNote(deliver) + note, default: '', bindings: textBind(deliver)
  })
  const list = [
    choice('呈现.文风', '文风', ['narrator', ...C], '白描短句', [
      { tier: '白描短句', text: '第三人称，白描为主。句子短，少用形容词和比喻；多写动作、物件和原话。不抒情，不总结。' },
      { tier: '细描', text: '第三人称，可以写得细一些：环境、动作、物件都可以多写几笔；但不抒情、不总结、不堆比喻。' },
      { tier: '口语化', text: '第三人称，叙述贴近人物的口语，句子短，可以带方言词，不写书面腔。' }
    ], '只管文风，不管剧情走向。想要别的文风，写进「呈现附加要求」。'),
    choice('呈现.字数', '篇幅', ['narrator', ...C], '中', [
      { tier: '短', label: '短：150–300 字', text: '每轮正文约 150–300 字。写不满就写短，停在该停的地方。' },
      { tier: '中', label: '中：300–800 字', text: '每轮正文约 300–800 字。写不满就写短，停在该停的地方。' },
      { tier: '长', label: '长：800–1500 字', text: '每轮正文约 800–1500 字。写不满就写短，不用新事件凑字数。' }
    ]),
    choice('呈现.镜头', '镜头', ['narrator', ...C], '跟随', [
      { tier: '跟随', text: '只呈现用户角色此刻能看到、听到、感知到的。幕外的事只以痕迹出现在用户角色面前，不插入幕外镜头。' },
      { tier: '可切', text: '以用户角色的感知为主；可以插入短的幕外镜头，前后用一行「◇」隔开。幕外镜头里只写世事已裁定的事。' }
    ]),
    choice('呈现.心理', '心理描写', ['narrator', ...C], '外视为主', [
      { tier: '完全外视', text: '只写看得见、听得见的：动作、物件、原话。不进入任何人的内心。' },
      { tier: '外视为主', text: '以外视为主。主要人物可以有一两句自由间接引语，保留她自己的措辞和自我开脱。不写用户角色的内心，不替人物总结心理。' },
      { tier: '较多', label: '较多（要求镜头「可切」）', text: '可以进入非用户角色的人物内心，用她自己的措辞写，叙述者不纠正、不总结。不写用户角色的内心。' }
    ], '「较多」要求镜头设为「可切」。'),
    free('呈现.附加', '呈现附加要求', ['narrator', ...C], '用户自己的呈现要求，可以留空。只送给执笔和核验，不会送到推演。'),
    choice('裁定.现实尺度', '现实尺度', ['world', 'chronicler', ...C], '中', [
      { tier: '严', label: '严：守现实，拒绝不合理的要求', text: '用户角色的动作只算尝试，成败由世事按世界条件裁定。能力、体力、制度上做不到的：失败或受阻。按实际耗时，不压缩时间。不补世界细节。不找补。' },
      { tier: '中', label: '中：做得到的照写，做不到的受阻', text: '用户角色自己做得到的动作照写成立；作用到他人和世界上的结果由世事裁定。能力、体力上做不到的：失败或受阻。制度、社会上办不到的：受阻，可以给一条现实可行的路。过程可以略写，但不压缩实际耗时。可以补小的、不和已有记录冲突的世界细节（零钱、备用钥匙之类），来源记「补充」。不找补。' },
      { tier: '宽', label: '宽：放宽现实，为用户的要求找补', text: '用户写的结果尽量成立。做不到的，可以找补一个条件让它成立（来历、关系、物件、技能）；找补单独记一条事件，来源「找补」，注明「宽档授权」，只能作为之后的依据。时间可以压缩。' }
    ], '三条底线任何一档都不放开：用户角色知道了不该知道的事、改写已记录的事、替人物决定反应和感情。'),
    choice('裁定.拒绝呈现', '用户角色的尝试没成时', ['world', 'narrator', 'chronicler'], '故事内', [
      { tier: '故事内', text: '只在故事里呈现失败、受阻或被打断，不加作者附注。' },
      { tier: '故事内加附注', text: '在故事里呈现失败、受阻或被打断，文末用一句括号里的作者附注说明为什么没成。' },
      { tier: '先问', text: '这一轮不推进，只用括号里的作者附注说明为什么没成，并问用户要不要改写。' }
    ]),
    {
      id: '裁定.合写', name: '合写：让用户决定其他人物的反应', group: '裁定', type: 'boolean',
      description: deliverNote(['world', 'chronicler', ...C]) + '打开就意味着让出人物的一部分能动性。',
      textOff: '【关】用户写下的、关于其他人物的反应和决定，只当作用户角色的期待或猜测，不当作事实；人物实际怎样反应，交给推演。',
      textOn: '【开】用户写下的、其他人物的反应和决定，记为事件，来源「用户指定」；推演只决定她怎么做到，不决定做不做。',
      default: false, bindings: textBind(['world', 'chronicler', ...C])
    },
    free('裁定.附加', '裁定附加要求', ['world', 'chronicler', ...C], '用户自己的裁定要求，可以留空。不能越过三条底线。'),
    choice('运行.中档推演', '中档推演方式', ['world'], '独立推演', [
      { tier: '独立推演', text: '中档也经调卷交给推演，世事不替任何人物做决定。' },
      { tier: '世事代演', label: '世事代演（更快，软隔离）', text: '在场的人知情相同时，世事自己按各人的处境写最寻常的反应，事件标「未经独立推演」；知情不同时仍交给调卷。' }
    ], '世事代演更快（中档约 1～1.5 分钟），但中档只有软隔离。'),
    {
      id: '运行.接力次数', name: '接力次数上限', group: '运行', type: 'choice',
      description: deliverNote(['clerk']) + '两组都推演过之后，还允许来回几次。每次约多等 15～30 秒。',
      options: [{ label: '0：不接力', value: 0, text: '0' }, { label: '1 次', value: 1, text: '1' }, { label: '2 次', value: 2, text: '2' }],
      default: 1, bindings: textBind(['clerk'])
    },
    {
      id: '运行.执笔读卡', name: '执笔怎么读角色卡', group: '运行', type: 'choice',
      description: '默认只读角色名。读整张卡会让卡里的形容词每轮都进执笔的上下文，容易变成人设表演。',
      options: [{ label: '只读名字', value: '/persona/assistant_name' }, { label: '读整张卡', value: '' }],
      default: '/persona/assistant_name',
      bindings: [setBind('narrator', '/context/sources/2/selector')]
    },
    {
      id: '运行.执笔可见消息数', name: '执笔可见的最近消息条数', group: '运行', type: 'number',
      description: '请填整数，一问一答算两条。绑定执笔第 2 条上下文来源（recent_history）的 limit。',
      valueSchema: { type: 'number', minimum: 4, maximum: 40 }, default: 12,
      bindings: [setBind('narrator', '/context/sources/1/limit')]
    },
    {
      id: '运行.编年间隔', name: '编年间隔（轮）', group: '运行', type: 'number',
      description: '请填整数。编年只看最近 6 条消息，间隔超过 3 会漏看。绑定编年第 1 条触发器的 every。',
      valueSchema: { type: 'number', minimum: 1, maximum: 3 }, default: 2,
      bindings: [setBind('chronicler', '/triggers/0/every')]
    },
    {
      id: '运行.世事失败时', name: '世事失败时', group: '运行', type: 'choice',
      description: '停在选择前：执笔写到选择发生之前就停住。整轮失败：让用户重试。',
      options: [{ label: '停在选择前', value: 'return_error' }, { label: '整轮失败', value: 'stop' }],
      default: 'return_error',
      bindings: [setBind('narrator', '/communication/handoffs/0/onFailure')]
    },
    ...[
      ['narrator', '执笔模型', '最强的中文文学模型。'],
      ['world', '世事模型', '推理强、守规矩。'],
      ['clerk', '调卷模型', '快、结构化输出可靠，可以用便宜的模型。'],
      ['sim', '推演模型', '理解人物强。推演一、推演二共用。'],
      ['chronicler', '编年模型', '结构化输出可靠，可以用便宜的模型。'],
      ...(plus ? [['checker', '核验模型', '守规矩、细。']] : [])
    ].map(([id, name, note]) => ({
      id: `运行.${name}`, name, group: '运行', type: 'model', description: `${note}inherit = 本轮冻结的聊天模型。`, default: 'inherit',
      bindings: (id === 'sim' ? ['sim-1', 'sim-2'] : [id]).map(agentId => setBind(agentId, '/modelRef'))
    }))
  ]
  return list
}
const AGENT_NAMES = { narrator: '执笔', world: '世事', clerk: '调卷', 'sim-1': '推演一', 'sim-2': '推演二', chronicler: '编年', checker: '核验' }

// ---------- assemble ----------
function build(variant) {
  const plus = variant === 'plus'
  const params = settings(variant)
  const config = {
    schemaVersion: 2,
    id: plus ? 'lived-history-plus' : 'lived-history',
    name: plus ? '经历 Lived History（增强版）' : '经历 Lived History',
    version: VERSION,
    metadata: {
      author: 'RP Team',
      description: '文学现实主义 RP 预设：人物只作为记录存在；在场的人按知情范围分组，由不绑定人物的推演成员只看材料包推演；世事唯一裁定事实，执笔唯一发布。说明见 LIVED_HISTORY.zh-CN.md，设计见 LIVED_HISTORY_DESIGN.zh-CN.md。',
      // exportPreset derives dependencies.minimumPluginVersion (0.7.0) from features; the three-hop handoff chain
      // under maxDepth 3 also needs the 0.7.3 depth fix, which only this note can state.
      targets: 'ElecKoi v0.2.20 / v0.2.21 + RP Agent Team 0.7.3 以上（schemaVersion 2）',
      variant: plus ? '增强版：加核验' : '标准版',
      settingsRegistry: params.map(p => ({
        id: p.id, layer: p.id.split('.')[0],
        deliver: [...new Set(p.bindings.map(b => AGENT_NAMES[b.target.agentId]))],
        ...(p.id === '呈现.心理' ? { requires: '「较多」要求 呈现.镜头 为「可切」' } : {})
      }))
    },
    agents: agents(variant),
    state: { definitions },
    execution: {
      concurrency: 3, maxActivations: plus ? 14 : 12, maxPerAgent: 3, maxDepth: 3,
      budget: { maxRequests: requestBudget(plus), maxElapsedMs: ceilings(plus).elapsed * 1000 }
    },
    output: { agentId: 'narrator' },
    authorParameters: params,
    memory: {
      collections: [
        { id: 'events', name: '事件', namespace: S, path: '/canon/events', description: '客观事件，只追加；带来源、知情人、呈现状态。id 和创建时间由插件分配。' },
        { id: 'hidden', name: '暗线', namespace: S, path: '/canon/hidden', description: '尚未呈现的正典：知情人、表面痕迹、可能被发现的途径。' }
      ]
    }
  }
  const draft = { format: 'rp-team-preset-v2', dependencies: { minimumPluginVersion: '0.7.0', presets: [], models: [], toolGroups: [] }, config }
  const parsed = parsePreset(JSON.stringify(draft))
  const canonical = exportPreset(parsed)
  assert.deepEqual(exportPreset(parsePreset(JSON.stringify(canonical))), canonical, 'round trip')
  return { parsed, canonical }
}

// ---------- structural checks ----------
const META_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'active']) // filled in by the memory tools
// Fields of a schema that its example value never shows; an array example is the union of its items.
function unseenFields(schema, examples, path, out = []) {
  if (schema.items) unseenFields(schema.items, examples.flatMap(value => Array.isArray(value) ? value : []), `${path}[]`, out)
  const required = new Set(schema.required ?? [])
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const seen = examples.filter(value => value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)).map(value => value[key])
    if (!seen.length && !META_FIELDS.has(key)) out.push({ path: `${path}/${key}`, key, required: required.has(key), enums: child.enum?.filter(value => typeof value === 'string') })
    unseenFields(child, seen, `${path}/${key}`, out)
  }
  return out
}
const PARAM_TOKEN = /\{\{param:([^}]+)\}\}/g
const SIMULATION_FORBIDDEN_LAYERS = ['呈现', '裁定']
function check(variant, parsed) {
  const notes = []
  const resolved = resolveAuthorParameters(parsed).config
  for (const a of resolved.agents) {
    assert.ok(!a.systemPrompt.includes('{{'), `${a.id}: leftover template token`)
    assert.ok(!/\[\[\/?(plus|std)\]\]/.test(a.systemPrompt), `${a.id}: leftover variant marker`)
  }
  // every token in a prompt is bound to that agent, and every text binding has its token
  for (const a of parsed.agents) {
    const tokens = new Set([...a.systemPrompt.matchAll(PARAM_TOKEN)].map(m => m[1]))
    const bound = new Set(parsed.authorParameters.filter(p => p.bindings.some(b => b.mode === 'text' && b.target.agentId === a.id)).map(p => p.id))
    assert.deepEqual([...tokens].sort(), [...bound].sort(), `${a.id}: tokens vs bindings`)
    if (a.id.startsWith('sim-')) assert.equal(tokens.size, 0, 'sim prompts carry no settings')
    if (a.id === 'clerk') assert.ok([...tokens].every(t => !SIMULATION_FORBIDDEN_LAYERS.includes(t.split('.')[0])), 'clerk gets no presentation/adjudication settings')
  }
  notes.push('占位符与绑定一致；推演无设置，调卷只有运行层')
  // permission matrix
  const access = id => {
    const a = parsed.agents.find(x => x.id === id)
    return Object.fromEntries(describeStateToolAccess(a, parsed.state.definitions).map(r => [r.path, r]))
  }
  for (const id of ['sim-1', 'sim-2']) {
    const rights = access(id)
    assert.ok(Object.values(rights).every(r => !r.read), `${id} must not read anything`)
    assert.deepEqual(Object.keys(rights).filter(p => rights[p].write).sort(), ['/memories', '/selves'], `${id} writes`)
  }
  for (const a of parsed.agents) {
    const rights = access(a.id)
    if (a.id !== 'chronicler') assert.ok(!rights['/readings']?.read, `${a.id} must not read /readings`)
    if (!a.id.startsWith('sim-')) assert.ok(!rights['/selves']?.write && !rights['/memories']?.write, `${a.id} must not write selves/memories`)
    if (['narrator', 'clerk', 'sim-1', 'sim-2', 'checker'].includes(a.id)) {
      for (const p of ['/canon/world', '/canon/events', '/canon/hidden', '/situations']) assert.ok(!rights[p]?.write, `${a.id} must not write ${p}`)
    }
  }
  assert.ok(!access('world')['/selves'] && !access('world')['/memories'] && !access('world')['/practices'], 'world must not see selves/memories/practices')
  assert.ok(!access('clerk')['/story/notes'] && !access('clerk')['/story/direction'], 'clerk must not see notes/direction')
  notes.push('权限矩阵符合设计 B4')
  // context projection
  for (const id of ['sim-1', 'sim-2']) {
    const a = parsed.agents.find(x => x.id === id)
    assert.deepEqual(a.context.sources.map(s => s.type), ['agent_messages'], `${id} context`)
  }
  assert.deepEqual(parsed.agents.filter(a => a.outputAuthority.user).map(a => a.id), ['narrator'])
  notes.push('推演只有 agent_messages；唯一发布者是执笔')
  // The opening round (0.3.1 trial): the card opening was shown in the chat but not in its history, so the team
  // re-wrote it, padded it with invented errands, and never handled the user's first line.
  const narrator = parsed.agents.find(a => a.id === 'narrator')
  const readCard = parsed.authorParameters.find(p => p.id === '运行.执笔读卡')
  const readCardIndex = Number(readCard.bindings[0].target.path.split('/')[3])
  assert.equal(narrator.context.sources[readCardIndex].selector, readCard.default, '运行.执笔读卡 still binds the card-name source')
  assert.ok(narrator.context.sources.some(s => s.type === 'character_card' && s.selector === OPENING_SHOWN.selector), 'narrator reads whether the opening was shown')
  const worldPrompt = parsed.agents.find(a => a.id === 'world').systemPrompt
  for (const phrase of ['show_opening', '第 5～9 步', '不新增材料里没有的时钟']) assert.ok(worldPrompt.includes(phrase), `world opening rule missing: ${phrase}`)
  for (const phrase of ['show_opening', '【开卷那一轮怎么写】']) assert.ok(narrator.systemPrompt.includes(phrase), `narrator opening rule missing: ${phrase}`)
  for (const id of ['clerk', 'sim-1']) assert.ok(parsed.agents.find(a => a.id === id).systemPrompt.includes('开卷后的第一拍'), `${id} handles material on the first beat`)
  notes.push('开卷：执笔读开场白开关，世事建档后接着裁定第一拍、不补设')
  // A member cannot learn a required field it must write when its prompt never names it and the path's default
  // shows no example (an empty array). That is how 世事 failed ten writes in the first trial; check every member.
  for (const a of resolved.agents) {
    if (!a.outputAuthority.state) continue
    for (const row of describeStateToolAccess(a, resolved.state.definitions)) {
      const def = row.write && resolved.state.definitions.find(d => d.namespace === row.namespace && d.path === row.path)
      if (!def?.valueSchema) continue
      for (const field of unseenFields(def.valueSchema, [def.default], '')) {
        if (field.required) assert.ok(a.systemPrompt.includes(field.key), `${a.id} writes ${def.path} but its prompt never names required field ${field.path}`)
        for (const value of field.enums ?? []) assert.ok(a.systemPrompt.includes(value), `${a.id} writes ${def.path} but its prompt never lists ${field.path} value ${value}`)
      }
    }
    // Every sample line in a prompt passes the schema it illustrates.
    for (const line of a.systemPrompt.split(/\n/u).filter(item => item.startsWith('样例（'))) {
      const label = line.slice(3, line.indexOf('）'))
      const schema = label === '事件' ? resolved.state.definitions.find(d => d.path === '/canon/events').valueSchema.items
        : resolved.state.definitions.find(d => d.path === label)?.valueSchema
      assert.ok(schema, `${a.id}: sample ${label} names no schema`)
      assert.deepEqual(validateValueSchema(JSON.parse(line.slice(line.indexOf('：') + 1)), schema), [], `${a.id}: sample ${label}`)
    }
  }
  notes.push('每个成员写的带格式路径：必填字段和取值都在提示词里，样例通过校验')
  // An await timeout must exceed everything its target awaits in turn, and the run budget must cover the output
  // agent's own awaits; otherwise an outer timer cancels inner work still within its own limit.
  const awaits = a => (a.communication.handoffs ?? []).filter(h => h.mode === 'await')
  for (const a of resolved.agents) {
    for (const h of awaits(a)) {
      const inner = awaits(resolved.agents.find(x => x.id === h.to)).reduce((sum, x) => sum + x.timeoutMs, 0)
      assert.ok(h.timeoutMs > inner, `${a.id} -> ${h.id} timeout ${h.timeoutMs} does not cover the ${inner} ms its target awaits`)
    }
  }
  const outputAwaits = awaits(resolved.agents.find(a => a.id === resolved.output.agentId)).reduce((sum, h) => sum + h.timeoutMs, 0)
  assert.ok(resolved.execution.budget.maxElapsedMs > outputAwaits, 'run elapsed budget covers the output agent awaits')
  const askFile = awaits(resolved.agents.find(a => a.id === 'world'))[0].timeoutMs
  const checkDraft = awaits(resolved.agents.find(a => a.id === 'narrator')).find(h => h.id === 'check-draft')
  notes.push(`超时由内向外：调卷 ${askFile / 1000}s ⊂ 世事 ${awaits(resolved.agents.find(a => a.id === 'narrator'))[0].timeoutMs / 1000}s ⊂ 整轮 ${resolved.execution.budget.maxElapsedMs / 1000}s${checkDraft ? `；核验草稿 ${checkDraft.timeoutMs / 1000}s` : ''}；请求上限 ${resolved.execution.budget.maxRequests}`)
  // The longest request chain must fit maxDepth (each hop adds one level from plugin 0.7.3 on).
  const byId = new Map(parsed.agents.map(a => [a.id, a]))
  const longest = (id, seen = new Set()) => {
    assert.ok(!seen.has(id), `request cycle through ${id}`)
    const next = byId.get(id).communication.requestTo
    return next.length ? 1 + Math.max(...next.map(to => longest(to, new Set([...seen, id])))) : 0
  }
  const hops = Math.max(...parsed.agents.filter(a => a.triggers.some(t => t.type !== 'requested_by_agent')).map(a => longest(a.id)))
  assert.ok(hops <= parsed.execution.maxDepth, `request chain of ${hops} hops exceeds maxDepth ${parsed.execution.maxDepth}`)
  assert.equal(byId.get('narrator').parameters.maxTokens, undefined, 'narrator output is not capped')
  notes.push(`最长交接链 ${hops} 跳，maxDepth ${parsed.execution.maxDepth}；执笔不设输出上限`)
  return notes
}

for (const variant of ['std', 'plus']) {
  const { parsed, canonical } = build(variant)
  const notes = check(variant, parsed)
  const file = join(presetsDir, variant === 'plus' ? 'lived-history-plus.rp-team.json' : 'lived-history.rp-team.json')
  writeFileSync(file, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8')
  const chars = parsed.agents.map(a => `${AGENT_NAMES[a.id]} ${a.systemPrompt.length}`).join('，')
  console.log(`${variant === 'plus' ? '增强版' : '标准版'}：${file}\n  成员提示词字数：${chars}\n  作者参数 ${parsed.authorParameters.length} 项；${notes.join('；')}`)
}
