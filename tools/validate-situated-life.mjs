// Offline validation for presets/situated-life.rp-team.json using the plugin's own source.
// Usage (from anywhere): node presets/tools/validate-situated-life.mjs
//   optional args: <plugin root> <preset json> <trials dir> <local-aliveness json>
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const presetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [
  pluginRoot = resolve(presetsDir, '../GitHub/rp-agent-team'),
  presetPath = join(presetsDir, 'situated-life.rp-team.json'),
  trialsDir = join(presetsDir, 'trials'),
  baselinePath = join(presetsDir, 'local-aliveness.rp-team.json')
] = process.argv.slice(2)
const load = rel => import(pathToFileURL(join(pluginRoot, rel)).href)
const { parsePreset, exportPreset } = await load('src/shared/schema.mjs')
const { resolveAuthorParameters } = await load('src/shared/author-parameters.mjs')
const { validateValueSchema } = await load('src/shared/value-schema.mjs')
const { buildAgentContext, missingContextSelections } = await load('src/host/context-policy.mjs')
const { createCommunication } = await load('src/host/communication.mjs')
const { describeStateToolAccess } = await load('src/host/state-store.mjs')
const { projectAvailableSources, childPolicy } = await load('src/host/agent-context.mjs')

let failures = 0
const results = []
async function check(label, fn) {
  try { const note = await fn(); results.push(`PASS  ${label}${note ? ` — ${note}` : ''}`) }
  catch (error) { failures++; results.push(`FAIL  ${label} — ${error?.code ?? ''} ${error?.message ?? error}`) }
}
async function rejects(fn, code) {
  try { await fn() } catch (error) {
    if (code && error?.code !== code) throw new Error(`expected ${code}, got ${error?.code}: ${error?.message}`)
    return error.code
  }
  throw new Error(`expected rejection${code ? ` ${code}` : ''}`)
}

const text = readFileSync(presetPath, 'utf8')
const file = JSON.parse(text)
let config
const byId = id => config.agents.find(agent => agent.id === id)

// 1. parsePreset and canonical export
await check('parsePreset 导入新预设', () => {
  config = parsePreset(text)
  return `id=${config.id} v${config.version}，成员 ${config.agents.map(a => a.id).join('/')}`
})
await check('文件即 exportPreset 规范形式（往返一致）', () => {
  assert.deepEqual(exportPreset(config), file)
  return `format=${file.format} minimumPluginVersion=${file.dependencies.minimumPluginVersion}`
})
await check('对照组 local-aliveness 仍可导入且 ID 不冲突', () => {
  const baseline = parsePreset(readFileSync(baselinePath, 'utf8'))
  assert.notEqual(baseline.id, config.id)
  return `${baseline.id} (${baseline.agents.length} 成员) vs ${config.id}`
})

// 2. publisher
await check('唯一发布者 = output.agentId = performer，失败即停', () => {
  const publishers = config.agents.filter(agent => agent.outputAuthority.user)
  assert.deepEqual(publishers.map(a => a.id), ['performer'])
  assert.equal(config.output.agentId, 'performer')
  assert.equal(byId('performer').execution.onFailure, 'stop')
  assert.ok(config.agents.filter(a => a.id !== 'performer').every(a => a.execution.onFailure === 'continue'))
})
await check('没有 after 依赖（后台不挡正文关键路径）', () => {
  assert.ok(config.agents.every(agent => agent.execution.after.length === 0))
})
await check('所有成员只保留 rp-team 工具组', () => {
  for (const agent of config.agents) {
    assert.ok(agent.capabilities.length > 0 && agent.capabilities.every(c => !c.enabled), agent.id)
    assert.deepEqual(agent.execution.trustedTools, [])
  }
})

