# Changelog

## v0.8.0（2026-09-02）

### 兼容性修复：适配 dsh 0.1.2-alpha（破坏性变更）

本次 dsh `0.1.1-rc.2 → 0.1.2-alpha.4` 重构后，插件出现两类症状：升级当天 `dsh web` 启动即崩
（`duplicate loader entry id: provider-usage`），重新安装后变为 **host 半区正常（7 条 API 路由全部注册）
但 Web UI 静默失联**（设置页无「用量中心」、无常驻卡片）。两个问题的根源都在插件自身的
「包名迁移残留」与 alpha 新的客户端发现机制不兼容，本版全部修复：

- **`cordis.patch.yml` 的 entry `name` 改为正式包名 `@loommii/dsh-provider-usage`**
  - v0.6.0 包名迁移（`dsh-provider-usage` → `@loommii/dsh-provider-usage`）时漏改了此文件，
    此后一直靠 profile `node_modules` 里改名前遗留的旧名符号链接 `dsh-provider-usage → 工作区`
    才能解析到包（rc.2 环境下侥幸可用）
  - alpha.4 的客户端扫描（`dsh-client-modules` node 半区 `nearestPackage`）从 loader entry
    的模块位置向上查找 package.json，且要求 `name === entry 名`；旧名在重装后解析失败 →
    包被判定为「非客户端包」→ 永不进 `window.__DSH_BOOT__` 组合图 → UI 静默消失（host 不受影响）
  - 升级首日的 `duplicate loader entry id` 崩溃亦与残留链接相关（旧名/新名两条路径同时进树，
    loader `EntryGroup.update` 对同 id 双行 fail-loud）；清理残留链接 + 本修复后消除
- **删除 `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]` 死引用**
  - alpha 重构将 `dsh-client-runtime` 并入 `dsh-client-modules`，该包已不存在；
    插件 client 半区从未 require 过 runtime 的任何导出，声明本就多余
  - 两侧加载器对 graph 外的 inject 静默跳过，故这是卫生项而非故障源
- **`lib/client.js` 的 `__ModuleLoader__.load` 注册 id 同步改为 `@loommii/dsh-provider-usage`**
  - alpha 的 boot graph 行 id = 包名，`serveBundle` 按 id 应答 combo bundle；注册 id 与
    graph 行不一致时模块系统找不到 factory（对官方包此场景 fail-loud，对插件即静默失联）
- **peerDependencies 放宽**：`@deepseek-ai/dsh-host-webserver` `^0.1.0-rc.6` → `>=0.1.0-rc.6`
  （npm prerelease semver 规则下 `^` 不匹配 `0.1.2-alpha.*`，消除安装时 peer 警告）

### 兼容性核对（对 dsh-v0.1.2-alpha.4 源码逐项验证）

- `ctx.webServer.register({kind:'exact'|'prefix', path, handler(req,res)})` 契约不变（`dsh-host-webserver` 健在）
- `window.__ModuleLoader__.load({id, factory})` 仍是注册协议；`exports.inject`（`['slots']`）仍被
  vendored cordis Loader 消费（`Cr.resolve(n.inject)`）
- 平台 seed 词 `react` / `react-dom/client` / `@deepseek-ai/cordis` / `dsh-client-ui-slots` 全保留
  （React 仍为 18.3.1）
- `settings.section` 插槽契约保留（`dsh-client-ui-settings` contract/slots.ts）
- 会话文件格式：JSONL 后端仍默认（`.jsonl.zstd`、`SESSION_FORMAT_VERSION = 0`、目录布局、
  `assistant/message` → `data.usage{inputTokens,outputTokens,cacheReadTokens}` 事件行全部不变），
  本地 Token 统计不受影响；alpha.3 已移除可选 SQLite 后端，此前的前瞻风险解除
- alpha.4 新增的「web 请求一次性 fetch 审批（SSRF 防护）」为 web 客户端侧，不影响 host 侧出站查询

### 用户升级指引（从 ≤0.7.0 升级到 0.8.0）

