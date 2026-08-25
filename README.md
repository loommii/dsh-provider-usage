# dsh-provider-usage (M2 · 0.4.0)

DSH Web GUI 插件 · **用量中心**：右下角**常驻用量卡片**（布局借鉴 Rainytoken 小组件卡片），
实时显示所选提供方的用量/余额。

- **多适配器**（内置注册表，URL 由插件自身维护；用户按"提供方实例"自由组合）：
  - `usage-percent`（订阅型）：`GET https://opencode.ai/zen/go/v1/usage` + Bearer → 月度剩余 % + 5小时/7天窗口 + 重置倒计时
  - `balance-json`（余额型）：`GET https://api.deepseek.com/user/balance` + Bearer → 账户余额（CNY，balance_infos）
- 提供方实例：名称可自定义（默认 OpenCode Go / DeepSeek 余额）、Key 引用可指定；卡片按结果字段自适应（%+倒计时=订阅卡；金额+币种=余额卡）；
  多于 1 个实例时点击卡片 logo/名称弹出选择菜单（同名实例以自定义名称区分）
- **卡片可拖动、位置记忆**（dsh-pet 同款 pointer 拖拽）：整卡任意处按住拖动，松手自动吸附并保存位置（`right`/`bottom`，localStorage），刷新后原位恢复；拖拽超过 4px 判定为拖动，不会误触选择菜单/刷新按钮
- Host 侧 per-provider 30 秒缓存复用 + 并发去重；卡片每 30s 自动刷新
- 回环路由防护、凭证只经 DSH 凭证层解析（不落副本）、key 掩码展示

## 安装

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:loommii/dsh-provider-usage

# 或从本地源码目录安装
dsh plugin --profile web add file:/path/to/dsh-provider-usage
```

然后重启 `dsh web`。

## 版本规范（自 v0.2.0 起）

- 版本号（三段 semver）语义与递增规则：[docs/规范/版本号说明.md](docs/规范/版本号说明.md)；大/小功能在 CHANGELOG 中分类，不占版本位
- 发布流程与红线：[docs/规范/发布流程.md](docs/规范/发布流程.md)
- 安装指定版本：`dsh plugin --profile web add github:loommii/dsh-provider-usage#v0.4.0`
- 历史说明：0.1.0–0.1.7 为早期逐批递增（见 CHANGELOG.md），0.2.0 起按本规范执行

## 设置（设置 → 「用量中心」）

| 设置项 | 说明 | 生效方式 |
|---|---|---|
| 提供方（管理） | 实例清单：名称（可自定义，默认 OpenCode Go / DeepSeek 余额）、Key 引用（DSH 凭证/环境变量名）、增删改（导入的改名称，自定义的可改名称+Key）；卡片与选择菜单跟随清单 | 即时 |

- **提供方清单即"会显示什么"**：清单只有 1 项时，卡片只显示它，点击 logo/名称**不会**弹出选择菜单；
  多于 1 项时点击 logo/名称弹出菜单，同名多实例用自定义名称区分。
- 设置保存在**本机浏览器 localStorage**（`dsh-provider-usage.settings` 与 `dsh-provider-usage.providers`），改动即时生效、无需重启。
`baseUrl` / `timeoutMs` 属于 Host 配置：`cordis.patch.yml` 里的 `baseUrl` **仅覆盖 opencode-go**（历史语义），DeepSeek 使用插件内置的 `https://api.deepseek.com`。

## 密钥来源（按序）

| 提供方 | 默认引用 | DSH 设置优先 |
|---|---|---|
| opencode-go | `OPENCODE_GO_API_KEY` | `llm-pi-ai.providers['opencode-go'].apiKeyEnv` |
| deepseek-balance | `DEEPSEEK_API_KEY` | `llm-pi-ai.providers['deepseek'].apiKeyEnv` |

每级：DSH 设置声明 → DSH 凭据服务（`~/.dsh/.credentials.yaml`）→ 环境变量。

## 配置（cordis.patch.yml 插件行覆盖）

| 键 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `https://opencode.ai/zen/go` | 仅覆盖 opencode-go；实际请求 `<baseUrl>/v1/usage` |
| `timeoutMs` | `15000` | 请求超时（上限 30000），全部提供方共用 |

## 路由

- `GET /api/provider-usage/query?adapter=<id>&ref=<credentialRef>`（仅回环，403 防护；`provider=opencode-go|deepseek-balance` 旧参数兼容）
- `GET /api/provider-usage/opencode-go`（兼容旧版，等价 `query?provider=opencode-go`）
- `GET /api/provider-usage/templates`（预设清单，不含任何 secret）

## 已知限制（M2）

- 仅内置 2 个提供方（注册表可扩展；不做用户脚本引擎/声明式自定义模板，见 `方案.md`）
- 无 i18n 注册（文案固定中文；M3 补 `dsh-client-locale`）
- deepseek 需要 DeepSeek 开放平台自己的 API Key（示例 key 不通用）

参考：`docs/opencode-go-ccswitch-script.md`（cc-switch 原脚本，语义来源）；
`tmp/cc-switch-usage-query-analysis.md`、`tmp/cc-switch-integration-plan.md`（本地调研，不入仓库）。