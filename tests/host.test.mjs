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
  apply(ctx, { baseUrl: 'https://opencode.ai/zen/go', timeoutMs: 5000, ...(overrides.rawConfig || {}) })
  route = routes.find((r) => r.path === '/api/provider-usage/opencode-go')
  if (!route) throw new Error('usage route not registered')
  async function call(remote = '127.0.0.1', stub, method = 'GET', host = '127.0.0.1:3080', url = null, rawBody = null) {
    if (stub) globalThis.fetch = stub
    let text = null
    const res = { writeHead: (c, h) => { res.code = c }, end: (t) => { text = t } }
    const req = { method, socket: { remoteAddress: remote }, headers: { host }, url }
    if (rawBody !== null) {
      // 极简可读流 mock：data 同步发完整 body，end 异步触发（readBodyJson 先收 data 再收 end）
      req.headers['content-type'] = 'application/json'
      req.on = (ev, cb) => {
        if (ev === 'data') cb(rawBody)
        else if (ev === 'end') setTimeout(cb, 0)
        else if (ev === 'error') { /* ignore */ }
      }
    }
    const path = url ? url.split('?')[0] : '/api/provider-usage/opencode-go'
    const target = routes.find((r) => r.path === path) || route
    await target.handler(req, res)
    return JSON.parse(text)
  }
  return {
    call,
    getRoute: () => route,
    getRoutes: () => routes,
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
  // 回归（审查 #2）：UA 版本号来自 package.json，不再硬编码（此前残留 0.5.0）
  let ua = null
  globalThis.fetch = async (input, init) => {
    ua = ((init && init.headers) || {})['user-agent'] || null
    return { status: 200, ok: true, json: async () => SAMPLE }
  }
  await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=usage-percent&ref=OPENCODE_GO_API_KEY&noCache=1')
  globalThis.fetch = m.wrapFetch(res200())
  const pkgVersion = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  assert(ua === 'dsh-provider-usage/' + pkgVersion, 'user-agent 版本 = package.json 版本（' + pkgVersion + '）')
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

const DS_BALANCE = {
  is_available: false,
  balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }],
}

console.log('场景 10：templates 清单')
{
  const m = mount()
  const j = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/templates')
  assert(j.ok === true && Array.isArray(j.items) && j.items.length === 3, '3 个预设')
  assert(j.items[0].id === 'usage-percent' && j.items[1].id === 'balance-json' && j.items[2].id === 'commandcode-credits', '适配器 id 与顺序')
  assert(j.items[0].credentialRef === undefined && j.items[1].credentialRef === undefined && j.items[2].credentialRef === undefined, '不含凭证引用')
}

console.log('场景 11：query 新路由与旧路由一致 + 命中缓存')
{
  const m = mount()
  const jOld = await m.call('127.0.0.1', m.wrapFetch(res200()))
  const jNew = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/query?provider=opencode-go')
  assert(jOld.remaining === 87 && jNew.remaining === 87, '结果一致')
  assert(jNew.cached === true && m.getFetchCount() === 1, '新路由命中同一缓存')
  assert(jNew.providerId === 'usage-percent' && jNew.displayName === 'OpenCode Go（订阅额度）', 'adapter/displayName 字段')
  assert(jNew.config.baseUrl === 'https://opencode.ai/zen/go/v1/usage', 'config 带完整 URL')
}

console.log('场景 12：DeepSeek 余额成功（0 元 + is_available=false）')
{
  const m = mount()
  let lastUrl = null
  const dsStub = m.wrapFetch(async (input) => { lastUrl = String(input); return { status: 200, ok: true, json: async () => DS_BALANCE } })
  const j = await m.call('127.0.0.1', dsStub, 'GET', '127.0.0.1:3080', '/api/provider-usage/query?provider=deepseek-balance')
  assert(lastUrl === 'https://api.deepseek.com/user/balance', 'deepseek URL 不受 opencode baseUrl 覆盖污染')
  assert(j.ok === true && j.remaining === 0 && j.unit === 'CNY', '余额 0 CNY')
  assert(j.planName === 'DeepSeek 余额', 'planName')
  assert(j.isValid === false && j.invalidMessage && j.invalidMessage.includes('余额不足'), 'is_available=false → 失效提示')
  assert(j.cards && j.cards.length === 1 && j.cards[0].currency === 'CNY' && j.cards[0].granted === 0, 'cards 明细')
  assert(/0.00/.test(j.extra) && /账户不可用/.test(j.extra), 'extra 文案')
  assert(j.credential.source === 'credential:DEEPSEEK_API_KEY', 'deepseek 凭证来源')
  assert(j.error === null && j.stale === false, '无错误标记')
}

console.log('场景 13：DeepSeek 401 → unauthorized')
{
  const m = mount()
  const j = await m.call('127.0.0.1', m.wrapFetch(() => ({ status: 401, ok: false, json: async () => ({}) })), 'GET', '127.0.0.1:3080', '/api/provider-usage/query?provider=deepseek-balance')
  assert(j.ok === false && j.error.type === 'unauthorized' && j.error.httpStatus === 401, '401 → unauthorized')
}

console.log('场景 14：per-provider 缓存隔离')
{
  const m = mount()
  const jGo = await m.call('127.0.0.1', m.wrapFetch(res200()))
  const jDs = await m.call('127.0.0.1', m.wrapFetch(res200(DS_BALANCE)), 'GET', '127.0.0.1:3080', '/api/provider-usage/query?provider=deepseek-balance')
  assert(jGo.ok === true && jDs.ok === true, '两供应商都成功')
  assert(jDs.cached === false, 'deepseek 不命中 go 的缓存')
  assert(m.getFetchCount() === 2, '各自独立 fetch')
  const jGo2 = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/query?provider=opencode-go')
  assert(jGo2.cached === true, 'go 命中自身缓存')
}

console.log('场景 15：未知 provider → 404 类型化错误')
{
  const m = mount()
  const j = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/query?provider=nope')
  assert(j.ok === false && j.error.type === 'unknown-provider' && j.error.httpStatus === 404, 'unknown-provider/404')
}

