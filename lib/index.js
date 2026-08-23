// dsh-provider-usage — Host half (M1).
// 只做一件事：按 cc-switch 的 OpenCode Go 用量查询语义（{{baseUrl}}/v1/usage +
// Bearer key → rolling/weekly/monthly 百分比与倒计时）查询官方接口，
// 通过同源回环路由 /api/provider-usage/opencode-go 提供给浏览器。
// 点击时查询 + 30s 缓存复用；确定性失败与瞬时失败语义对齐 cc-switch。

export const name = 'provider-usage'

/** 插件需要的运行时服务。 */
export const inject = ['webServer', 'settings', 'credentials']

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go'
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_CREDENTIAL_REF = 'OPENCODE_GO_API_KEY'
/** 缓存新鲜窗口：30s 内直接复用上次成功结果。 */
const CACHE_FRESH_MS = 30000
/** 诊断快照环大小。 */
const SNAPSHOT_LIMIT = 3
/** 解析逻辑版本，改动加 1。 */
const PARSE_VERSION = 1

function isLoopbackRequest(req) {
  const addr = req.socket && req.socket.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
  const host = req.headers && req.headers.host
  if (host) {
    const hostname = String(host).replace(/:[0-9]+$/, '').toLowerCase()
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  }
  return true
}

/** 掩码 key：前 4 + … + 后 4。 */
function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null
  if (key.length <= 8) return '***'
  return key.slice(0, 4) + '…' + key.slice(-4)
}

/** 解析 OpenCode Go API Key：provider 配置 apiKeyEnv → DSH 凭证 → 环境变量。 */
async function resolveApiKey(ctx) {
  let ref = DEFAULT_CREDENTIAL_REF
  try {
    let cfg = null
    try { cfg = ctx.settings.get('llm-pi-ai') } catch { /* ignore */ }
    if (!cfg) {
      try { cfg = ctx.settings.get('settings.llm-pi-ai') } catch { /* ignore */ }
    }
    const p = cfg && cfg.providers && cfg.providers['opencode-go']
    if (p && typeof p.apiKeyEnv === 'string' && p.apiKeyEnv.trim() !== '') ref = p.apiKeyEnv.trim()
  } catch { /* ignore */ }
  try {
    const creds = ctx.credentials || ctx.get('credentials')
    if (creds && typeof creds.resolve === 'function') {
      const hit = await creds.resolve(ref)
      if (hit && hit.value) return { key: String(hit.value), source: 'credential:' + ref }
    }
  } catch { /* ignore */ }
  try {
    const env = typeof process !== 'undefined' ? process.env[ref] : undefined
    if (env) return { key: env, source: 'env:' + ref }
  } catch { /* ignore */ }
  return null
}

// ── 解析（与用户提供的 cc-switch extractor 语义一致）─────────────────

function getUsedPercent(usage, name) {
  const item = usage && usage[name]
  if (!item || item.percent === undefined || item.percent === null) return null
  const value = Number(item.percent)
  if (Number.isNaN(value)) return null
  return Math.max(0, Math.min(100, value))
}

function formatRemainingPercent(usedPercent) {
  if (usedPercent === null) return '--'
  return Math.round(100 - usedPercent) + '%'
}

function formatCountdown(isoTime) {
  if (!isoTime) return '--'
  const resetTimestamp = Date.parse(isoTime)
  if (Number.isNaN(resetTimestamp)) return '--'
  const seconds = Math.max(0, Math.floor((resetTimestamp - Date.now()) / 1000))
  if (seconds <= 0) return '已到期'
  const days = Math.floor(seconds / 86400)
  let rest = seconds % 86400
  const hours = Math.floor(rest / 3600)
  rest = rest % 3600
  const minutes = Math.floor(rest / 60)
  if (days > 0) return days + 'd' + hours + 'h'
  if (hours > 0) return hours + 'h' + minutes + 'm'
  if (minutes > 0) return minutes + 'm'
  return Math.floor(rest) + 's'
}

