// Host 半区行为测试（零依赖，node tests/host.test.mjs 直接跑）
// 覆盖：解析语义、30s 缓存、stale 保留旧值、失败分类、钳制、回环防护、无 key。
import { apply } from '../lib/index.js'

let passed = 0
let failed = 0
function assert(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')) }
}

/** 挂载一个干净的插件实例，返回 (remote?) => Promise<json> 请求函数与 fetch 计数器。 */
const realNow = Date.now.bind(Date)
function mount(overrides = {}) {
  let route = null
  const routes = []
  let fetchCount = 0
  let now = Date.now()
  globalThis.Date.now = () => now
  const ctx = {
    settings: { get: () => ({ providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } }) },
    credentials: { resolve: async () => ({ value: 'sk-test-abcdef123456' }) },
    get: () => undefined,
    logger: { warn: () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    effect: (fn) => { fn() },
    ...overrides,
  }
  apply(ctx, { baseUrl: 'https://opencode.ai/zen/go', timeoutMs: 5000 })
  route = routes.find((r) => r.path === '/api/provider-usage/opencode-go')
  if (!route) throw new Error('usage route not registered')
  async function call(remote = '127.0.0.1', stub, method = 'GET', host = '127.0.0.1:3080') {
    if (stub) globalThis.fetch = stub
    let text = null
    const res = { writeHead: (c, h) => { res.code = c }, end: (t) => { text = t } }
    const req = { method, socket: { remoteAddress: remote }, headers: { host } }
    await route.handler(req, res)
    return JSON.parse(text)
  }
  return {
    call,
    getRoute: () => route,
    advance: (ms) => { now += ms },
    getFetchCount: () => fetchCount,
    wrapFetch: (fn) => { return async (...a) => { fetchCount++; return fn(...a) } },
  }
}

const SAMPLE = {
  usage: {
    rolling: { status: 'ok', percent: 9, resetsAt: '2099-01-01T00:00:00.000Z' },
    weekly: { status: 'ok', percent: 12, resetsAt: '2099-01-08T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 13, resetsAt: '2099-02-01T00:00:00.000Z' },
  },
}
const res200 = (body = SAMPLE) => async () => ({ status: 200, ok: true, json: async () => body })
const res500 = () => async () => ({ status: 500, ok: false, json: async () => ({ error: 'boom' }) })

console.log('场景 1：成功解析')
{
  const m = mount()
  const j = await m.call('127.0.0.1', m.wrapFetch(res200()))
  assert(j.ok === true && j.remaining === 87, 'ok + 每月剩余 87%')
  assert(j.planName === 'OpenCode Go' && j.unit === '%', 'planName/unit')
  assert(j.windows.rolling.usedPct === 9 && j.windows.rolling.remainingPct === 91, 'rolling 窗口')
  assert(j.windows.monthly.remainingPct === 87 && j.windows.monthly.resetsAt === '2099-02-01T00:00:00.000Z', 'monthly 窗口')
  assert(/5小时: 91%/.test(j.extra) && /7天: 88%/.test(j.extra) && /◷/.test(j.extra), 'extra 文案')
  assert(j.error === null && j.stale === false && j.cached === false, '无错误标记')
  assert(j.credential && j.credential.source === 'credential:OPENCODE_GO_API_KEY', '凭证来源')
  assert(j.credential.keyHint === 'sk-t…3456', 'key 掩码')
}

console.log('场景 2：30s 缓存复用')
{
  const m = mount()
  const j1 = await m.call('127.0.0.1', m.wrapFetch(res200()))
  const j2 = await m.call('127.0.0.1') // 不 stub，若真的发起请求会 500/网络错
  assert(j1.ok === true && j2.ok === true, '两次都成功')
  assert(j2.cached === true, '第二次 cached:true')
  assert(m.getFetchCount() === 1, 'fetch 只发生 1 次')
}

console.log('场景 3：瞬时网络失败保留旧值（stale）')
{
  const m = mount()
  await m.call('127.0.0.1', m.wrapFetch(res200()))
  m.advance(31000) // 越过 30s 缓存窗口
  const j3 = await m.call('127.0.0.1', m.wrapFetch(async () => { throw new Error('ECONNRESET') }))
  assert(j3.ok === false && j3.stale === true, '失败 + stale 标记')
  assert(j3.error && j3.error.type === 'network', '错误类型 network')
  assert(j3.windows && j3.windows.monthly.remainingPct === 87, '保留上次成功的 windows')
  assert(j3.cached === true, '旧值标记 cached')
}

console.log('场景 4：确定性 HTTP 失败保留旧值')
{
  const m = mount()
  await m.call('127.0.0.1', m.wrapFetch(res200()))
  m.advance(31000)
  const j = await m.call('127.0.0.1', m.wrapFetch(res500()))
  assert(j.ok === false && j.stale === true, 'stale')
  assert(j.error.type === 'http' && j.error.httpStatus === 500, 'http/500')
  assert(j.windows !== null, '保留旧值')
}

console.log('场景 5：无 key')
{
  const m = mount({ credentials: { resolve: async () => null } })
  const j = await m.call('127.0.0.1')
  assert(j.ok === false && j.error.type === 'no-api-key', 'no-api-key')
  assert(j.stale === false && j.windows === null, '无旧值')
}

console.log('场景 6：坏 JSON / 无 usage 数据')
{
  const m = mount()
  const j1 = await m.call('127.0.0.1', m.wrapFetch(() => ({ status: 200, ok: true, json: async () => { throw new Error('bad json') } })))
  assert(j1.ok === false && j1.error.type === 'parse', 'bad-json → parse')
  const j2 = await m.call('127.0.0.1', m.wrapFetch(res200({ hello: 1 })))
  assert(j2.ok === false && j2.error.type === 'parse', 'no usage → parse')
}

console.log('场景 7：百分比钳制与 rate-limited')
{
  const m = mount()
  const weird = { usage: { rolling: { status: 'rate-limited', percent: 150 }, weekly: { percent: -5 }, monthly: { percent: 13.7 } } }
  const j = await m.call('127.0.0.1', m.wrapFetch(res200(weird)))
  assert(j.windows.rolling.usedPct === 100, '>100 钳到 100')
  assert(j.windows.rolling.status === 'rate-limited', 'rate-limited 状态保留')
  assert(j.windows.weekly.usedPct === 0, '<0 钳到 0')
  assert(j.windows.monthly.remainingPct === 86.3, '小数保留')
}

console.log('场景 8：回环防护')
{
  const m = mount()
  const denied = await m.call('192.168.1.10')
  assert(denied.error === 'forbidden: loopback-only', '外网地址 403')
  const deniedHost = await m.call('127.0.0.1', undefined, 'GET', 'evil.com')
  assert(deniedHost.error === 'forbidden: loopback-only', 'Host 头伪造拒绝')
  const ok = await m.call('::1')
  assert(typeof ok.ok === 'boolean', '::1 放行')
}

console.log('场景 9：POST 拒绝 405')
{
  const m = mount()
  const denied = await m.call('127.0.0.1', undefined, 'POST')
  assert(denied.error === 'method not allowed', 'POST → 405')
}

if (failed > 0) { console.error('\nFAILED: ' + failed + ' 项'); process.exit(1) }
console.log('\nPASSED: ' + passed + ' 项全部通过')