console.log('场景 16：adapter+ref 直传（客户端多实例路径）')
{
  const m = mount()
  // adapter=usage-percent，自定义 ref=MY_CUSTOM_REF → credentials.resolve 收到该引用
  const j1 = await m.call('127.0.0.1', m.wrapFetch(res200()), 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=usage-percent&ref=MY_CUSTOM_REF')
  assert(j1.ok === true && j1.remaining === 87, 'adapter=usage-percent 查询成功')
  assert(j1.credential.source === 'credential:OPENCODE_GO_API_KEY', 'DSH provider 设置优先于自定义 ref（凭证链）')
  // adapter=balance-json + 默认/自定义 ref
  const j2 = await m.call('127.0.0.1', m.wrapFetch(res200(DS_BALANCE)), 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=balance-json&ref=MY_DS_REF')
  assert(j2.ok === true && j2.remaining === 0 && j2.unit === 'CNY', 'adapter=balance-json 查询成功')
  assert(j2.credential.source === 'credential:MY_DS_REF', '余额实例自定义 ref')
  // 未知 adapter
  const j3 = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=nope')
  assert(j3.ok === false && j3.error.type === 'unknown-provider' && j3.error.httpStatus === 404, '未知 adapter → 404')
}

console.log('场景 17：credential-refs 状态检查')
{
  // fallback 路径（无 describe → resolve 判定）
  const m = mount()
  const j = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/credential-refs?refs=OPENCODE_GO_API_KEY,BAD%20REF')
  assert(j.ok === true && j.refs.length === 1, '非法引用被过滤（BAD REF 跳过）')
  assert(j.refs[0].name === 'OPENCODE_GO_API_KEY' && j.refs[0].configured === true, 'resolve fallback 判定已配置')
}
{
  // describe 路径：源存在 → configured；空 → 未配置
  const m = mount({
    credentials: {
      resolve: async () => ({ value: 'x' }),
      describe: async (name) => (name === 'OK_REF' ? { source: 'stored' } : {}),
    },
  })
  const j = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/credential-refs?refs=OK_REF,MISSING_REF')
  assert(j.refs[0].configured === true && j.refs[1].configured === false, 'describe 区分已配置/未配置')
}

console.log('场景 18：同 adapter 不同 ref 缓存隔离')
{
  const m = mount()
  // 实例 A：usage-percent + REF_A
  const jA1 = await m.call('127.0.0.1', m.wrapFetch(res200()), 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=usage-percent&ref=REF_A')
  assert(jA1.ok === true && jA1.cached === false, 'A 首次查询')
  // 实例 B：usage-percent + REF_B → 不得命中 A 的缓存
  const jB = await m.call('127.0.0.1', m.wrapFetch(res200({ usage: { rolling: { percent: 1 }, weekly: { percent: 2 }, monthly: { percent: 3 } } })), 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=usage-percent&ref=REF_B')
  assert(jB.ok === true && jB.cached === false && jB.remaining === 97, 'B 独立查询（未串 A 缓存）')
  assert(m.getFetchCount() === 2, '两次独立 fetch')
  // 实例 A 再次请求 → 命中自己的缓存
  const jA2 = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=usage-percent&ref=REF_A')
  assert(jA2.cached === true && jA2.remaining === 87, 'A 命中自身缓存')
}

console.log('场景 19：私有加密库（方案 B）参与解析')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-dsh-'))
  process.env.DSH_HOME = tmp
  try {
    const { createSecureStore } = await import('../lib/secure-store.js')
    const priv = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await priv.init()
    // 私有库持有该 ref（DSH 凭证链全部为空 → 走私有兜底）
    await priv.set('OPENCODE_GO_API_KEY', 'sk-private-123456')
    const m = mount({
      settings: { get: () => ({ providers: {} }) },
      credentials: { resolve: async () => null },
    })
    const j = await m.call('127.0.0.1', m.wrapFetch(res200()))
    assert(j.ok === true && j.credential.source === 'provider-usage:OPENCODE_GO_API_KEY', '私有库兜底解析')
    assert(j.credential.keyHint === 'sk-p…3456', '掩码展示')
    const r = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/credential-refs?refs=OPENCODE_GO_API_KEY')
    assert(r.refs[0].configured === true, '状态点识别私有 ref')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

console.log('场景 20：dsh-providers 可导入清单')
{
  const m = mount()
  const j = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/dsh-providers')
  assert(j.ok === true && j.items.length === 2, '两项（OpenCode Go + DeepSeek）')
  assert(j.items[0].route === 'opencode-go' && j.items[0].adapter === 'usage-percent', 'opencode-go 适配')
  assert(j.items[0].ref === 'OPENCODE_GO_API_KEY', 'ref 来自 DSH provider 设置（apiKeyEnv）')
  assert(j.items[1].route === 'deepseek-official' && j.items[1].adapter === 'balance-json' && j.items[1].ref === 'DEEPSEEK_API_KEY', 'deepseek 适配（内置路由默认 ref）')
  assert(j.items[0].configured === true && j.items[1].configured === true, 'mock 凭证均判定已配置')
  assert(j.items.every((x) => x.adapter !== 'commandcode-credits'), 'Command Code 不在 DSH 导入清单（仅自定义）')
}

// ── Command Code（v0.6.0）：订阅+余额混合卡 ──
const CC_CREDITS = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 62.9432148907,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.3699430743, cap: 14, exceeded: false, resetAt: 1788114535553 },
    weekly: { used: 7.0567851093, cap: 35, exceeded: false, resetAt: 1788405909707 },
  },
}
const CC_SUB = {
  success: true,
  data: {
    id: 'sub_1U8tmpDSZgxV3MJKLaKrcqJ7',
    status: 'active',
    planId: 'individual-goat',
    currentPeriodStart: '2026-08-27T03:14:04.000Z',
    currentPeriodEnd: '2026-09-27T03:14:04.000Z',
    cancelAtPeriodEnd: false,
  },
}
function ccStub(credits = CC_CREDITS, sub = CC_SUB, subStatus = 200) {
  return async (input) => {
    const url = String(input)
    if (url.includes('/alpha/billing/credits')) {
      return { status: 200, ok: true, json: async () => credits }
    }
    if (url.includes('/alpha/billing/subscriptions')) {
      if (subStatus !== 200) return { status: subStatus, ok: false, json: async () => ({}) }
      return { status: 200, ok: true, json: async () => sub }
    }
    return { status: 404, ok: false, json: async () => ({}) }
  }
}
const CC_QS = '/api/provider-usage/query?adapter=commandcode-credits&ref=CC_KEY&source=vault'

console.log('场景 20b：Command Code 双端点成功 → 订阅使用量 + 剩余额度')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-cc-'))
  process.env.DSH_HOME = tmp
  try {
    const { createSecureStore } = await import('../lib/secure-store.js')
    const priv = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await priv.init()
    await priv.set('CC_KEY', 'sk-cc-vault-12345678')
    const m = mount({
      settings: { get: () => ({ providers: {} }) },
      credentials: { resolve: async () => null },
    })
    const j = await m.call('127.0.0.1', m.wrapFetch(ccStub()), 'GET', '127.0.0.1:3080', CC_QS)
    assert(j.ok === true && j.planName === 'Command Code（GOAT）', 'planName 来自 planId')
    assert(j.remaining === 62.9432148907 && j.unit === 'USD', '月度剩余 USD')
    assert(Math.abs(j.used - 7.0567851093) < 1e-9, '月已用 = 70 − 62.9432')
    assert(j.totalQuota === 70, 'totalQuota 来自计划映射')
    assert(j.nextResetAt === '2026-09-27T03:14:04.000Z', '月重置 = currentPeriodEnd')
    assert(j.monthly && Math.abs(j.monthly.usedPct - 10.0811) < 1e-3, '月已用百分比 (70−62.94)/70')
    // v0.7.0：月剩余百分比 = 剩余/总额，3 位小数向下取整（62.9432148907/70 = 89.91887…% → 89.918）
    assert(j.monthly.remainingPct === 89.918, '月剩余百分比 3 位小数向下取整')
    assert(j.windows.fiveHour.usedPct !== null && j.windows.weekly.usedPct !== null, '5h/周窗口')
    assert(j.windows.fiveHour.usedPct > 0 && j.windows.fiveHour.usedPct < 3, '5h 百分比 ~2.6%')
    assert(j.windows.weekly.usedPct > 20 && j.windows.weekly.usedPct < 21, '周百分比 ~20.2%')
    // 回归（审查 #1）：窗口重置字段必须叫 resetsAt（client WindowRow 统一读该名），
    // 此前 host 返回 resetAt → 卡片倒计时恒空白。1788114535553 → 2026-08-30T18:28:55.553Z
    assert(j.windows.fiveHour.resetsAt === '2026-08-30T18:28:55.553Z', '5h 重置字段名 resetsAt')
    assert(j.windows.weekly.resetsAt === '2026-09-03T03:25:09.707Z', '周重置字段名 resetsAt')
    assert(j.monthly.resetsAt === '2026-09-27T03:14:04.000Z', '月窗口重置 resetsAt = currentPeriodEnd')
    assert(j.credential.source === 'provider-usage:CC_KEY', 'vault 直取私有库 Key')
    assert(/月已用 7.06/.test(j.extra) && /月剩余 62.94/.test(j.extra), 'extra 文案')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

console.log('场景 20c：Command Code 订阅端点失败 → 降级（窗口+剩余仍在，无计划名/月% ）')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-ccsub-'))
  process.env.DSH_HOME = tmp
  try {
    const { createSecureStore } = await import('../lib/secure-store.js')
    const priv = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await priv.init()
    await priv.set('CC_KEY', 'sk-cc-vault-12345678')
    const m = mount({
      settings: { get: () => ({ providers: {} }) },
      credentials: { resolve: async () => null },
    })
    const j = await m.call('127.0.0.1', m.wrapFetch(ccStub(CC_CREDITS, null, 500)), 'GET', '127.0.0.1:3080', CC_QS)
    assert(j.ok === true && j.error === null, '订阅端点失败不致命')
    assert(j.planName === 'Command Code', '降级为通用名')
    assert(j.totalQuota === null && j.monthly.usedPct === null && j.monthly.remainingPct === null, '无计划 → 月% 降级 null')
    assert(j.remaining === 62.9432148907 && j.windows.fiveHour.usedPct !== null, '剩余与窗口仍在')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

console.log('场景 20d：Command Code 未知 planId → 降级不崩')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-ccunk-'))
  process.env.DSH_HOME = tmp
  try {
    const { createSecureStore } = await import('../lib/secure-store.js')
    const priv = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await priv.init()
    await priv.set('CC_KEY', 'sk-cc-vault-12345678')
    const m = mount({
      settings: { get: () => ({ providers: {} }) },
      credentials: { resolve: async () => null },
    })
    const sub = Object.assign({}, CC_SUB, { data: Object.assign({}, CC_SUB.data, { planId: 'individual-future-plan' }) })
    const j = await m.call('127.0.0.1', m.wrapFetch(ccStub(CC_CREDITS, sub)), 'GET', '127.0.0.1:3080', CC_QS)
    assert(j.ok === true, '未知计划不崩溃')
    assert(j.totalQuota === null && j.monthly.usedPct === null && j.monthly.remainingPct === null, '未知计划 → 月% null')
    assert(j.planName === 'Command Code', '未知计划通用名')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

console.log('场景 20e：Command Code credits 401 → unauthorized')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-cc401-'))
  process.env.DSH_HOME = tmp
  try {
    const { createSecureStore } = await import('../lib/secure-store.js')
    const priv = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await priv.init()
    await priv.set('CC_KEY', 'sk-cc-vault-12345678')
    const m = mount({
      settings: { get: () => ({ providers: {} }) },
      credentials: { resolve: async () => null },
    })
    const stub = async (input) => {
      const url = String(input)
      if (url.includes('/alpha/billing/credits')) return { status: 401, ok: false, json: async () => ({}) }
      return { status: 200, ok: true, json: async () => CC_SUB }
    }
    const j = await m.call('127.0.0.1', m.wrapFetch(stub), 'GET', '127.0.0.1:3080', CC_QS)
    assert(j.ok === false && j.error.type === 'unauthorized' && j.error.httpStatus === 401, '401 → unauthorized')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

console.log('场景 20f：Command Code 订阅端点挂起 → 短超时 abort，不拖累整体响应')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-ccslow-'))
  process.env.DSH_HOME = tmp
  try {
    const { createSecureStore } = await import('../lib/secure-store.js')
    const priv = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await priv.init()
    await priv.set('CC_KEY', 'sk-cc-vault-12345678')
    const m = mount({
      settings: { get: () => ({ providers: {} }) },
      credentials: { resolve: async () => null },
      rawConfig: { timeoutMs: 10000, subscriptionTimeoutMs: 200 },
    })
    // subscriptions 永不响应（真实 fetch 行为：abort 触发时以 AbortError reject）
    const hangSub = async (input, init) => {
      const url = String(input)
      if (url.includes('/alpha/billing/subscriptions')) {
        return new Promise((resolve, reject) => {
          const signal = init && init.signal
          const abortErr = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
          if (signal) {
            if (signal.aborted) { abortErr(); return }
            signal.addEventListener('abort', abortErr)
          }
        })
      }
      if (url.includes('/alpha/billing/credits')) return { status: 200, ok: true, json: async () => CC_CREDITS }
      return { status: 404, ok: false, json: async () => ({}) }
    }
    const t0 = performance.now()
    const j = await m.call('127.0.0.1', m.wrapFetch(hangSub), 'GET', '127.0.0.1:3080', CC_QS)
    const elapsed = performance.now() - t0
    assert(j.ok === true && j.error === null, '订阅端点挂起不致命（降级成功）')
    assert(j.totalQuota === null && j.planName === 'Command Code', '降级：无计划名/月%')
    assert(elapsed < 2000, '整体在订阅短超时后返回（' + Math.round(elapsed) + 'ms < 2000ms，未等全局 10s）')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

console.log('场景 20g：Command Code 月剩余百分比边界（向下取整 / 满 / 空 / 超额钳 0）')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-ccpct-'))
  process.env.DSH_HOME = tmp
  try {
    const { createSecureStore } = await import('../lib/secure-store.js')
    const priv = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await priv.init()
    await priv.set('CC_KEY', 'sk-cc-vault-12345678')
    const creditsWith = (monthlyCredits) =>
      Object.assign({}, CC_CREDITS, { credits: Object.assign({}, CC_CREDITS.credits, { monthlyCredits }) })
    // 每个子场景独立 mount：绕开 30s 查询缓存（同 ref 连续查询会命中缓存返回首个结果）
    const query = async (monthlyCredits) => {
      const m = mount({
        settings: { get: () => ({ providers: {} }) },
        credentials: { resolve: async () => null },
      })
      return m.call('127.0.0.1', m.wrapFetch(ccStub(creditsWith(monthlyCredits))), 'GET', '127.0.0.1:3080', CC_QS)
    }
    // GOAT 计划总额 70；1/70 = 1.428571…% → floor(1428.571)/1000 = 1.428
    const j1 = await query(1)
    assert(j1.monthly.remainingPct === 1.428, '1/70 → 1.428（向下取整，非四舍五入 1.429）')
    assert(j1.monthly.usedPct !== null && j1.monthly.usedPct > 98.5 && j1.monthly.usedPct < 98.6, 'usedPct 仍为已用口径')
    // 69.999/70 = 99.99857…% → 99.998
    const j2 = await query(69.999)
    assert(j2.monthly.remainingPct === 99.998, '69.999/70 → 99.998')
    // 刚好用完：0/70 → 0（钳下界）
    const j3 = await query(0)
    assert(j3.monthly.remainingPct === 0, '剩余 0 → 0%')
    // 满额未用：70/70 → 100
    const j4 = await query(70)
    assert(j4.monthly.remainingPct === 100, '满额 → 100%')
    // 超额（剩余为负，超额使用）→ 钳上界 0，不出负百分比
    const j5 = await query(-5)
    assert(j5.monthly.remainingPct === 0, '超额（剩余负）→ 钳 0')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

console.log('场景 21：source=vault 直取私有库（同名不与 DSH 冲突）')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-vault-'))
  process.env.DSH_HOME = tmp
  try {
    const { createSecureStore } = await import('../lib/secure-store.js')
    const priv = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await priv.init()
    // 私有库与 DSH 凭证【同名】持有不同值（sk-vault-… vs sk-test-…）
    await priv.set('OPENCODE_GO_API_KEY', 'sk-vault-value-12345678')
    const m = mount()
    // 旧链（无 source）：DSH 凭证优先
    const j1 = await m.call('127.0.0.1', m.wrapFetch(res200()))
    assert(j1.ok === true && j1.credential.source === 'credential:OPENCODE_GO_API_KEY' && j1.credential.keyHint === 'sk-t…3456', '旧链走 DSH 凭证')
    // vault 直取：同名但用私有库的值
    const j2 = await m.call('127.0.0.1', m.wrapFetch(res200()), 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=usage-percent&ref=OPENCODE_GO_API_KEY&source=vault')
    assert(j2.ok === true && j2.credential.source === 'provider-usage:OPENCODE_GO_API_KEY' && j2.credential.keyHint === 'sk-v…5678', 'vault 直取私有库（同名不冲突）')
    // vault 键缺失 → no-api-key
    const j3 = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=usage-percent&ref=NOPE&source=vault')
    assert(j3.ok === false && j3.error.type === 'no-api-key', 'vault 缺失 → no-api-key')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

console.log('场景 22：POST /credentials 接受含连字符的私有库键（实例 id 风格）')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-post-'))
  process.env.DSH_HOME = tmp
  try {
    const m = mount()
    const route = m.getRoutes().find((r) => r.path === '/api/provider-usage/credentials')
    if (!route) throw new Error('credentials route missing')
    function post(reqUrl, body) {
      const listeners = {}
      const req = {
        method: 'POST', url: reqUrl, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
        on: (ev, fn) => { listeners[ev] = fn },
      }
      const raw = JSON.stringify(body)
      queueMicrotask(() => { if (listeners.data) listeners.data(Buffer.from(raw)); if (listeners.end) listeners.end() })
      let text = null
      const res = { writeHead: (c, h) => { res.code = c }, end: (t) => { text = t } }
      return route.handler(req, res).then(() => ({ code: res.code, json: JSON.parse(text) }))
    }
    // 实例 id 风格键（含连字符）→ 应成功
    const ok = await post('/api/provider-usage/credentials', { ref: 'usage-percent-1752999999999', value: 'sk-hyphen-key-ok' })
    assert(ok.code === 200 && ok.json.ok === true && ok.json.ref === 'usage-percent-1752999999999', '连字符键写入成功')
    // 非法字符 → 400
    const bad = await post('/api/provider-usage/credentials', { ref: 'bad key!', value: 'x' })
    assert(bad.code === 400 && bad.json.error.type === 'bad-ref', '非法字符拒绝')
    // 写入后可解密取回（vault 直取链路）
    const { createSecureStore } = await import('../lib/secure-store.js')
    const store = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await store.init()
    assert((await store.get('usage-percent-1752999999999')) === 'sk-hyphen-key-ok', '解密取回一致')
    // 状态点判定：含连字符的私有库键应识别为已配置（不再被 DSH 引用名规则过滤）
    const cr = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/credential-refs?refs=usage-percent-1752999999999')
    assert(cr.refs.length === 1 && cr.refs[0].configured === true, 'vault 键状态点已配置')
    assert(cr.refs[0].store === 'both', 'mock DSH 凭证 + 私有库 → store=both')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

console.log('场景 23：noCache=1 绕过 30s 新鲜窗口与并发去重（改 Key 后强制刷新）')
{
  const m = mount()
  const j1 = await m.call('127.0.0.1', m.wrapFetch(res200()))
  assert(j1.ok === true && j1.cached === false, '首次查询')
  // 30s 窗口内 noCache → 必须重新发起请求（不走缓存）
  const j2 = await m.call('127.0.0.1', m.wrapFetch(res200()), 'GET', '127.0.0.1:3080', '/api/provider-usage/query?adapter=usage-percent&noCache=1')
  assert(j2.ok === true && j2.cached === false, 'noCache 重新发起（不走缓存）')
  assert(m.getFetchCount() === 2, 'fetch 发生 2 次')
  // 不带 noCache 仍命中缓存
  const j3 = await m.call('127.0.0.1', undefined)
  assert(j3.cached === true, '普通请求仍命中缓存')
  assert(m.getFetchCount() === 2, 'fetch 仍只有 2 次')
}

console.log('场景 24：credential-refs 返回 store（dsh/vault/both/none，供旧数据自愈）')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-store-'))
  process.env.DSH_HOME = tmp
  try {
    const { createSecureStore } = await import('../lib/secure-store.js')
    const priv = createSecureStore(pathMod.join(tmp, 'provider-usage'))
    await priv.init()
    await priv.set('VAULT_ONLY_REF', 'sk-vault-123456')
    const m = mount({
      credentials: {
        resolve: async () => null,
        describe: async (name) => (name === 'DSH_ONLY_REF' ? { source: 'stored' } : {}),
      },
    })
    const j = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/credential-refs?refs=DSH_ONLY_REF,VAULT_ONLY_REF,NEITHER')
    const by = (n) => j.refs.find((x) => x.name === n)
    assert(by('DSH_ONLY_REF').store === 'dsh' && by('DSH_ONLY_REF').configured === true, 'DSH-only → store=dsh')
    assert(by('VAULT_ONLY_REF').store === 'vault' && by('VAULT_ONLY_REF').configured === true, 'vault-only → store=vault')
    assert(by('NEITHER').store === null && by('NEITHER').configured === false, '都没有 → store=null')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}


// ── 本地 Token 统计（v0.5.0）：DSH 会话日志折叠 ──
function asstMsg(provider, model, usage, time, turn, step) {
  return { type: "assistant/message", time, data: { turn, step, usage, message: provider ? { source: { provider, model } } : {} } }
}
function chunkUsage(usage, time) {
  return { type: "assistant/chunk", time, data: { turn: 1, step: 1, chunk: { type: "usage", usage } } }
}
function headerEvt(provider, model, time) {
  return { type: "request/header", time, data: { header: { config: { provider, model } } } }
}
function titleEvt(title) {
  return { type: "session/title", time: 1, data: { title } }
}
function mkSessions(list) {
  const byId = new Map(list.map((s) => [s.id, s]))
  return {
    listSessions: async () => list.map((s) => ({ header: { id: s.id, createdAt: s.createdAt, cwd: s.cwd, agentPreset: s.agentPreset } })),
    readSession: async (id) => { const s = byId.get(id); return s ? { session: { createdAt: s.createdAt }, events: s.events } : { session: null, events: [] } },
  }
}

// ── 本地 Token 统计 v2：按天物化（自读会话文件 + 天文件封存）──
// 每个场景独立临时 DSH_HOME + sessionsDir；解码器注入 identity（测试文件存明文 JSONL）。
const osMod = await import("node:os")
const fsxMod = await import("node:fs/promises")
const pathMod = await import("node:path")
const { _setDecoderForTests } = await import("../lib/daily-stats.js")
_setDecoderForTests((b) => Buffer.from(b))
const T_DAY = new Date(2026, 7, 25, 10, 0, 0).getTime() // 2026-08-25 10:00
async function localEnv() {
  const home = await fsxMod.mkdtemp(pathMod.join(osMod.tmpdir(), "pu-daily-"))
  const sessions = pathMod.join(home, "sessions", "proj")
  await fsxMod.mkdir(sessions, { recursive: true })
  process.env.DSH_HOME = home
  return { home, sessions }
}
async function writeSession(sessions, id, events, mtimeMs) {
  const dir = pathMod.join(sessions, id)
  await fsxMod.mkdir(dir, { recursive: true })
  const file = pathMod.join(dir, "session.jsonl.zstd")
  await fsxMod.writeFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  await fsxMod.utimes(file, new Date(mtimeMs), new Date(mtimeMs))
}
function msg(provider, model, usage, time) {
  return { type: "assistant/message", time, data: { turn: 1, step: 1, usage, message: { source: { provider, model } } } }
}
function hdr(provider, model) {
  return { type: "request/header", time: 0, data: { header: { config: { provider, model } } } }
}
function chunk(usage, time) {
  return { type: "assistant/chunk", time, data: { turn: 1, step: 1, chunk: { type: "usage", usage } } }
}

console.log('场景 25：本地统计找不到会话目录 → no-sessions')
{
  const os2 = await import("node:os")
  const fsx2 = await import("node:fs/promises")
  const path2 = await import("node:path")
  const home = await fsx2.mkdtemp(path2.join(os2.tmpdir(), "pu-nosess-"))
  process.env.DSH_HOME = home
  const m = mount({ rawConfig: { sessionsDir: path2.join(home, "does-not-exist") } })
  const j = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j.ok === false && j.error.type === 'no-sessions', 'no-sessions 类型化错误')
}

console.log('场景 26：今天聚合（只扫今天变过的文件）→ totals/byModel/providers/days')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  await writeSession(env.sessions, "s1", [
    msg("opencode-go", "m1", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 }, T_DAY + 1000),
    msg("opencode-go", "m1", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 }, T_DAY + 2000),
  ], T_DAY + 5000)
  const j = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j.ok === true && j.detected === true && j.days === 1, "ok/detected/days=1")
  assert(j.totals.requests === 2 && j.totals.inputTokens === 200 && j.totals.outputTokens === 100 && j.totals.cacheReadTokens === 400, "累计 2 条消息")
  assert(j.totals.realTotalTokens === 700 && Math.abs(j.totals.cacheHitRate - 400 / 600) < 1e-9, "realTotal/命中率")
  assert(JSON.stringify(j.providers) === JSON.stringify(["opencode-go"]) && j.byModel["opencode-go"].m1.requests === 2, "providers/byModel（v0.7.0 按提供方嵌套）")
  const file = pathMod.join(env.home, "provider-usage", "daily-stats", "2026-08-25.json")
  const stored = JSON.parse(await fsxMod.readFile(file, "utf8"))
  assert(stored.byProvider["opencode-go"].requests === 2 && stored.date === "2026-08-25", "天文件已落盘（全量）")
}

console.log('场景 27：provider 过滤')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  await writeSession(env.sessions, "s1", [
    msg("opencode-go", "a", { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 }, T_DAY + 1000),
    msg("opencode-go", "a", { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 }, T_DAY + 2000),
    msg("opencode", "b", { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0 }, T_DAY + 3000),
  ], T_DAY + 5000)
  const go = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=opencode-go")
  assert(go.totals.requests === 2 && go.totals.inputTokens === 20, "opencode-go 只算自己的")
  assert(go.byModel["opencode-go"].a.requests === 2 && !go.byModel.opencode && !go.byModel.b, "选中提供方：模型汇总恒嵌套且只见自己的模型（v0.7.0）")
  const all = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(all.totals.requests === 3, "全部 provider requests=3")
  assert(all.providers.length === 2 && all.byModel.opencode.b.requests === 1 && all.byModel["opencode-go"].a.requests === 2, "providers 枚举/byModel 嵌套全量")
}

console.log('场景 28：归属回退 request/header + chunk 不双计')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  await writeSession(env.sessions, "s1", [
    hdr("opencode-go", "fm"),
    msg(null, null, { inputTokens: 7, outputTokens: 8, cacheReadTokens: 9 }, T_DAY + 1000),
    chunk({ inputTokens: 7, outputTokens: 8, cacheReadTokens: 9 }, T_DAY + 1000),
  ], T_DAY + 5000)
  const j = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=opencode-go")
  assert(j.totals.requests === 1 && j.totals.inputTokens === 7 && j.byModel["opencode-go"].fm.requests === 1, "回退 header；chunk 不双计（嵌套形态）")
}

console.log('场景 29：历史封存 —— 昨天数据不重算，只有今天变更才重新统计')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  // 昨天：10:00 查询，写天文件（deps 记录文件 mtime=T_DAY）
  globalThis.Date.now = () => T_DAY
  await writeSession(env.sessions, "old", [
    msg("opencode-go", "m", { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0 }, T_DAY + 1000),
  ], T_DAY + 5000)
  const j0 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j0.totals.inputTokens === 100, "昨天下班前统计到 100")
  // 今天：advance 24h，旧文件 mtime 未变 → 不被扫描；历史从封存天文件读取
  globalThis.Date.now = () => T_DAY + 24 * 3600000
  await writeSession(env.sessions, "new", [
    msg("opencode-go", "m", { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0 }, T_DAY + 24 * 3600000 + 1000),
  ], T_DAY + 24 * 3600000 + 5000)
  const j1 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j1.days === 2 && j1.totals.inputTokens === 150, "昨天(封存 100) + 今天(50) = 150")
  // 篡改昨天的会话文件内容但保持 mtime → 天文件已验证（封存），不重算 → 结果不变
  const oldFile = pathMod.join(env.sessions, "old", "session.jsonl.zstd")
  await fsxMod.writeFile(oldFile, JSON.stringify(msg("opencode-go", "m", { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0 }, T_DAY + 1000)) + "\n")
  await fsxMod.utimes(oldFile, new Date(T_DAY + 5000), new Date(T_DAY + 5000))
  globalThis.Date.now = () => T_DAY + 24 * 3600000 + 31000
  const j2 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j2.totals.inputTokens === 150, "mtime 未变 → 昨天仍用封存值（内容被改也不重算）")
  // 现在把昨天的文件 mtime 改成今天 → validateDeps 检测到变化 → 只重算昨天当天，并计入新内容
  await fsxMod.utimes(oldFile, new Date(T_DAY + 24 * 3600000 + 6000), new Date(T_DAY + 24 * 3600000 + 6000))
  globalThis.Date.now = () => T_DAY + 24 * 3600000 + 62000 + 300000 // 越过 deps 5 分钟校验周期
  const j3 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j3.totals.inputTokens === 1049, "mtime 变化 → 昨天重算（999）+ 今天（50）= 1049")
}