/** 把官方响应换算成结构化结果（含用户脚本同款 extra 文案）。 */
function parseUsage(body) {
  let data = body
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return { error: 'bad-json' } }
  }
  const usage = data && data.usage
  if (!usage) return { error: 'no-usage' }

  const rollingUsed = getUsedPercent(usage, 'rolling')
  const weeklyUsed = getUsedPercent(usage, 'weekly')
  const monthlyUsed = getUsedPercent(usage, 'monthly')
  const monthlyRemaining = monthlyUsed === null ? 0 : 100 - monthlyUsed

  const windowOf = (name, usedPct) => {
    const item = usage[name] || {}
    return {
      status: typeof item.status === 'string' ? item.status : 'ok',
      usedPct,
      remainingPct: usedPct === null ? null : Math.round((100 - usedPct) * 100) / 100,
      resetsAt: typeof item.resetsAt === 'string' && item.resetsAt ? item.resetsAt : null,
    }
  }

  return {
    planName: 'OpenCode Go',
    remaining: monthlyRemaining,
    unit: '%',
    extra:
      '5小时: ' + formatRemainingPercent(rollingUsed) +
      '  7天: ' + formatRemainingPercent(weeklyUsed) +
      '  ◷ ' + formatCountdown(usage.monthly && usage.monthly.resetsAt) +
      '  5小时重置 ' + formatCountdown(usage.rolling && usage.rolling.resetsAt) +
      ' · 7天重置 ' + formatCountdown(usage.weekly && usage.weekly.resetsAt),
    windows: {
      rolling: windowOf('rolling', rollingUsed),
      weekly: windowOf('weekly', weeklyUsed),
      monthly: windowOf('monthly', monthlyUsed),
    },
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────

export function apply(ctx, rawConfig) {
  const config = {
    baseUrl: rawConfig && typeof rawConfig.baseUrl === 'string' && rawConfig.baseUrl
      ? rawConfig.baseUrl.replace(/\/$/, '')
      : DEFAULT_BASE_URL,
    timeoutMs: rawConfig && typeof rawConfig.timeoutMs === 'number' && rawConfig.timeoutMs > 0
      ? Math.min(rawConfig.timeoutMs, 30000)
      : DEFAULT_TIMEOUT_MS,
  }

  const state = {
    lastGood: null,        // 最近一次成功结果
    snapshots: [],         // 诊断快照环
    fetching: null,        // 并发去重
  }

  function recordSnapshot(snapshot) {
    state.snapshots.push(snapshot)
    if (state.snapshots.length > SNAPSHOT_LIMIT) state.snapshots = state.snapshots.slice(-SNAPSHOT_LIMIT)
  }

  const okResponse = (value, extraFields) => ({
    ok: true,
    config: { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs },
    valid: true,
    planName: value.planName,
    remaining: value.remaining,
    unit: value.unit,
    extra: value.extra,
    windows: value.windows,
    fetchedAt: state.lastGood ? state.lastGood.queriedAt : Date.now(),
    cached: false,
    stale: false,
    error: null,
    credential: state.lastGood ? state.lastGood.credential : null,
    snapshots: state.snapshots.slice(),
    parseVersion: PARSE_VERSION,
    ...extraFields,
  })

  async function doQuery() {
    const resolved = await resolveApiKey(ctx)
    if (!resolved) {
      recordSnapshot({ attemptAt: Date.now(), httpStatus: null, error: 'no-api-key' })
      return fail('no-api-key', '未找到 OpenCode Go API Key：请在 DSH 模型设置中配置，或设置环境变量 ' + DEFAULT_CREDENTIAL_REF)
    }

    const attemptAt = Date.now()
    const url = config.baseUrl + '/v1/usage'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    let res
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + resolved.key,
          accept: 'application/json',
          'user-agent': 'dsh-provider-usage/0.1.0',
        },
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      const aborted = e && (e.name === 'AbortError' || e.message === 'AbortError')
      recordSnapshot({ attemptAt, httpStatus: null, error: aborted ? 'timeout' : 'network' })
      return aborted ? failTransient('timeout', '请求超时（' + config.timeoutMs + 'ms）') : failTransient('network', '网络请求失败：' + String((e && e.message) || e))
    }
    clearTimeout(timer)

    const credential = { source: resolved.source, keyHint: maskKey(resolved.key) }

    if (res.status === 401 || res.status === 403) {
      recordSnapshot({ attemptAt, httpStatus: res.status, error: 'unauthorized' })
      return fail('unauthorized', res.status === 401 ? 'API Key 无效或已过期（401）' : '无访问权限（403）', res.status)
    }
    if (!res.ok) {
      recordSnapshot({ attemptAt, httpStatus: res.status, error: 'http-' + res.status })
      return fail('http', '接口返回 HTTP ' + res.status, res.status)
    }

    let body = null
    try { body = await res.json() } catch { /* ignore */ }
    if (body === null) {
      recordSnapshot({ attemptAt, httpStatus: res.status, error: 'bad-json' })
      return fail('parse', '接口响应不是有效 JSON', res.status)
    }

    const parsed = parseUsage(body)
    if (parsed.error === 'no-usage') {
      recordSnapshot({ attemptAt, httpStatus: res.status, error: 'no-usage' })
      return fail('parse', '没有找到 OpenCode Go 用量数据', res.status)
    }
    if (parsed.error === 'bad-json') {
      recordSnapshot({ attemptAt, httpStatus: res.status, error: 'bad-json' })
      return fail('parse', 'OpenCode Go 返回的数据不是有效 JSON', res.status)
    }

    recordSnapshot({ attemptAt, httpStatus: res.status, error: null })
    const good = { queriedAt: Date.now(), credential, parsed }
    state.lastGood = good
    return okResponse(parsed, { fetchedAt: good.queriedAt, credential })
  }

  function fail(type, message, httpStatus) {
    if (state.lastGood) {
      // 确定性失败但之前有成功数据：返回旧数据 + stale + error（前端显示旧值）
      const prev = state.lastGood
      return { ...okResponse(prev.parsed, { fetchedAt: prev.queriedAt, credential: prev.credential }), cached: true, stale: true, ok: false, error: { type, message, httpStatus: httpStatus || null } }
    }
    return { ok: false, valid: null, planName: null, remaining: null, unit: '%', extra: null, windows: null, fetchedAt: null, cached: false, stale: false, error: { type, message, httpStatus: httpStatus || null }, credential: null, snapshots: state.snapshots.slice(), parseVersion: PARSE_VERSION, config: { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs } }
  }

  function failTransient(type, message) {
    if (state.lastGood) {
      const prev = state.lastGood
      return { ...okResponse(prev.parsed, { fetchedAt: prev.queriedAt, credential: prev.credential }), cached: true, stale: true, ok: false, error: { type, message, httpStatus: null } }
    }
    return { ok: false, valid: null, planName: null, remaining: null, unit: '%', extra: null, windows: null, fetchedAt: null, cached: false, stale: false, error: { type, message, httpStatus: null }, credential: null, snapshots: state.snapshots.slice(), parseVersion: PARSE_VERSION, config: { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs } }
  }

  async function query() {
    // 30s 新鲜窗口内直接返回缓存
    if (state.lastGood && Date.now() - state.lastGood.queriedAt < CACHE_FRESH_MS) {
      const prev = state.lastGood
      return { ...okResponse(prev.parsed, { fetchedAt: prev.queriedAt, credential: prev.credential }), cached: true }
    }
    if (state.fetching) return state.fetching
    state.fetching = doQuery()
      .catch((e) => failTransient('internal', String((e && e.message) || e)))
      .finally(() => { state.fetching = null })
    return state.fetching
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/api/provider-usage/opencode-go',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        try {
          const result = await query()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { type: 'internal', message: String((e && e.message) || e) } }))
        }
      },
    })
    return () => { if (typeof dispose === 'function') dispose() }
  }, 'provider-usage: routes')
}
