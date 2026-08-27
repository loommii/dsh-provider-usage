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
  async function call(remote = '127.0.0.1', stub, method = 'GET', host = '127.0.0.1:3080', url = null) {
    if (stub) globalThis.fetch = stub
    let text = null
    const res = { writeHead: (c, h) => { res.code = c }, end: (t) => { text = t } }
    const req = { method, socket: { remoteAddress: remote }, headers: { host }, url }
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
  assert(j.ok === true && Array.isArray(j.items) && j.items.length === 2, '2 个预设')
  assert(j.items[0].id === 'usage-percent' && j.items[1].id === 'balance-json', '适配器 id 与顺序')
  assert(j.items[0].credentialRef === undefined && j.items[1].credentialRef === undefined, '不含凭证引用')
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
  assert(JSON.stringify(j.providers) === JSON.stringify(["opencode-go"]) && j.byModel.m1.requests === 2, "providers/byModel")
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
  const all = await m.call("127.0.0.1", undefined, "GET", "127.0.0.1:3080", "/api/provider-usage/local-usage")
  assert(all.totals.requests === 3, "全部 provider requests=3")
  assert(all.providers.length === 2 && all.byModel.b.requests === 1, "providers 枚举/byModel 全量")
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
  assert(j.totals.requests === 1 && j.totals.inputTokens === 7 && j.byModel.fm.requests === 1, "回退 header；chunk 不双计")
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

if (failed > 0) { console.error('\nFAILED: ' + failed + ' 项'); process.exit(1) }
console.log('\nPASSED: ' + passed + ' 项全部通过')