console.log('场景 30：since 时间过滤（历史天窗口）')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  await writeSession(env.sessions, "old", [msg("opencode-go", "m", { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0 }, T_DAY + 1000)], T_DAY + 5000)
  await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  globalThis.Date.now = () => T_DAY + 24 * 3600000
  await writeSession(env.sessions, "new", [msg("opencode-go", "m", { inputTokens: 30, outputTokens: 0, cacheReadTokens: 0 }, T_DAY + 24 * 3600000 + 1000)], T_DAY + 24 * 3600000 + 5000)
  const all = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(all.totals.inputTokens === 130 && all.days === 2, "全部 = 130 / 2 天")
  const near = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?since=" + (T_DAY + 12 * 3600000))
  assert(near.totals.inputTokens === 30 && near.days === 1, "近半天窗口只含今天 30")
}

console.log('场景 31：30s 缓存 + noCache + 回环防护 + 今天零数据')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  await writeSession(env.sessions, "s1", [msg("opencode-go", "m", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }, T_DAY + 1000)], T_DAY + 5000)
  const j1 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=opencode-go")
  const j2 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=opencode-go")
  assert(j1.cached === false && j2.cached === true, "30s 窗口内命中缓存")
  const j3 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=opencode-go&noCache=1")
  assert(j3.cached === false, "noCache=1 强制重算")
  const forb = await m.call("8.8.8.8", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(forb.error === "forbidden: loopback-only", "非回环 → 403")
  // 无 today 文件可扫 → totals 仍为对象（全 0），不报错
  globalThis.Date.now = () => T_DAY + 24 * 3600000
  const empty = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=opencode-go")
  assert(empty.ok === true && empty.totals.requests === 1 && empty.days === 2, "历史封存仍在（requests=1），今天零数据不崩")
}