若升级 dsh 后曾出现 `duplicate loader entry id: provider-usage`，profile 的 `node_modules`
里可能残留改名前的旧名符号链接。重装插件即可清理：

```sh
dsh plugin --profile web remove @loommii/dsh-provider-usage
dsh plugin --profile web add github:loommii/dsh-provider-usage   # 或 npm: @loommii/dsh-provider-usage
# 若 node_modules 下仍有 dsh-provider-usage/（旧名，非 @loommii scope）残留目录/链接，手动删除
```

## v0.7.0（2026-09-01）

### 小功能
- **Command Code 卡片主数字改为「本月剩余百分比」**：原大数字为月已用百分比（整数、四舍五入），现改为月剩余百分比，保留 3 位小数向下取整（如 62.9432148907/70 = 89.91887…% → 显示 89.918%）；标签「已用（每月）」→「剩余（每月）」
  - host：`monthly` 新增 `remainingPct` 字段（剩余/总额 ×100，钳 [0,100] 后 `floor` 到 3 位小数）；`usedPct` 保留（月窗口行仍显示已用口径）
  - client：大数字读 `remainingPct`；连旧版服务端（无该字段）时按 `100 − usedPct` 同公式兜底；降级（无计划/未知计划）仍显示 `--`
  - 回归：场景 20b/20c/20d 补断言，新增场景 20g（向下取整边界：1/70 → 1.428 非 1.429、69.999/70 → 99.998、满额 100、用完 0、超额钳 0）
- **用量统计页新增「重置统计」按钮**：「刷新」旁两段式确认（4s 未确认自动解除）后删除按天物化的派生缓存（天文件/游标/哨兵）并清空 30s 查询缓存，下次查询自动从会话原文全量重算；**会话原文只读不动**；天文件损坏 / 迁移异常 / 想强制重建时的自助兜底；新端点 `POST /api/provider-usage/reset-local-stats`（仅回环，POST-only）

### 修复
- **用量统计页「按模型汇总」不随提供方选择切换（恒显示全部提供方的合并数据）**：chips/totals 按 `provider` 过滤，但 `byModel` 恒为全量聚合，且扁平 `{ 模型: 计数 }` 结构无提供方维度、服务端无法过滤
  - host：`byModel` 升级为按提供方嵌套 `{ 提供方: { 模型: 计数 } }`（新会话折叠与天文件落盘同步新形态）；响应按选中提供方过滤模型汇总，与 chips/totals 语义对齐；选中提供方恒返回嵌套形态（无数据 = 空对象）
  - 存储迁移（验收回归修复）：天文件格式升为 v2（`DAILY_VERSION = 2`）；v0.6.1 旧扁平天文件按 deps 重折恢复真实提供方归属（会话文件仍是事实源，重写为嵌套形态）；deps 缺失无法重折时才兜底迁入 `unknown` 桶；`.backfilled` 哨兵按版本判定，v1 哨兵触发一次性全量重折
  - client：按选中提供方渲染模型表；「全部」时同名模型跨提供方合并求和展示；按响应形态自动判别、兼容 v0.6.1 旧服务端（无提供方维度时行为同旧版）
  - 回归：host 场景 35（跨提供方同名模型、切换提供方模型表跟随）、场景 36a/36b（旧扁平天文件重折恢复归属 / 无 deps 兜底 unknown）、场景 37（v1 哨兵触发一次性全量重折）、场景 38（重置统计：清缓存重建 + 会话原文完好）
- 重置统计未清空天文件内存缓存（`dayCache`）：重置后立即重查仍以旧天数据做种子，导致「重置对损坏天文件无效」且旧数字残留；现删盘上文件时一并清空（host 场景 39：投毒天文件在重置后从会话原文重建）
- 重置交互：确认重置后旧数据仍展示到新查询完成（沿用静默刷新策略，与「清空 → 重建」的用户预期相悖）；现确认后立即清空展示进入「查询中」重建态。重置完成提示语此前无清除路径会常驻页面；现查询完成后自动消失
- 测试：user-agent 断言由硬编码 0.6.0 改为动态读取 `package.json` 版本（v0.6.1 升版时漏改，main 上存量失败）