// 3. parameters
await check('作者参数默认值可解析，提示词无残留标记', () => {
  const resolved = resolveAuthorParameters(config)
  for (const agent of resolved.config.agents) assert.ok(!agent.systemPrompt.includes('{{param:'), agent.id)
  return `${config.authorParameters.length} 个参数，sourceHash ${resolved.sourceHash.slice(0, 12)}`
})
await check('参数覆盖值落到正确字段', () => {
  const r = resolveAuthorParameters(config, {
    performer_history: 20, keeper_interval: 3, turn_request_cap: 24,
    backstage_model: { provider: 'p', model: 'm' }, voice_note: '第一人称，短句。'
  }).config
  const performer = r.agents.find(a => a.id === 'performer')
  assert.equal(performer.context.sources[1].type, 'recent_history')
  assert.equal(performer.context.sources[1].limit, 20)
  assert.equal(performer.parameters.maxTokens, undefined, 'the publisher has no output cap: with reasoning models the cap also counts thinking')
  assert.ok(performer.systemPrompt.includes('文风与篇幅：第一人称，短句。'))
  assert.equal(r.agents.find(a => a.id === 'keeper').triggers[0].every, 3)
  assert.equal(r.execution.budget.maxRequests, 24)
  for (const id of ['keeper', 'reading', 'recall']) assert.deepEqual(r.agents.find(a => a.id === id).modelRef, { provider: 'p', model: 'm' })
  assert.equal(performer.modelRef, 'inherit')
})
await check('非整数间隔被拒绝（不静默取整）', () => rejects(() => resolveAuthorParameters(config, { keeper_interval: 2.5 })))

// 4. handoff contracts (static)
await check('每条交接的双向 ACL / 触发器 / 消息来源 / 内部输出权', () => {
  const rows = []
  for (const from of config.agents) {
    for (const handoff of from.communication.handoffs ?? []) {
      const to = byId(handoff.to)
      assert.ok(from.communication.requestTo.includes(to.id), `${from.id}.requestTo`)
      assert.ok(to.communication.requestFrom.includes(from.id), `${to.id}.requestFrom`)
      assert.ok(to.triggers.some(t => t.type === 'requested_by_agent' && t.from.includes(from.id)), `${to.id} trigger`)
      assert.ok(to.communication.sendTo.includes(from.id), `${to.id}.sendTo (result ACL)`)
      assert.ok(from.communication.receiveFrom.includes(to.id), `${from.id}.receiveFrom (result ACL)`)
      assert.ok(to.context.sources.some(s => s.type === 'agent_messages' && s.agentIds?.includes(from.id)), `${to.id} sees request`)
      assert.ok(from.outputAuthority.internal && to.outputAuthority.internal, 'internal authority')
      assert.ok(handoff.responseSchema && handoff.responseSelectors?.every(s => s.startsWith('/data')), 'response is typed data only')
      rows.push(`${from.id}→${to.id}:${handoff.id}(${handoff.mode})`)
    }
  }
  assert.equal(rows.length, 2)
  return rows.join('，')
})

// 5. handoff contracts (driven through the real communication module)
const comm = createCommunication(config, { onRequest: async () => ({ queued: true }) })
async function roundTrip({ to, handoffId, data, result }) {
  const pending = comm.request({ from: 'performer', to, handoffId, summary: '内部说明', data, executionId: 'exec-performer' })
  const message = comm.allMessages().filter(m => m.type === 'request' && m.to === to).at(-1)
  const packet = buildAgentContext(byId(to), {}, { messages: comm.allMessages() })
  const seen = packet.sources.agent_messages?.find(m => m.requestId === message.requestId)
  assert.ok(seen, `${to} packet lacks the request`)
  await comm.bindTargetExecution(message.requestId, `exec-${to}`)
  await comm.completeTarget({ requestId: message.requestId, targetExecutionId: `exec-${to}`, result })
  return { seen, returned: await pending }
}
const goodReading = {
  knows: [{ content: '他进门时我正好把手机按灭扣在桌上', source: '亲眼所见' }, { content: '他说周六的约去不了', source: '对方亲口说' }],
  acting_on: '他有事瞒着，周六的约被别的事挤掉了', alternatives: ['只是工作临时有事'], shift: '', residue: '',
  guarding: '不想显得自己很在意那个约', admit: '说一半'
}
await check('ask-reading 往返：请求投影、类型化结果只回 data', async () => {
  const { seen, returned } = await roundTrip({
    to: 'reading', handoffId: 'ask-reading',
    data: { question: '他为什么突然取消周六', clue: '（把手机屏幕按灭，扣在桌上）……周六那个约，我可能去不了了。' },
    result: { summary: '后台长分析（不应回传）', data: goodReading, typed: true }
  })
  assert.deepEqual(Object.keys(seen.data).sort(), ['clue', 'question'])
  assert.equal(seen.summary, '', 'request summary is not projected')
  assert.deepEqual(returned, { data: goodReading })
  return 'reading 收到 {question, clue}；performer 拿回 {data}，summary 被裁掉'
})
await check('ask-recall 往返：none=true 是合法结果', async () => {
  const { returned } = await roundTrip({
    to: 'recall', handoffId: 'ask-recall', data: { cue: '上回盐放在左边柜子', why: '对方提到“上回”' },
    result: { summary: '没想起来', data: { none: true, recalled: [] }, typed: true }
  })
  assert.deepEqual(returned, { data: { none: true, recalled: [] } })
})
await check('请求缺字段 → 被 requestSchema 拒绝', () => rejects(() =>
  comm.request({ from: 'performer', to: 'reading', handoffId: 'ask-reading', data: { question: '只有问题' } }), 'RP_TEAM_HANDOFF_REQUEST_INVALID'))