console.log('场景 32：首次使用 → 全量回填（老数据可见，只回填一次）')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  async function writeDayAgo(id, daysAgo, input) {
    const t = T_DAY - daysAgo * 86400000
    await writeSession(env.sessions, id, [msg("opencode-go", "m", { inputTokens: input, outputTokens: 0, cacheReadTokens: 0 }, t + 3600000)], t + 3600000 + 5000)
  }
  await writeDayAgo("d3", 3, 100)
  await writeDayAgo("d1", 1, 200)
  await writeDayAgo("d0", 0, 50)
  const j = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j.totals.inputTokens === 350 && j.days === 3, "首次回填：3 天历史全部可见（100+200+50）")
  const dailyDir = pathMod.join(env.home, "provider-usage", "daily-stats")
  const files = await fsxMod.readdir(dailyDir)
  const dayFiles = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  assert(dayFiles.length === 3, "历史天文件已落盘（" + dayFiles.join(",") + "）")
  const histFile = pathMod.join(dailyDir, dayFiles[0])
  const st1 = await fsxMod.stat(histFile)
  globalThis.Date.now = () => T_DAY + 31000
  const j2 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  const st2 = await fsxMod.stat(histFile)
  assert(j2.totals.inputTokens === 350 && st2.mtimeMs === st1.mtimeMs, "二次调用不回填（历史天文件未重写）")
  // 7 天范围 where 3 天前出发 → 也要照顾 since 窗口：查 since = 2 天前 → 只含昨天+今天
  const near = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?since=" + (T_DAY - 2 * 86400000))
  assert(near.totals.inputTokens === 250 && near.days === 2, "since 窗口含昨天+今天（250）")
}