## v0.6.1（2026-08-31）

### 修复
- 卡片 hover 标题 `title` 从空字符串改为显示当前提供方名（多 provider 时显示「点击切换」）

### 小功能
- a11y：`prefers-reduced-motion` 媒体查询禁用呼吸动画与进度条扫光（尊重系统级无障碍偏好）

### 文档
- 新增 `LICENSE`（MIT）；`package.json` `files` 补全以确保 npm tarball 包含 LICENSE
- README：顶部副标题加「附带本地 Token 统计页」、功能列表新增 Token 统计要点、安装/卸载章节拆分 GitHub 与 npm 两栏、使用说明补「两个标签」提示、新增「配置项」表格、新增 License 章节

## v0.6.0（2026-08-31）

> **npm 首发**：本版本同步发布至 npm `@loommii/dsh-provider-usage`（无 scope 的 `dsh-provider-usage` 包名已被他人占用，故改用账号 scope）。npm 与 GitHub 渠道**同号同码**（同一提交、同一 tag `v0.6.0`）；scoped 包首次发布需 `--access public`（已在 `publishConfig` 配置），安装方无感。

### 大功能
- **新增提供方 Command Code（订阅+余额混合卡）**：只能通过「添加自定义提供方」添加（Command Code 非 DSH 内置提供方，pi-ai 注册表无对应 provider，故不出现在「从 DSH 导入提供方」列表）
  - 新适配器 `commandcode-credits`：官方双端点查询（`/alpha/billing/credits` + `/alpha/billing/subscriptions`），只填 API Key（加密存插件私有库，不经 DSH 凭证）
  - **新卡片类型**：主数字 = 月已用百分比，副行「已用 $X / $Y + 剩余 $Z」，下方 5 小时 / 周 / 月三窗口进度条（月窗口 = 计划总额 − 剩余推算，planId 映射表；未知计划安全降级）
  - 订阅端点失败自动降级（保留窗口+剩余）；401/403 复用现有分类
  - 5 档计划映射：individual-go($10) / goat($70) / pro($80) / max($150) / ultra($300)

### 修复
- **Command Code 卡片 5 小时/周窗口的「重置倒计时」恒为空白**：host 窗口字段名 `resetAt` 与 client `WindowRow` 读取的 `resetsAt` 不一致（现统一为 `resetsAt`，client 兼容读 `resetAt` 兜底旧数据）；补 20b 回归断言
- 出站请求 `user-agent` 版本号残留 0.5.0 → 改为从 `package.json` 读取（单一来源，升版不再漏改）
- Command Code 订阅端点（次要端点）超时从 15s 缩短为 5s（可经 `subscriptionTimeoutMs` 配置）：credits 秒回而 subscriptions 卡死时，卡片不再干等全局超时；补 20f 场景验证
- 订阅失败/未知计划导致月% 推算不出时，Command Code 卡片隐藏月窗口行（此前渲染「--% + 0% 空进度条」，易误读为「还没开始用」）

### 小功能
- 提供方设置：自定义表单默认选中 Command Code；卡片/菜单用文字「CC」logo 占位（无官方素材，后续可换）

### 文档
- 新增 `docs/commandcode-support-plan.md`：方案评估（现状/API 能力/双端点混合模型/备选对比/待确认决策）

## v0.5.2（2026-08-30）

### 重构
- 「按模型汇总」由 div+grid 改为语义化 <table>，列宽 auto 布局 + 内容自适应，数字列不再截断
- 缩略数字保留点击展开完整值（整列同步变宽）；移除 hover 悬浮窗，交互统一为点击
- 模型名单行省略，完整名见 title

## v0.5.1（2026-08-27）

### 修复
- 提供方状态 chip 在 `data.error` 时显示「查询失败」（此前显示泛化的「错误」）
- 用量页默认时间范围：全部 → 近 1 天（避免首次打开聚合多日数据；「全部时间」仍可选）