await check('不带 handoffId 直接请求 → 被拒绝', () => rejects(() =>
  comm.request({ from: 'performer', to: 'recall', body: 'hi' }), 'RP_TEAM_HANDOFF_REQUIRED'))
await check('延续记录无权唤起理解', () => rejects(() =>
  comm.request({ from: 'keeper', to: 'reading', body: 'x' }), 'RP_TEAM_REQUEST_NOT_ALLOWED'))
await check('后台成员不能反向唤起角色本人', () => rejects(() =>
  comm.request({ from: 'recall', to: 'performer', body: 'x' }), 'RP_TEAM_REQUEST_NOT_ALLOWED'))
await check('结果没走 submit_internal（非 typed）→ 拒绝', async () => {
  const pending = comm.request({ from: 'performer', to: 'reading', handoffId: 'ask-reading', data: { question: 'q', clue: 'c' } })
  pending.catch(() => {})
  const message = comm.allMessages().filter(m => m.type === 'request' && m.to === 'reading').at(-1)
  return rejects(() => comm.completeTarget({ requestId: message.requestId, targetExecutionId: 'x', result: { summary: 's', data: goodReading } }), 'RP_TEAM_HANDOFF_RESULT_REQUIRED')
})
await check('admit 取值越界 → 拒绝', async () => {
  const pending = comm.request({ from: 'performer', to: 'reading', handoffId: 'ask-reading', data: { question: 'q', clue: 'c' } })
  pending.catch(() => {})
  const message = comm.allMessages().filter(m => m.type === 'request' && m.to === 'reading').at(-1)
  return rejects(() => comm.completeTarget({ requestId: message.requestId, targetExecutionId: 'x', result: { summary: 's', data: { ...goodReading, admit: '全盘托出' }, typed: true } }), 'RP_TEAM_HANDOFF_RESPONSE_INVALID')
})