console.log('场景 33：旧版遗留（只有今天天文件、无哨兵）→ 自动回填历史')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  // 模拟旧版遗留：daily-stats 只有"今天"的天文件（无历史、无 .backfilled 哨兵）
  const dailyDir = pathMod.join(env.home, "provider-usage", "daily-stats")
  await fsxMod.mkdir(dailyDir, { recursive: true })
  await fsxMod.writeFile(pathMod.join(dailyDir, "2026-08-25.json"), JSON.stringify({ version: 1, date: "2026-08-25", deps: {}, byProvider: {}, byModel: {} }), "utf8")
  // 3 天前的历史会话（旧版从未统计过）
  const tPast = T_DAY - 3 * 86400000
  await writeSession(env.sessions, "old", [msg("opencode-go", "m", { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0 }, tPast + 3600000)], tPast + 3600000 + 5000)
  const j = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j.totals.inputTokens === 100 && j.days === 2, "旧版遗留 → 自动回填（3 天前 100 + 今天 0，days=2）")
  const files = await fsxMod.readdir(dailyDir)
  assert(files.includes("2026-08-22.json") && files.includes(".backfilled"), "历史天文件 + 哨兵已生成")
}


console.log('场景 34：增量解码 —— 文件追加新帧只算新增，mtime 未变零成本跳过')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  const file = pathMod.join(env.sessions, "s1", "session.jsonl.zstd")
  await fsxMod.mkdir(pathMod.dirname(file), { recursive: true })
  async function appendMsg(input, mtime) {
    await fsxMod.appendFile(file, JSON.stringify(msg("opencode-go", "m", { inputTokens: input, outputTokens: 0, cacheReadTokens: 0 }, T_DAY + 1000 + input)) + "\n")
    await fsxMod.utimes(file, new Date(mtime), new Date(mtime))
  }
  await appendMsg(10, T_DAY + 10000)
  const j1 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j1.totals.inputTokens === 10, "首次全量：10")
  // 追加 20（mtime 变化）→ 增量只解新帧
  await appendMsg(20, T_DAY + 20000)
  globalThis.Date.now = () => T_DAY + 31000
  const j2 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j2.totals.inputTokens === 30, "增量追加：10+20=30")
  // 追加 30 但 mtime 还原 → 本轮跳过（零成本），值不变
  await appendMsg(30, T_DAY + 20000)
  globalThis.Date.now = () => T_DAY + 62000
  const j3 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j3.totals.inputTokens === 30, "mtime 未变：跳过（仍 30）")
  // mtime 恢复变化 → 增量拿到 30（10+20+30=60）
  await fsxMod.utimes(file, new Date(T_DAY + 25000), new Date(T_DAY + 25000))
  globalThis.Date.now = () => T_DAY + 93000
  const j4 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j4.totals.inputTokens === 60, "mtime 再变：增量补到 60")
}

