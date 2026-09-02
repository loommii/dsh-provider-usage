# dsh-provider-usage — DSH「用量中心」

> 当前版本 **v0.8.0** · npm `@loommii/dsh-provider-usage` · [更新历史](docs/CHANGELOG.md)

DSH Web GUI 插件 **「用量中心」**：一个常驻右下角的用量卡片，实时显示你的 AI 服务用量 / 余额，不用再打开网页查；附带本地 Token 统计页，不联网也能看自己今天用了多少。

## v0.8.0 更新摘要（适配 dsh 0.1.2-alpha）

- **适配 dsh `0.1.2-alpha` 破坏性重构**：修复升级后「设置页无用量中心 / 卡片消失」与
  `duplicate loader entry id` 启动崩溃（根因：v0.6.0 包名迁移时 `cordis.patch.yml` 与
  client 注册 id 仍用旧名，叠加 alpha 新的客户端发现机制导致静默失联）
- host 侧 API 契约、会话文件解析、平台注入（react / slots）经逐项核对在 alpha.4 全部兼容
- 完整变更与用户升级指引见 [CHANGELOG](docs/CHANGELOG.md)

## v0.6.0 更新摘要

- **新增提供方 Command Code（订阅+余额混合卡）**：5 小时 / 周 / 月窗口使用量 + 月度剩余额度（USD），主数字为月已用百分比
- **窗口重置倒计时修复**：之前 5 小时/周窗口的"重置"字段恒为空，现在正常显示倒计时
- **请求 User-Agent 跟随版本号**：告别硬编码残留，升版不再漏改
- **订阅端点短超时**：新增 `subscriptionTimeoutMs`（默认 5s），防止次要端点挂起拖累整体响应
- **月百分比智能隐藏**：Command Code 月用量无法推算时隐藏整行，避免"0% 还没用"的误导
- 完整变更见 [CHANGELOG](docs/CHANGELOG.md)

## 支持的提供方

| 提供方 | 显示内容 |
|---|---|
| OpenCode Go（订阅） | 5 小时 / 7 天 / 月度三个窗口的已用百分比 + 进度条 + 重置倒计时 |
| DeepSeek（余额） | 账户余额（CNY） |
| Command Code（订阅+余额，自定义） | 5 小时 / 周 / 月窗口使用量 + 月度剩余额度（USD），主数字为本月剩余百分比（3 位小数向下取整） |

## 功能

- **常驻用量卡片**：右下角悬浮，一眼看到剩余量；可随意拖动，位置自动记住
- **自动刷新**：每 30s 自动更新；想看最新数据点卡片上的 ↻ 立即重新查询
- **多实例**：可以同时配置多个提供方（如多个 OpenCode Go 账号），点卡片 logo / 名称切换查看
- **本地 Token 统计**：自读本机 `$DSH_HOME/sessions` 会话文件，按天聚合今天的 Token 用量（按提供方分类 + 按模型汇总，汇总表跟随所选提供方），**只读本地、不联网**；数据落盘 `$DSH_HOME/provider-usage/daily-stats/`，历史天封存只算今天；设置页可一键重置统计缓存（不影响会话记录）
- **状态提示**：正常 / 未更新 / 注意 / 错误，请求中显示「查询中」动画
- **Key 安全**：密钥只在 DSH 进程内解析使用，界面上一律打码显示；自定义 Key 可加密保存在本机（AES-256 加密），不落明文

## 安装 / 卸载

### GitHub

```sh
# 安装
dsh plugin --profile web add github:loommii/dsh-provider-usage

# 安装指定版本（可选）
dsh plugin --profile web add github:loommii/dsh-provider-usage#v0.6.0

# 卸载
dsh plugin --profile web remove @loommii/dsh-provider-usage
```

### npm

```sh
# 安装
dsh plugin --profile web add @loommii/dsh-provider-usage

# 卸载
dsh plugin --profile web remove @loommii/dsh-provider-usage
```

安装 / 卸载后重启 `dsh web` 即可生效。

> npm 包名为 `@loommii/dsh-provider-usage`（无 scope 的 `dsh-provider-usage` 在 npm 上已被他人占用）。

## 快速开始

1. 打开 DSH 设置 → **用量中心** → 「提供方」
2. 添加一个实例：
   - **OpenCode Go 订阅**：需要 OpenCode Go 的 API Key（默认读取 `OPENCODE_GO_API_KEY`）
   - **DeepSeek 余额**：需要 DeepSeek 开放平台的 API Key（默认读取 `DEEPSEEK_API_KEY`）
   - **Command Code（自定义）**：仅「添加自定义提供方」可选；需要 Command Code 后台生成的 API Key（`user_xxx`），填进本插件加密保存
   - Key 也可以直接填进本插件保存（加密存储，不进 DSH 凭证）
3. 回到主界面，右下角就会出现用量卡片，每 30s 自动刷新

## 使用说明

- 提供方实例的增删改、Key 设置都在 **设置 → 用量中心** 里完成，改动即时生效，无需重启
- 设置页有两个标签：「提供方」管理实例，「用量统计」查看本地 Token 统计
- 设置保存在本机浏览器中；删掉实例不会上传或泄露任何 Key
- 卡片拖动后的位置会自动保存，下次打开还是老位置

## 配置项（可选）

以下配置写入 profile 的 bundle 配置（`cordis.patch.yml` / 设置页），全部有合理默认值，不配也能用：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | – | 仅覆盖 OpenCode Go 的查询地址（历史语义）；其余提供方用内置官方地址 |
| `timeoutMs` | `15000` | 出站请求超时（上限 30000） |
| `subscriptionTimeoutMs` | `5000` | Command Code 订阅端点（次要端点）超时；慢网络可调大 |
| `maxSessions` | `30` | 本地 Token 统计扫描的会话文件数上限（上限 100） |
| `sessionsDir` | `$DSH_HOME/sessions` | 本地 Token 统计的会话目录覆盖 |

## License

[MIT](LICENSE)
