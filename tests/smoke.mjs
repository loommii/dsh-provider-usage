// M2 smoke test: mock a minimal cordis ctx, mount the host plugin,
// and drive the /api/provider-usage/opencode-go handler plus the templates route.
// Without a real key the outbound call fails; we assert the result shape.
import { apply, name, inject } from '../lib/index.js'

const capturedRoutes = []
const ctx = {
  settings: {
    get: () => ({ providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } }),
  },
  credentials: { resolve: async () => ({ value: 'sk-test-not-real' }) },
  get: () => undefined,
  logger: { warn: () => {} },
  webServer: {
    register: (route) => { capturedRoutes.push(route); return () => {} },
  },
  // cordis effect 立即执行回调并返回 dispose
  effect: (fn) => { (fn || (() => {}))() },
}

apply(ctx, { baseUrl: 'https://opencode.ai/zen/go', timeoutMs: 4000 })

if (name !== 'provider-usage') throw new Error('name mismatch')
if (!inject.includes('webServer')) throw new Error('inject mismatch')
const captured = capturedRoutes.find((r) => r.path === '/api/provider-usage/opencode-go')
if (!captured) throw new Error('route not mounted')
const templatesRoute = capturedRoutes.find((r) => r.path === '/api/provider-usage/templates')
if (!templatesRoute) throw new Error('templates route not mounted')

const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }
let bodyText = null
const res = {
  writeHead: (code, headers) => { res.code = code; res.headers = headers },
  end: (text) => { bodyText = text },
}

await captured.handler(req, res)
const json = JSON.parse(bodyText)
console.log('status:', res.code)
console.log('shape:', JSON.stringify({ ok: json.ok, error: json.error, cached: json.cached, stale: json.stale, hasWindows: !!json.windows, parseVersion: json.parseVersion }))

// 非回环请求必须 403
let forbiddenText = null
const fRes = { writeHead: (c, h) => { fRes.code = c }, end: (t) => { forbiddenText = t } }
await captured.handler({ method: 'GET', socket: { remoteAddress: '192.168.1.10' }, headers: { host: '127.0.0.1' } }, fRes)
console.log('loopback-guard status:', fRes.code, 'body:', forbiddenText)
if (fRes.code !== 403) throw new Error('loopback guard failed')

// ── 场景 2：stub fetch 返回官方示例，验证解析语义（对齐 cc-switch 脚本）──
const sampleBody = {
  usage: {
    rolling: { status: 'ok', percent: 9, resetsAt: '2099-01-01T00:00:00.000Z' },
    weekly: { status: 'ok', percent: 12, resetsAt: '2099-01-08T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 13, resetsAt: '2099-02-01T00:00:00.000Z' },
  },
}
const realFetch = globalThis.fetch
globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => sampleBody })

let okText = null
const okRes = { writeHead: (c, h) => { okRes.code = c }, end: (t) => { okText = t } }
await captured.handler({ method: 'GET', socket: { remoteAddress: '::1' }, headers: { host: 'localhost' } }, okRes)
const okJson = JSON.parse(okText)
console.log('success status:', okRes.code, 'ok:', okJson.ok, 'cached:', okJson.cached, 'stale:', okJson.stale)
console.log('remaining(monthly):', okJson.remaining, 'unit:', okJson.unit, 'planName:', okJson.planName)
console.log('windows:', JSON.stringify(okJson.windows))
console.log('extra:', JSON.stringify(okJson.extra))
if (!okJson.ok || okJson.remaining !== 87 || okJson.windows.rolling.usedPct !== 9) throw new Error('parse semantics mismatch')
if (!/5小时: 91%/.test(okJson.extra) || !/7天: 88%/.test(okJson.extra)) throw new Error('extra text mismatch')
globalThis.fetch = realFetch

// ── 场景 3：templates 路由（清单 + 非回环 403）──
let tplText = null
const tplRes = { writeHead: (c, h) => { tplRes.code = c }, end: (t) => { tplText = t } }
await templatesRoute.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }, tplRes)
const tpl = JSON.parse(tplText)
if (!tpl.ok || tpl.items.length !== 2) throw new Error('templates mismatch: ' + tplText)
if (tpl.items.some((i) => i.credentialRef !== undefined)) throw new Error('templates leak secrets')
console.log('templates:', JSON.stringify(tpl.items.map((i) => i.id)))
let tplForbidText = null
const f2Res = { writeHead: (c, h) => { f2Res.code = c }, end: (t) => { tplForbidText = t } }
await templatesRoute.handler({ method: 'GET', socket: { remoteAddress: '10.0.0.8' }, headers: { host: '127.0.0.1' } }, f2Res)
if (f2Res.code !== 403) throw new Error('templates loopback guard failed')
console.log('templates loopback-guard status:', f2Res.code)
console.log('SMOKE OK')