console.log('场景 35：byModel 按提供方过滤 —— 汇总表随提供方选择切换（v0.7.0 回归）')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  // 两个提供方用同一个模型名 glm，外加 command-code 独有 sonnet
  await writeSession(env.sessions, "s1", [
    msg("opencode-go", "glm", { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 }, T_DAY + 1000),
    msg("command-code", "glm", { inputTokens: 100, outputTokens: 200, cacheReadTokens: 300 }, T_DAY + 2000),
    msg("command-code", "sonnet", { inputTokens: 7, outputTokens: 7, cacheReadTokens: 0 }, T_DAY + 3000),
  ], T_DAY + 5000)
  const go = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=opencode-go")
  assert(go.totals.inputTokens === 10 && go.byModel["opencode-go"].glm.requests === 1, "选中 opencode-go：只算自己的 glm（10）")
  assert(!go.byModel["command-code"] && !go.byModel.sonnet, "选中提供方：其它提供方/其模型不出现")
  const cc = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=command-code")
  assert(cc.totals.inputTokens === 107 && cc.byModel["command-code"].glm.requests === 1 && cc.byModel["command-code"].sonnet.requests === 1, "切换 command-code：glm（100）+ sonnet（7）")
  const all = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(all.byModel["opencode-go"].glm.inputTokens === 10 && all.byModel["command-code"].glm.inputTokens === 100 && all.byModel["command-code"].sonnet.requests === 1, "全部：同名模型按提供方分列展示")
}