### 重构
- 提供方列表渲染：6 个内联 if-else 收敛为 `statusOf` 纯函数 + `ProviderRow` 组件，关注点分离（外部行为不变）

## v0.5.0（2026-08-27）

### 大功能
- **本地 Token 用量统计**（模仿 cc-switch 统计模型：请求级记账 → 汇总 → 命中率；数据源 = DSH 会话日志，不依赖外部服务）
  - 按天物化 `daily-stats/YYYY-MM-DD.json`（1 天 1 文件、原子写）；首次自动全量回填历史（`.backfilled` 哨兵），之后游标增量只解析新帧
  - **多帧 zstd 增量解码**：会话文件每次 flush 一帧（实测 10MB / 16751 帧）；wasm（@bokuweb/zstd-wasm）主路径 + fzstd 失败帧兜底，正确性与 CLI 一致；全量回填 ~184ms、增量 200 帧 ~14ms、闲置轮询 ~30ms
  - 指标：请求数 / 输入 / 输出 / 缓存读取 / 命中率（cacheRead ÷ (input + cacheRead)）/ 真实总 token（input + output + cacheRead）
  - 按 provider / 按模型汇总；时间范围全部 / 近 1 天 / 近 7 天 / 近 30 天（**自然日语义**：近 1 天 = 今天 00:00 起，不是滚动 24h）
  - 进程内按天缓存 + deps 5 分钟校验，历史天不重复读盘；新依赖 @bokuweb/zstd-wasm / fzstd（package-lock.json 入库）
- 设置页改官方插件页同款 **二级菜单**：「提供方设置 / 用量统计」两页互不影响（方向键切换 + 各自记忆）

### 小功能
- 提供方状态圆点改 **点击展开**：红色 = 错误原因，绿色 = 完整响应 JSON（删除悬停）
- 查询加载动画进度条
- 缩略数字单位 k / M / B / T + **点击整卡展开完整千分位数字**（整卡悬停高亮，键盘 Enter/空格同样可用）

### 文档
- 测试脚本 `npm test` 补齐 daily-stats.test.mjs；docs/规范 发布清单数字更新

## v0.4.2（2026-08-26）

### 修复
- 卡片窗口行「重置时间」改为**紧凑倒计时**（Rainytoken 小组件同款格式：3d4h / 5h32m / 42m / <1m）：此前显示绝对钟点（如 重置 00:00:00），跨天重置（本周/本月）无日期完全不可读；现在显示距下次重置的剩余时长，悬停卡片重置格显示「约 X 后重置」完整提示
## v0.4.1（2026-08-25）

### 修复
- 卡片刷新按钮强制绕过 30s 缓存（noCache=1）：此前 30s 新鲜窗口内点击会直接命中 host 缓存，页面无任何变化；现在手动刷新真实请求上游，fetchedAt 即时更新
- 卡片状态灯绑定请求中状态：请求进行中（含手动刷新、有旧数据时）显示**绿色呼吸「查询中」**（复用设置页同款 `dsh-pu-ms-breathe` 动画）；同时修复首次加载时「红色错误 + 正文查询中」的自相矛盾展示
## v0.4.0（2026-08-24）

### 小功能
- 多适配器 + 提供方实例：按 adapter（usage-percent 订阅型 / balance-json 余额型）查询；设置页可管理提供方实例（名称自定义、Key 引用、增删改），卡片与选择菜单跟随清单；
  卡片按结果字段自适应渲染（%+倒计时=订阅卡；金额+币种=余额卡）
- 新增 host 路由：`/api/provider-usage/query?provider=<id>`（旧 `/opencode-go` 保持兼容）、`/api/provider-usage/templates`（预设清单）
- 凭证链按 preset 泛化：DSH 设置 `llm-pi-ai.providers[<key>].apiKeyEnv` → 凭据服务 → 环境变量
- 缓存 per-provider 隔离（30s 新鲜窗口各自独立）；cordis `baseUrl` 覆盖收敛为仅作用于 opencode-go（修复 DeepSeek 误打到 opencode 域名的 404）

