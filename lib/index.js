// dsh-provider-usage — Host half (M2 简易版，多供应商)。
// 两类适配器（对齐 cc-switch 的 UsageData 统一模型）：
//   usage-percent（订阅型）：OpenCode Go  {{baseUrl}}/v1/usage        → rolling/weekly/monthly %
//   balance-json（余额型）  ：DeepSeek     {{baseUrl}}/user/balance    → balance_infos[]
// 凭证链 per provider：DSH 设置 provider.apiKeyEnv → 凭证服务 → 环境变量。
// 路由：/api/provider-usage/opencode-go（兼容旧版）、/api/provider-usage/query?provider=<id>、
//       /api/provider-usage/templates（仅回环）。
// 缓存：每 provider 独立 30s 新鲜窗口 + 并发去重 + 3 快照环；stale-while-error。

import { createSecureStore, resolveProviderUsageDir, isValidRefName } from './secure-store.js'

export const name = 'provider-usage'

/** 插件需要的运行时服务。 */
export const inject = ['webServer', 'settings', 'credentials']

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_PROVIDER_ID = 'opencode-go'
/** 缓存新鲜窗口：30s 内直接复用上次成功结果（per provider）。 */
const CACHE_FRESH_MS = 30000
/** 诊断快照环大小。 */
const SNAPSHOT_LIMIT = 3
/** 解析逻辑版本，改动加 1。 */
const PARSE_VERSION = 1

/** 内置适配器注册表（URL 由插件自身维护，不读 DSH 内置目录 —— 2026-08-24 决策）。
 * 用户可在客户端配置多个"供应商实例"，每个实例绑定一个适配器 + 自定义名称 + key 引用。 */
const ADAPTERS = [
  {
    id: 'usage-percent',
    displayName: 'OpenCode Go（订阅额度）',
    baseUrl: 'https://opencode.ai/zen/go',
    usagePath: '/v1/usage',
    defaultCredentialRef: 'OPENCODE_GO_API_KEY',
    settingsProviderKey: 'opencode-go',
    description: 'OpenCode Go 订阅额度（5小时/7天/月度窗口百分比）',
  },
  {
    id: 'balance-json',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    usagePath: '/user/balance',
    defaultCredentialRef: 'DEEPSEEK_API_KEY',
    settingsProviderKey: 'deepseek',
    description: 'DeepSeek 开放平台账户余额（CNY，balance_infos）',
  },
]

/** 旧 provider id → 适配器 id（向后兼容 /api/provider-usage/opencode-go 与 query?provider=…）。 */
const LEGACY_PROVIDER_MAP = { 'opencode-go': 'usage-percent', 'deepseek-balance': 'balance-json' }

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

/** 解析指定 key 引用的 API Key：provider 配置 apiKeyEnv → DSH 凭证 → 环境变量。
 * spec = { credentialRef, settingsProviderKey }。 */
/**
 * 解析 Key 引用。
 * - fromVault=true：手动实例显式来源=插件私有库 → 【直接】解密私有库，跳过 DSH 链（同名也不冲突）
 * - fromVault=false：DSH 模型设置 → DSH 凭证 → 环境变量 → 私有库兜底（兼容旧实例）
 */
async function resolveCredentialFor(ctx, spec, storeFn, fromVault) {
  let ref = spec.credentialRef
  if (!fromVault) {
    try {
      let cfg = null
      try { cfg = ctx.settings.get('llm-pi-ai') } catch { /* ignore */ }
      if (!cfg) {
        try { cfg = ctx.settings.get('settings.llm-pi-ai') } catch { /* ignore */ }
      }
      const p = cfg && cfg.providers && cfg.providers[spec.settingsProviderKey]
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
  }
  // 私有加密库：vault 直取，或作为旧链兜底
  if (typeof storeFn === 'function') {
    try {
      const s = await storeFn()
      const v = await s.get(ref)
      if (v) return { key: v, source: 'provider-usage:' + ref }
    } catch { /* ignore */ }
  }
  return null
}

// ── 解析（订阅型：与 cc-switch extractor 语义一致）────────────────

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
    cards: null,
    isValid: true,
    invalidMessage: null,
  }
}

// ── 解析（余额型：DeepSeek /user/balance，官方文档 + cc-switch balance.rs 语义）──