function dayKeyOf(ms) {
  const d = new Date(ms)
  const pad = (x) => String(x).padStart(2, "0")
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
}
const legacyFlatDay = (day, deps) => ({ version: 1, date: day, deps, byProvider: { "opencode-go": { requests: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 } }, byModel: { glm: { requests: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 } } })

console.log('场景 36a：v0.6.1 扁平天文件带 deps → 重折恢复提供方归属，全部=单提供方一致（v0.7.0 验收问题回归）')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  const dailyDir = pathMod.join(env.home, "provider-usage", "daily-stats")
  await fsxMod.mkdir(dailyDir, { recursive: true })
  const yday = dayKeyOf(T_DAY - 86400000)
  // v0.6.1 真实形态：扁平 byModel + deps 指向会话文件
  const oldFile = pathMod.join(env.sessions, "old", "session.jsonl.zstd")
  await writeSession(env.sessions, "old", [msg("opencode-go", "glm", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 }, T_DAY - 86400000 + 3600000)], T_DAY - 86400000 + 5000)
  await fsxMod.writeFile(pathMod.join(dailyDir, yday + ".json"), JSON.stringify(legacyFlatDay(yday, { [oldFile]: T_DAY - 86400000 + 5000 })), "utf8")
  await fsxMod.writeFile(pathMod.join(dailyDir, ".backfilled"), JSON.stringify({ version: 2, at: 0 }), "utf8") // 新版哨兵：不走全量重折
  await writeSession(env.sessions, "s1", [msg("command-code", "sonnet", { inputTokens: 7, outputTokens: 7, cacheReadTokens: 0 }, T_DAY + 1000)], T_DAY + 5000)
  const all = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(all.totals.inputTokens === 107 && all.providers.length === 2, "totals/providers 不变")
  assert(all.byModel["opencode-go"] && all.byModel["opencode-go"].glm.inputTokens === 100, "重折恢复：glm 归回 opencode-go")
  assert(!all.byModel.unknown, "不再落 unknown 桶")
  const go = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=opencode-go")
  assert(go.totals.inputTokens === 100 && go.byModel["opencode-go"].glm.inputTokens === 100, "选中 opencode-go：模型表可见且与全部一致")
  const stored = JSON.parse(await fsxMod.readFile(pathMod.join(dailyDir, yday + ".json"), "utf8"))
  assert(stored.byModel["opencode-go"] && !stored.byModel.glm, "天文件已重写为嵌套形态")
}

console.log('场景 36b：v0.6.1 扁平天文件 deps 为空 → 无法重折，兜底 unknown 桶仍可见')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  const dailyDir = pathMod.join(env.home, "provider-usage", "daily-stats")
  await fsxMod.mkdir(dailyDir, { recursive: true })
  const yday = dayKeyOf(T_DAY - 86400000)
  await fsxMod.writeFile(pathMod.join(dailyDir, yday + ".json"), JSON.stringify(legacyFlatDay(yday, {})), "utf8")
  await fsxMod.writeFile(pathMod.join(dailyDir, ".backfilled"), JSON.stringify({ version: 2, at: 0 }), "utf8")
  await writeSession(env.sessions, "s1", [msg("command-code", "sonnet", { inputTokens: 7, outputTokens: 7, cacheReadTokens: 0 }, T_DAY + 1000)], T_DAY + 5000)
  const all = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(all.totals.inputTokens === 107 && all.providers.includes("opencode-go"), "旧扁平数据照常计入 totals/providers")
  assert(all.byModel.unknown && all.byModel.unknown.glm.inputTokens === 100, "无 deps 可重折 → 迁入 unknown 提供方桶")
  assert(all.byModel["command-code"].sonnet.inputTokens === 7, "新嵌套数据各归各桶")
  const go = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage?provider=opencode-go")
  assert(go.totals.inputTokens === 100 && !go.byModel["opencode-go"], "选中旧数据提供方：totals 有值，模型行落 unknown 桶")
}

console.log('场景 37：v0.6.1 哨兵（version 1）→ 触发一次性全量重折，历史归属全部恢复')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  const dailyDir = pathMod.join(env.home, "provider-usage", "daily-stats")
  await fsxMod.mkdir(dailyDir, { recursive: true })
  const yday = dayKeyOf(T_DAY - 86400000)
  // 历史：3 天前 + 1 天前（v0.6.1 时代的会话，天文件缺失/过时也无妨——重折以会话文件为准）
  await writeSession(env.sessions, "d3", [msg("opencode-go", "glm", { inputTokens: 30, outputTokens: 0, cacheReadTokens: 0 }, T_DAY - 3 * 86400000 + 3600000)], T_DAY - 3 * 86400000 + 5000)
  await writeSession(env.sessions, "d1", [msg("command-code", "sonnet", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 }, T_DAY - 86400000 + 3600000)], T_DAY - 86400000 + 5000)
  // 只留 v1 哨兵（v0.6.1 所写），天文件全缺 → hasBackfilled(版本判定) = false
  await fsxMod.writeFile(pathMod.join(dailyDir, ".backfilled"), JSON.stringify({ version: 1, at: 0 }), "utf8")
  const j = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j.totals.inputTokens === 130 && j.days === 3, "v1 哨兵触发全量重折（30+100）")
  assert(j.byModel["opencode-go"] && j.byModel["opencode-go"].glm.inputTokens === 30, "重折恢复：glm 归 opencode-go")
  assert(j.byModel["command-code"] && j.byModel["command-code"].sonnet.inputTokens === 100, "重折恢复：sonnet 归 command-code")
  assert(!j.byModel.unknown, "无 unknown 兜底数据")
  // 哨兵已升级为 v2：第二次调用不再重折
  const sent = JSON.parse(await fsxMod.readFile(pathMod.join(dailyDir, ".backfilled"), "utf8"))
  assert(Number(sent.version) === 2, "哨兵已写为 version 2")
}