// 6. context sources projected by the real context policy
const history = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i + 1}条` }))
const snapshot = {
  characterId: 'c1', characterName: '示例角色',
  persona: { assistant_name: '示例角色', user_name: '玩家', description: '人设长文', opening: '开场白' },
  history, currentUserInput: '你今天回来得挺晚。',
  settingLibrary: { groups: [], entries: [{ id: 'e1', content: '设定条目' }] }
}
const available = projectAvailableSources(snapshot, { currentInput: snapshot.currentUserInput })
const packets = Object.fromEntries(config.agents.map(agent => [agent.id, buildAgentContext(agent, available, { messages: [] })]))
await check('角色本人：输入 + 最近 12 条 + 整张角色卡 + 设定库', () => {
  const p = packets.performer
  assert.deepEqual(p.categories, ['current_input', 'recent_history', 'character_card', 'worldbook'])
  assert.equal(p.sources.recent_history.length, 12)
  assert.equal(p.sources.recent_history.at(-1).content, '第14条')
  assert.equal(p.sources.character_card.persona.description, '人设长文')
})
await check('延续记录：只有最近 10 条 + 两个名字，看不到本轮输入', () => {
  const p = packets.keeper
  assert.deepEqual(p.categories, ['recent_history', 'character_card'])
  assert.equal(p.sources.recent_history.length, 10)
  assert.deepEqual(p.sources.character_card, { persona: { assistant_name: '示例角色', user_name: '玩家' } })
})
await check('理解：请求 + 输入 + 最近 8 条 + 角色卡 + 设定库', () => {
  const p = packets.reading
  assert.deepEqual(p.categories, ['agent_messages', 'current_input', 'recent_history', 'character_card', 'worldbook'])
  assert.equal(p.sources.recent_history.length, 8)
})
await check('旧事：只有请求 + 角色名（单个 selector 投影为裸字符串）', () => {
  const p = packets.recall
  assert.deepEqual(p.categories, ['agent_messages', 'character_card'])
  assert.equal(p.sources.character_card, '示例角色')
})
await check('卡里没有 user_name 时静默跳过、不报错', () => {
  const noUser = projectAvailableSources({ ...snapshot, persona: { assistant_name: '示例角色' } }, {})
  const missing = missingContextSelections(byId('keeper'), noUser)
  const p = buildAgentContext(byId('keeper'), noUser, {})
  assert.deepEqual(p.sources.character_card, { persona: { assistant_name: '示例角色' } })
  return `missingContextSelections=${JSON.stringify(missing)}`
})

// 7. state permissions vs prompts, single writer per path
const access = Object.fromEntries(config.agents.map(agent => [agent.id, describeStateToolAccess(agent, config.state.definitions)]))
const can = (agentId, path, kind) => access[agentId].some(row => row.namespace === 'shared' && (row.path === path || path.startsWith(`${row.path}/`)) && row[kind])
await check('提示词里提到的每条状态路径都有对应读权限', () => {
  const rows = []
  for (const agent of config.agents) {
    const paths = [...new Set([...agent.systemPrompt.matchAll(/shared (\/[a-z_/]+)/gu)].map(m => m[1]))]
    for (const path of paths) assert.ok(can(agent.id, path, 'read'), `${agent.id} cannot read ${path}`)
    rows.push(`${agent.id}:${paths.length}`)
  }
  return rows.join(' ')
})
await check('写入者唯一且与分工一致', () => {
  const writers = {}
  for (const agent of config.agents) for (const row of access[agent.id]) if (row.write && agent.outputAuthority.state) (writers[row.path] ??= []).push(agent.id)
  assert.deepEqual(writers, {
    '/scene/ledger': ['keeper'], '/style/recent': ['keeper'], '/memory/past': ['keeper'],
    '/scene/understanding': ['reading'], '/memory/recall_log': ['recall']
  })
  assert.ok(!access.performer.some(row => row.write), 'performer writes nothing')
  return Object.entries(writers).map(([p, w]) => `${p}←${w}`).join('，')
})
await check('记忆集合 shared-past：提到它的成员都能读，延续记录能写', () => {
  for (const agent of config.agents.filter(a => a.systemPrompt.includes('"shared-past"'))) assert.ok(can(agent.id, '/memory/past', 'read'), agent.id)
  assert.ok(can('keeper', '/memory/past', 'write'))
  assert.deepEqual(config.memory.collections.map(c => `${c.namespace}${c.path}`), ['shared/memory/past'])
})

// 8. sample values vs valueSchema
const schemaOf = path => config.state.definitions.find(d => d.path === path).valueSchema
const valid = (path, value) => { const issues = validateValueSchema(value, schemaOf(path)); assert.deepEqual(issues, [], `${path} ${JSON.stringify(issues[0])}`) }
await check('典型写入值通过各自 valueSchema', () => {
  valid('/scene/ledger', {
    situation: { where: '合租屋厨房', when: '晚饭前', present: ['角色', '对方'], doing: '一起做面' },
    errands: [{ id: 'e1', what: '做晚饭', progress: '白菜洗好了，水还没开', status: '在办' }],
    limits: [{ id: 'l1', what: '末班车', until: '23:10' }],
    threads: [{ id: 't1', kind: '承诺', content: '对方说今晚煮汤等角色', between: '对方→角色', basis: '对方亲口说', status: '未了' }],
    habits: [{ id: 'h1', cue: '下雨进门', tendency: '先把伞立在门边', seen: 2 }]
  })
  valid('/scene/understanding', [{
    id: 'u1', about: '周六的约', reading: '他家里出事了，不是瞒我', status: '已修正',
    basis: [{ content: '聊天记录', source: '亲眼所见' }], alternatives: [], residue: '有点介意他当时没直说', revised_from: '他有事瞒着'
  }])
  valid('/style/recent', { patterns: [{ shape: '以小动作接一句反问收尾', where: '最近 4 条中 3 条' }] })
  valid('/memory/past', [{ id: 'uuid', content: '一起做过一次很咸的面', createdAt: '2026-11-10T00:00:00.000Z', active: true, people: ['对方'], tags: ['做饭'], source: '亲眼所见', perspective: '角色视角', confidence: 0.8, storyTime: '某个工作日晚上' }])
  valid('/memory/recall_log', [{ memoryId: 'uuid', cue: '咸', count: 1, last: '对方说面咸' }])
})
await check('来源标签写成别的词 → 被 valueSchema 拒绝', () => {
  const issues = validateValueSchema([{ id: 'u', about: 'a', reading: 'r', basis: [{ content: 'c', source: '直觉' }], alternatives: [], residue: '', status: '悬而未决' }], schemaOf('/scene/understanding'))
  assert.ok(issues.length > 0)
})
await check('默认值都满足自己的 valueSchema', () => {
  for (const d of config.state.definitions) assert.deepEqual(validateValueSchema(d.default, d.valueSchema), [], d.path)
})

// 9. scheduling arithmetic
await check('延续记录的 periodic 节奏（与 event-triggers.mjs 同式）', () => {
  const fires = (every, offset) => [1, 2, 3, 4, 5, 6, 7, 8].filter(n => n >= offset && (n - offset) % every === 0)
  const t = byId('keeper').triggers[0]
  assert.deepEqual(fires(t.every, t.offset), [2, 4, 6, 8])
  return `every=2 → 第 ${fires(2, 0).join('/')} 轮；every=3 → 第 ${fires(3, 0).join('/')} 轮`
})
await check('执行上限足够容纳计划内最坏轮', () => {
  const e = config.execution
  // performer 1 + keeper 1 + reading 1 + recall 1 = 4 activations; depth performer(0)→helper(1)
  assert.ok(e.maxActivations >= 4 && e.maxDepth >= 1 && e.concurrency >= 3 && e.maxPerAgent >= 1)
  return JSON.stringify(e)
})

// 10. rendered member policy (what each member actually gets as instructions)
const pending = new Map(config.agents.map(agent => [agent.id, {
  agentId: agent.id, activationNo: 1, agentContext: packets[agent.id], stateToolAccess: access[agent.id]
}]))
const run = { runId: 'dry-run', outputAgentId: 'performer', communication: comm, config }
await check('渲染后的成员指令：交接、状态路径、发布权提示一致', () => {
  const resolved = resolveAuthorParameters(config).config
  const sizes = []
  for (const agent of resolved.agents) {
    const policy = childPolicy(agent, run, 1, pending)
    if (agent.id === 'performer') {
      assert.ok(policy.includes('"id":"ask-reading"') && policy.includes('"id":"ask-recall"'))
      assert.ok(policy.includes('You are the only user-output agent'))
      assert.ok(!policy.includes('Write only these declared paths'))
    } else {
      assert.ok(policy.includes(`you are not that agent`))
      assert.ok(policy.includes('Write only these declared paths'))
    }
    if (agent.id === 'reading' || agent.id === 'recall') assert.ok(policy.includes('Incoming handoffs'))
    sizes.push(`${agent.id} ${policy.length} 字符`)
  }
  return sizes.join('，')
})

// 11. trial scenarios
const ASSERTIONS = new Set(['body_contains', 'body_not_contains', 'single_output', 'state_equals'])
const trialFiles = readdirSync(trialsDir).filter(name => name.endsWith('.rp-trial.json')).sort()
const trials = {}
for (const name of trialFiles) {
  await check(`试演场景 ${name}`, () => {
    const t = JSON.parse(readFileSync(join(trialsDir, name), 'utf8'))
    assert.equal(t.format, 'rp-team-trial-scenario'); assert.equal(t.version, 1)
    assert.ok(t.scenario.name.trim() && t.scenario.name.length <= 120)
    assert.ok(t.scenario.steps.length >= 1 && t.scenario.steps.length <= 100)
    for (const s of t.scenario.steps) {
      assert.ok(typeof s.inputText === 'string' && s.inputText.trim() && s.id)
      assert.ok(s.assertions.every(a => ASSERTIONS.has(a.type) && (a.type !== 'body_not_contains' || a.text)))
    }
    assert.equal(t.scenario.initialState, undefined, 'no initialState: both presets start from the same snapshot')
    trials[name] = t.scenario
    return `${t.scenario.steps.length} 轮`
  })
}
await check('T2a / T2b 关键句与后续句逐字相同', () => {
  const a = trials['situated-life.t2a-late-close.rp-trial.json'].steps, b = trials['situated-life.t2b-late-friction.rp-trial.json'].steps
  assert.equal(a[1].inputText, b[1].inputText); assert.equal(a[2].inputText, b[2].inputText)
  assert.notEqual(a[0].inputText, b[0].inputText)
})

console.log(results.join('\n'))
console.log(`\n${results.length - failures} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