/** 把 DeepSeek balance 响应换算成结构化结果（每币种一张卡）。 */
function parseBalance(body) {
  let data = body
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return { error: 'bad-json' } }
  }
  const isAvailable = data && typeof data.is_available === 'boolean'
    ? data.is_available
    : true
  const infos = data && Array.isArray(data.balance_infos) ? data.balance_infos : null
  if (!infos) return { error: 'no-balance' }

  const cards = infos.map((info) => {
    const currency = typeof info.currency === 'string' && info.currency ? info.currency : 'CNY'
    const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
    return {
      currency,
      remaining: toNum(info.total_balance),
      granted: toNum(info.granted_balance),
      toppedUp: toNum(info.topped_up_balance),
      isValid: isAvailable,
      invalidMessage: isAvailable ? null : '余额不足（账户不可用）',
    }
  })

  const fmt = (n) => (n === null ? '--' : n.toFixed(2))
  const parts = cards.map((c) => {
    let s = c.currency + ' ¥' + fmt(c.remaining)
    if (c.granted !== null || c.toppedUp !== null) {
      s += '（赠送 ' + fmt(c.granted) + ' + 充值 ' + fmt(c.toppedUp) + '）'
    }
    return s
  })
  const extra = parts.join('；') + (isAvailable ? '' : ' · 账户不可用（余额不足）')

  return {
    planName: 'DeepSeek 余额',
    remaining: cards.length > 0 ? cards[0].remaining : null,
    unit: cards.length > 0 ? cards[0].currency : 'CNY',
    extra,
    windows: null,
    cards,
    isValid: isAvailable,
    invalidMessage: isAvailable ? null : '余额不足（账户不可用）',
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────

export function apply(ctx, rawConfig) {
  const config = {
    baseUrlOverride: rawConfig && typeof rawConfig.baseUrl === 'string' && rawConfig.baseUrl
      ? rawConfig.baseUrl.replace(/\/$/, '')
      : null,
    timeoutMs: rawConfig && typeof rawConfig.timeoutMs === 'number' && rawConfig.timeoutMs > 0
      ? Math.min(rawConfig.timeoutMs, 30000)
      : DEFAULT_TIMEOUT_MS,
  }

  // cordis 配置的 baseUrl 仅覆盖 opencode-go（历史语义），其余 preset 用内置 URL（插件自维护）
  const effectiveBaseUrl = (cfg) =>
    cfg.id === 'usage-percent' && config.baseUrlOverride ? config.baseUrlOverride : cfg.baseUrl

  // 私有加密凭证库（方案 B，懒初始化：首次使用时生成密钥）
  let secure = null
  async function secureStore() {
    if (!secure) { secure = createSecureStore(resolveProviderUsageDir()); await secure.init() }
    return secure
  }

  /** 某 Key 引用位于哪个库：'dsh' | 'vault' | 'both' | null（供客户端区分导入/手动实例，旧数据自愈）。 */
  async function refStoreOf(name) {
    let dshHit = false
    const creds = ctx.credentials || ctx.get('credentials')
    if (creds) {
      try {
        if (typeof creds.describe === 'function') {
          const d = await creds.describe(name)
          if (d && (d.source || d.value !== undefined || d.inherited !== undefined || d.status === 'configured')) dshHit = true
        } else if (typeof creds.resolve === 'function') {
          const r = await creds.resolve(name)
          if (r && r.value !== undefined && r.value !== null) dshHit = true
        }
      } catch (e) { /* ignore */ }
    }
    let vaultHit = false
    try { vaultHit = await (await secureStore()).has(name) } catch (e) { /* ignore */ }
    if (dshHit && vaultHit) return 'both'
    if (dshHit) return 'dsh'
    if (vaultHit) return 'vault'
    return null
  }

  /** 某 Key 引用是否已配置：DSH describe/resolve → 私有加密库。 */
  async function refConfigured(name) {
    return (await refStoreOf(name)) !== null
  }

  // per-adapter 状态：adapterId -> { lastGood, fetching }
  const states = new Map()
  function stateOf(adapterId) {
    let s = states.get(adapterId)
    if (!s) { s = { lastGood: null, fetching: null }; states.set(adapterId, s) }
    return s
  }

  function recordSnapshot(adapterId, snapshot) {
    const s = stateOf(adapterId)
    s.snapshots = s.snapshots || []
    s.snapshots.push(snapshot)
    if (s.snapshots.length > SNAPSHOT_LIMIT) s.snapshots = s.snapshots.slice(-SNAPSHOT_LIMIT)
  }

  const okResponse = (cfg, value, state, extraFields) => ({
    ok: true,
    providerId: cfg.id,
    displayName: cfg.displayName,
    config: { baseUrl: effectiveBaseUrl(cfg) + cfg.usagePath, timeoutMs: config.timeoutMs, provider: cfg.id },
    valid: true,
    planName: value.planName,
    remaining: value.remaining,
    unit: value.unit,
    extra: value.extra,
    windows: value.windows,
    cards: value.cards,
    isValid: value.isValid !== false,
    invalidMessage: value.invalidMessage || null,
    fetchedAt: state.lastGood ? state.lastGood.queriedAt : Date.now(),
    cached: false,
    stale: false,
    error: null,
    credential: state.lastGood ? state.lastGood.credential : null,
    snapshots: (state.snapshots || []).slice(),
    parseVersion: PARSE_VERSION,
    ...extraFields,
  })

  async function doQuery(cfg, credentialRef, fromVault) {
    const ref = (typeof credentialRef === 'string' && credentialRef.trim() !== '') ? credentialRef.trim() : cfg.defaultCredentialRef
    const key = cfg.id + '|' + ref + '|' + (fromVault ? 'vault' : 'dsh')
    const state = stateOf(key)
    const resolved = await resolveCredentialFor(ctx, { credentialRef: ref, settingsProviderKey: cfg.settingsProviderKey }, secureStore, fromVault === true)
    if (!resolved) {
      recordSnapshot(key, { attemptAt: Date.now(), httpStatus: null, error: 'no-api-key' })
      return fail(cfg, state, 'no-api-key', '未找到 ' + cfg.displayName + ' API Key：请在 DSH 模型设置中配置，或设置环境变量 ' + ref)
    }

    const attemptAt = Date.now()
    const url = effectiveBaseUrl(cfg) + cfg.usagePath
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    let res
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + resolved.key,
          accept: 'application/json',
          'user-agent': 'dsh-provider-usage/0.4.1',
        },
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      const aborted = e && (e.name === 'AbortError' || e.message === 'AbortError')
      recordSnapshot(key, { attemptAt, httpStatus: null, error: aborted ? 'timeout' : 'network' })
      return aborted ? failTransient(cfg, state, 'timeout', '请求超时（' + config.timeoutMs + 'ms）') : failTransient(cfg, state, 'network', '网络请求失败：' + String((e && e.message) || e))
    }
    clearTimeout(timer)

    const credential = { source: resolved.source, keyHint: maskKey(resolved.key) }

    if (res.status === 401 || res.status === 403) {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'unauthorized' })
      return fail(cfg, state, 'unauthorized', res.status === 401 ? 'API Key 无效或已过期（401）' : '无访问权限（403）', res.status)
    }
    if (!res.ok) {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'http-' + res.status })
      return fail(cfg, state, 'http', '接口返回 HTTP ' + res.status, res.status)
    }

    let body = null
    try { body = await res.json() } catch { /* ignore */ }
    if (body === null) {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'bad-json' })
      return fail(cfg, state, 'parse', '接口响应不是有效 JSON', res.status)
    }

    const parsed = cfg.id === 'balance-json' ? parseBalance(body) : parseUsage(body)
    if (parsed.error === 'no-usage') {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'no-usage' })
      return fail(cfg, state, 'parse', '没有找到 OpenCode Go 用量数据', res.status)
    }
    if (parsed.error === 'no-balance') {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'no-balance' })
      return fail(cfg, state, 'parse', '没有找到 DeepSeek 余额数据（balance_infos）', res.status)
    }
    if (parsed.error === 'bad-json') {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'bad-json' })
      return fail(cfg, state, 'parse', '接口返回的数据不是有效 JSON', res.status)
    }

    recordSnapshot(key, { attemptAt, httpStatus: res.status, error: null })
    const good = { queriedAt: Date.now(), credential, parsed }
    state.lastGood = good
    return okResponse(cfg, parsed, state, { fetchedAt: good.queriedAt, credential })
  }

  function fail(cfg, state, type, message, httpStatus) {
    if (state.lastGood) {
      const prev = state.lastGood
      return { ...okResponse(cfg, prev.parsed, state, { fetchedAt: prev.queriedAt, credential: prev.credential }), cached: true, stale: true, ok: false, error: { type, message, httpStatus: httpStatus || null } }
    }
    return { ok: false, providerId: cfg.id, displayName: cfg.displayName, valid: null, planName: null, remaining: null, unit: '%', extra: null, windows: null, cards: null, isValid: false, invalidMessage: null, fetchedAt: null, cached: false, stale: false, error: { type, message, httpStatus: httpStatus || null }, credential: null, snapshots: (state.snapshots || []).slice(), parseVersion: PARSE_VERSION, config: { baseUrl: effectiveBaseUrl(cfg) + cfg.usagePath, timeoutMs: config.timeoutMs, provider: cfg.id } }
  }

  function failTransient(cfg, state, type, message) {
    if (state.lastGood) {
      const prev = state.lastGood
      return { ...okResponse(cfg, prev.parsed, state, { fetchedAt: prev.queriedAt, credential: prev.credential }), cached: true, stale: true, ok: false, error: { type, message, httpStatus: null } }
    }
    return fail(cfg, state, type, message, null)
  }

  /** 查询参数：adapter（新）/ provider（旧兼容）/ ref（key 引用，客户端实例可自定义）。 */
  async function query(params) {
    const provider = params && params.provider
    const adapter = params && params.adapter
    const mapped = provider ? LEGACY_PROVIDER_MAP[provider] : null
    // 显式给了 provider/adapter 但解析不到 → 未知（404）；完全没给 → 默认 usage-percent
    const id = adapter || mapped || (provider || adapter ? null : 'usage-percent')
    const rawLabel = adapter || provider || DEFAULT_PROVIDER_ID
    const cfg = ADAPTERS.find((a) => a.id === id)
    if (!cfg) {
      return {
        ok: false, providerId: rawLabel, displayName: null, valid: null, planName: null,
        remaining: null, unit: '%', extra: null, windows: null, cards: null,
        isValid: false, invalidMessage: null, fetchedAt: null, cached: false, stale: false,
        error: { type: 'unknown-provider', message: '未知供应商：' + rawLabel, httpStatus: 404 },
        credential: null, snapshots: [], parseVersion: PARSE_VERSION,
        config: { baseUrl: null, timeoutMs: config.timeoutMs, provider: rawLabel },
      }
    }
    const ref = (typeof (params && params.ref) === 'string' && params.ref.trim() !== '') ? params.ref.trim() : cfg.defaultCredentialRef
    const fromVault = !!(params && params.source === 'vault')
    const force = !!(params && (params.noCache === '1' || params.noCache === 'true'))
    const key = id + '|' + ref + '|' + (fromVault ? 'vault' : 'dsh')
    const state = stateOf(key)
    // 30s 新鲜窗口内直接返回缓存（noCache=1 跳过：改 Key 后强制刷新）
    if (!force && state.lastGood && Date.now() - state.lastGood.queriedAt < CACHE_FRESH_MS) {
      const prev = state.lastGood
      return { ...okResponse(cfg, prev.parsed, state, { fetchedAt: prev.queriedAt, credential: prev.credential }), cached: true }
    }
    if (!force && state.fetching) return state.fetching
    state.fetching = doQuery(cfg, ref, fromVault)
      .catch((e) => failTransient(cfg, state, 'internal', String((e && e.message) || e)))
      .finally(() => { state.fetching = null })
    return state.fetching
  }

  function readBodyJson(req) {
    return new Promise((resolve) => {
      let raw = ''
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      try {
        req.on('data', (chunk) => { raw += String(chunk); if (raw.length > 8192) finish(null) })
        req.on('end', () => { try { finish(JSON.parse(raw || '{}')) } catch (e) { finish(null) } })
        req.on('error', () => finish(null))
      } catch (e) { finish(null) }
    })
  }

  const jsonRoute = (handler, allowPost) => async (req, res) => {
    if (!isLoopbackRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && (!allowPost || req.method !== 'POST')) {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    try {
      const body = req.method === 'POST' ? await readBodyJson(req) : undefined
      const result = await handler(req, body)
      res.writeHead(result.error && result.error.httpStatus ? result.error.httpStatus : 200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { type: 'internal', message: String((e && e.message) || e) } }))
    }
  }

  /** 从 URL 提取查询参数：adapter / provider（旧兼容）/ ref（key 引用）。 */
  const queryParamsFromUrl = (req) => {
    try {
      if (!req.url) return {}
      const u = new URL(req.url, 'http://localhost')
      const out = {}
      const p = u.searchParams.get('provider'); if (p && p.trim()) out.provider = p.trim()
      const a = u.searchParams.get('adapter'); if (a && a.trim()) out.adapter = a.trim()
      const r = u.searchParams.get('ref'); if (r && r.trim()) out.ref = r.trim()
      const s = u.searchParams.get('source'); if (s && s.trim()) out.source = s.trim()
      const n = u.searchParams.get('noCache'); if (n && (n === '1' || n === 'true')) out.noCache = '1'
      return out
    } catch (e) {
      return {}
    }
  }

  ctx.effect(() => {
    const disposers = [
      // 兼容旧版：固定 opencode-go → usage-percent 适配器
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/opencode-go',
        handler: jsonRoute(() => query({})),
      }),
      // 多实例查询：/api/provider-usage/query?adapter=<id>&ref=<credentialRef>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/query',
        handler: jsonRoute((req) => query(queryParamsFromUrl(req))),
      }),
      // 适配器清单（不含任何 secret；客户端据此渲染"添加供应商"选项）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/templates',
        handler: jsonRoute(() => ({
          ok: true,
          items: ADAPTERS.map((a) => ({ id: a.id, displayName: a.displayName, description: a.description })),
        })),
      }),
      // 手动 Key 写入/删除：值加密进 $DSH_HOME/provider-usage（方案 B，不落明文、不进 DSH 凭证）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/credentials',
        handler: jsonRoute(async (req, body) => {
          // 私有库键独立命名空间（非 DSH 引用名）：允许字母/数字/下划线/连字符
          const keyOk = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(k)
          if (req.method === 'POST') {
            const ref = body && typeof body.ref === 'string' ? body.ref.trim() : ''
            const value = body && typeof body.value === 'string' ? body.value : ''
            if (!keyOk(ref)) return { ok: false, error: { type: 'bad-ref', message: 'Key 标识不合法（仅限字母/数字/下划线/连字符）', httpStatus: 400 } }
            if (!value) return { ok: false, error: { type: 'bad-value', message: 'Key 值不能为空', httpStatus: 400 } }
            await (await secureStore()).set(ref, value)
            return { ok: true, ref }
          }
          const ref = typeof req.url === 'string' ? (new URL(req.url, 'http://localhost').searchParams.get('ref') || '') : ''
          if (!keyOk(ref)) return { ok: false, error: { type: 'bad-ref', message: 'Key 标识不合法', httpStatus: 400 } }
          await (await secureStore()).remove(ref)
          return { ok: true, ref }
        }, true),
      }),
      // 可从 DSH 导入的供应商（仅我们适配：OpenCode Go 订阅 / DeepSeek 余额）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/dsh-providers',
        handler: jsonRoute(async () => {
          let settingsCfg = null
          try { settingsCfg = ctx.settings.get('llm-pi-ai') } catch (e) { /* ignore */ }
          if (!settingsCfg) { try { settingsCfg = ctx.settings.get('settings.llm-pi-ai') } catch (e) { /* ignore */ } }
          const IMPORTABLE = [
            { route: 'opencode-go', displayName: 'OpenCode Go', adapter: 'usage-percent', ref: 'OPENCODE_GO_API_KEY', settingsKey: 'opencode-go' },
            { route: 'deepseek-official', displayName: 'DeepSeek', adapter: 'balance-json', ref: 'DEEPSEEK_API_KEY', settingsKey: 'deepseek' },
          ]
          const items = []
          for (const imp of IMPORTABLE) {
            const prov = settingsCfg && settingsCfg.providers && settingsCfg.providers[imp.settingsKey]
            const ref = prov && typeof prov.apiKeyEnv === 'string' && prov.apiKeyEnv.trim() !== '' ? prov.apiKeyEnv.trim() : imp.ref
            const displayName = prov && typeof prov.displayName === 'string' && prov.displayName ? prov.displayName : imp.displayName
            items.push({ route: imp.route, displayName, adapter: imp.adapter, ref, configured: await refConfigured(ref) })
          }
          return { ok: true, items }
        }),
      }),
      // 按需检查 Key 引用的配置状态（不含值；官方 Models 页同款的 credentials.describe）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/credential-refs',
        handler: jsonRoute(async (req) => {
          const list = []
          try {
            if (req.url) {
              const u = new URL(req.url, 'http://localhost')
              const raw = u.searchParams.get('refs')
              if (raw) {
                for (const part of raw.split(',')) {
                  const name = part.trim()
                  // 宽松校验：兼容 DSH 引用名与私有库键（实例 id 含连字符）
                  if (name && /^[A-Za-z0-9_-]{1,64}$/.test(name) && list.length < 24) list.push(name)
                }
              }
            }
          } catch (e) { /* ignore */ }
          const refs = []
          for (const name of list) {
            const store = await refStoreOf(name)
            refs.push({ name, configured: store !== null, store })
          }
          return { ok: true, refs }
        }),
      }),
    ]
    return () => { for (const dispose of disposers) { if (typeof dispose === 'function') dispose() } }
  }, 'provider-usage: routes')
}