console.log('场景 38：重置本地统计 —— 删派生缓存 + 清 30s 缓存，下次查询自动重算（不触碰会话原文）')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  await writeSession(env.sessions, "s1", [
    msg("opencode-go", "m", { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 }, T_DAY + 1000),
  ], T_DAY + 5000)
  const j1 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j1.totals.inputTokens === 10 && j1.cached === false, "重置前：统计正常")
  const dailyDir = pathMod.join(env.home, "provider-usage", "daily-stats")
  const before = (await fsxMod.readdir(dailyDir)).length
  assert(before >= 3, "派生文件已存在（天文件+cursors+哨兵）")
  // POST 重置
  const j2 = await m.call("127.0.0.1", undefined, "POST", "127.0.0.1:3080", "/api/provider-usage/reset-local-stats")
  assert(j2.ok === true && j2.removed >= 3, "重置成功，返回清除文件数（" + j2.removed + "）")
  const after = (await fsxMod.readdir(dailyDir)).length
  assert(after === 0, "daily-stats 目录已清空")
  const sess = pathMod.join(env.sessions, "s1", "session.jsonl.zstd")
  assert(await fsxMod.stat(sess).then(() => true, () => false), "会话原文完好（只读不动）")
  // 30s 缓存已清：同窗口内重查是新数据（removed=1 天文件重新生成）
  const j3 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j3.ok === true && j3.totals.inputTokens === 10 && j3.cached === false, "重置后查询：从会话原文重算，数值一致")
  const after2 = (await fsxMod.readdir(dailyDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  assert(after2.length === 1, "天文件已自动重建")
}

console.log('场景 39：重置对损坏天文件有效 —— 投毒天文件被清除，重查从会话原文重建')
{
  const env = await localEnv()
  const m = mount({ rawConfig: { sessionsDir: env.sessions } })
  globalThis.Date.now = () => T_DAY
  await writeSession(env.sessions, "s1", [
    msg("opencode-go", "m", { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 }, T_DAY + 1000),
  ], T_DAY + 5000)
  // 正常首查：天文件落盘并进入天缓存
  const j1 = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j1.totals.inputTokens === 10, "重置前：10")
  // 投毒：篡改盘上天文件；真实损坏场景 = 进程重启后天缓存为空、读到坏盘文件 → 重新挂载实例复现
  const dailyDir = pathMod.join(env.home, "provider-usage", "daily-stats")
  const dayFile = pathMod.join(dailyDir, dayKeyOf(T_DAY) + ".json")
  await fsxMod.writeFile(dayFile, JSON.stringify({ version: 2, date: dayKeyOf(T_DAY), deps: {}, byProvider: { "opencode-go": { requests: 1, inputTokens: 999, outputTokens: 0, cacheReadTokens: 0 } }, byModel: { "opencode-go": { m: { requests: 1, inputTokens: 999, outputTokens: 0, cacheReadTokens: 0 } } } }), "utf8")
  globalThis.Date.now = () => T_DAY + 31000
  const m2 = mount({ rawConfig: { sessionsDir: env.sessions } }) // 新实例 = 天缓存为空（模拟重启）
  const j2 = await m2.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j2.totals.inputTokens === 999, "投毒生效（重启后读到损坏天文件，复现损坏场景）")
  // 重置：必须把内存天缓存一并清掉，重查从会话原文重建
  globalThis.Date.now = () => T_DAY + 62000
  const j3 = await m2.call("127.0.0.1", undefined, "POST", "127.0.0.1:3080", "/api/provider-usage/reset-local-stats")
  assert(j3.ok === true && j3.removed >= 1, "重置成功")
  const j4 = await m2.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(j4.totals.inputTokens === 10 && j4.byModel["opencode-go"].m.inputTokens === 10, "重置后：从会话原文重建为 10（投毒数据被清除）")
  const stored = JSON.parse(await fsxMod.readFile(dayFile, "utf8"))
  assert(stored.byProvider["opencode-go"].inputTokens === 10, "天文件已重建为正确数据")
}

console.log('场景 40：提供方清单持久化（v0.8.0 修复「重启后清单被静默重建」）')
{
  const os = await import('node:os')
  const fsx = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const prev = process.env.DSH_HOME
  const tmp = await fsx.mkdtemp(pathMod.join(os.tmpdir(), 'pu-prov-'))
  process.env.DSH_HOME = tmp
  try {
    const list = [
      { id: 'opencode-go', name: 'OpenCode Go', adapter: 'usage-percent', ref: 'OPENCODE_GO_API_KEY', source: 'dsh', type: 'import', paused: false },
      { id: 'commandcode-credits-1788142304061', name: 'Command Code', adapter: 'commandcode-credits', ref: 'commandcode-credits-1788142304061', source: 'vault', type: 'manual', paused: false },
    ]
    const m = mount()
    const provRoute = m.getRoutes().find((r) => r.path === '/api/provider-usage/providers')
    assert(!!provRoute, '/api/provider-usage/providers 路由已注册')

    // 1) 初次 GET：文件缺失 → ok + providers:null（客户端走一次性迁移）
    const g0 = await m.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/providers')
    assert(g0.ok === true && g0.providers === null && g0.exists === false, '初次 GET：缺失返回 null + exists:false')

    // 2) POST 保存（模拟客户端迁移/写穿透）→ 落盘 providers.json
    const p1 = await m.call('127.0.0.1', undefined, 'POST', '127.0.0.1:3080', '/api/provider-usage/providers', JSON.stringify({ providers: list }))
    assert(p1.ok === true && p1.providers.length === 2, 'POST 保存成功')
    const file = pathMod.join(tmp, 'provider-usage', 'providers.json')
    const doc = JSON.parse(await fsxMod.readFile(file, 'utf8'))
    assert(doc.version === 1 && doc.providers.length === 2, 'providers.json 落盘（version 1）')
    assert(doc.providers[1].adapter === 'commandcode-credits' && doc.providers[1].ref === 'commandcode-credits-1788142304061', 'Command Code 实例已持久化（含 vault ref）')

    // 3) 模拟重启：重新挂载插件实例（新 mount 即新实例、无内存状态）→ GET 恢复
    const m2 = mount()
    const g1 = await m2.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/providers')
    assert(g1.ok === true && g1.exists === true && g1.providers.length === 2, '重启后 GET：清单完整恢复')
    assert(g1.providers[1].name === 'Command Code' && g1.providers[1].source === 'vault', 'Command Code 实例跨重启存活（不再被默认清单吞掉）')
    assert(g1.providers[0].paused === false, 'paused 字段保留')

    // 4) 脏数据防御：非法 adapter / 缺 id 的条目被剔除，合法条目保留；paused 归一为布尔
    const p2 = await m2.call('127.0.0.1', undefined, 'POST', '127.0.0.1:3080', '/api/provider-usage/providers', JSON.stringify({
      providers: [
        { id: 'ok-1', adapter: 'balance-json', name: 'DeepSeek', ref: 'DEEPSEEK_API_KEY', paused: 1 },
        { id: 'bad-adapter', adapter: 'unknown-adapter', name: 'X' },
        { adapter: 'usage-percent', name: 'no-id' },
        'not-an-object',
        null,
      ],
    }))
    assert(p2.ok === true && p2.providers.length === 1, '脏条目剔除，合法条目保留')
    assert(p2.providers[0].id === 'ok-1' && p2.providers[0].paused === false, '合法条目规范化（paused 严格归一为布尔，非 true 值 → false）')

    // 5) 非 providers 数组的 POST 拒绝（400）
    const p3 = await m2.call('127.0.0.1', undefined, 'POST', '127.0.0.1:3080', '/api/provider-usage/providers', JSON.stringify({ providers: 'nope' }))
    assert(p3.ok === false && p3.error && p3.error.httpStatus === 400, 'providers 非数组 → 400')

    // 6) 损坏文件：改名留证并按缺失处理，不卡死恢复流程
    await fsxMod.writeFile(file, '{corrupt!!', 'utf8')
    const g2 = await m2.call('127.0.0.1', undefined, 'GET', '127.0.0.1:3080', '/api/provider-usage/providers')
    assert(g2.ok === true && g2.providers === null && g2.exists === false, '损坏文件按缺失处理（ok，不抛 500）')
    const siblings = await fsxMod.readdir(pathMod.join(tmp, 'provider-usage'))
    assert(siblings.some((f) => f.startsWith('providers.json.corrupt-')), '损坏文件改名 .corrupt-* 留证')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
  }
}

if (failed > 0) { console.error('\nFAILED: ' + failed + ' 项'); process.exit(1) }
console.log('\nPASSED: ' + passed + ' 项全部通过')