### UI
- **删除宠物元素**：移除鲸鱼精灵/悬浮按钮/点击弹框，改用右下角**常驻用量卡片**（布局借鉴 Rainytoken 暗色视觉：暖深底、草莓粉、官方 logo、状态胶囊、三色窗口条、窗口行=标签/已用%/进度条/重置时间）
- 设置面板：提供方管理（实例增删改、状态圆点），与官方「模型」页 1:1 同款骨架；卡片点击 logo/名称在**多实例**时弹出选择菜单，单实例不可点；卡片固定每 30s 自动刷新
- 设置页实例支持「编辑」：导入的提供方可改名称；自定义提供方（vault）可改名称与 API 密钥（改 Key 后强制刷新查询，绕过 30s 缓存）；术语「供应商」统一改为「提供方」（对齐 DSH 模型页）
- 旧数据自愈：早期手动实例（`source` 缺失/为 dsh 但 Key 仅存在插件私有库）自动迁移为 vault 手动实例，恢复可改 Key；`credential-refs` 新增 `store` 字段（dsh/vault/both/none）
- 实例记录新增显式 `type` 字段（`import`=DSH 导入 / `manual`=自定义）：创建时写入，读取时显式 type 优先（旧数据由 source 推导兜底）；**type 决定编辑能力，source 仅表示 Key 解析位置**
- 删除放开「最后一个实例」限制：支持删光提供方（空清单持久化，刷新不复活默认实例；用量卡片自动隐藏，设置页显示空态提示；删除自定义实例时同步清理私有库中的 Key）
- **卡片可拖动 + 位置记忆**：与 dsh-pet 同款 pointer 拖拽（整卡可拖、4px 阈值防误触、右/下钳制在视口内）；松手即持久化到 `dsh-provider-usage.settings` 的 `right`/`bottom`，刷新/重挂载自动恢复位置（设置版本 v5）

### 文档
- README 更新为 M2（多供应商 + 卡片）；本地调研（cc-switch 机制、Rainytoken 评估）存 `tmp/` 不入仓库

## v0.3.0（2026-08-24）

### 小功能
- 系统命名统一为「用量中心」：设置侧边栏入口、设置页标题、🐳 对话框标题、状态卡描述、README、包描述
- （命名面向后续 cc-switch 式多供应商扩展，OpenCode Go 降级为当前唯一数据源说明）

### 文档
- 新增 `docs/规范/版本号说明.md`：三段 semver 规则、大/小功能表达、0.x 规则、历史对照、四段否决结论
- 新增 `docs/规范/发布流程.md`：发布流程、提交信息约定、tag 两态规则、检查清单
- README 增加版本规范摘要与链接

## v0.2.0（2026-08-24）

- **样式**：设置页按 dsh-pet（dsh-web-ui-all 0.3.2）卡片规范重做（tokens/字形/字段行/按钮）
- **层级**：z-index 固定 2147483000（与 dsh-pet 一致），不再开放用户设置（设置迁移 v3）
- **挂载**：🐳 改挂 body 顶层 React root（与 dsh-pet 同构），不再被 better-sidebar 等浮层遮挡
- **对话框**：贴紧宠物实测定位（12px/10px）+ 右缘实测宽度钳制（不再越界）
- **默认值**：对齐 dsh-pet（尺寸 160 / right 24 / bottom 20）

## v0.1.0 – v0.1.7（早期逐批递增，已发布）

- v0.1.0 M1：悬浮宠物 + OpenCode Go 用量查询（cc-switch 语义）
- v0.1.1：可拖动 + 位置记忆 + 自愈看门狗
- v0.1.2：设置分区（设置页）
- v0.1.3：换用鲸鱼娘（精致版）精灵动画
- v0.1.4：默认值对齐 dsh-pet（160px）
- v0.1.5：对话框贴紧（实测高度）
- v0.1.6/v0.1.7：修正贴紧偏移与右缘越界（均在本地，未单独发布）

> 注：v0.1.8–v0.1.10 为本地迭代号，未对外发布，合并入 v0.2.0。
