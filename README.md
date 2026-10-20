# DSH Zhanlu Connect

把**湛卢（Zhanlu）桌面 App** 携带的模型接入 **DeepSeek Harness** —— 复用 App 已登录的网关凭据，装完即用。**支持 macOS 与 Windows**（v0.4.0 Windows 适配）。

## 功能

- **零配置**：复用湛卢 App 已登录状态，插件自身不发起任何登录流程。
- **macOS / Windows 双平台**（v0.4.0）：湛卢数据目录按平台候选列表自动解析，配置页可显式选择 mac/windows。详见下方「平台适配与选择（v0.4.0）」。
- **16 个模型**：`deepseek-v4.1-flash`、`deepseek-v4-pro`、`glm-5.3`、`glm-5.2`、`kimi-k3`、`minimax-m3`、`qwen3.7-max`、`auto` 等，在 DSH 模型选择器的「湛卢」分组下出现。
- **模型配置页**：**侧栏「插件」→ 湛卢卡片**，可勾选哪些模型出现在会话的模型选择器里，并逐个设置上下文窗口。详见下方「模型配置页」。
- **流式对话**：走标准 OpenAI 兼容 SSE，与 DSH 的流式链路一致。
- **凭据轮换即时生效**：密钥按请求解析，湛卢重新登录后无需重启 DSH。
- **离线不阻塞启动**：网关是内网服务。脱网时插件降级为本地缓存目录并给出明确错误，**DSH 启动照常完成**；网络恢复后由后台刷新自愈。
- **只读湛卢**：不写湛卢任何文件、不启动它的进程；插件自己的目录缓存与偏好写在 DSH home 下。

## 平台适配与选择（v0.4.0）

### Windows 适配了什么

- **数据目录候选解析**（`src/platform.js`）：macOS/Linux 上湛卢按 XDG 约定写 `~/.local/share/zhanlu/`；Windows 没有 XDG 约定，App 的落盘位置按以下候选**按序探测**（取第一个存在 `auth_zhanlu.json` 的）：
  1. `XDG_DATA_HOME\zhanlu`（若显式设置了 XDG）
  2. `%APPDATA%\zhanlu`（Roaming，VS Code 分支的常规数据位置）
  3. `%LOCALAPPDATA%\zhanlu`（Local）
  4. `%USERPROFILE%\AppData\Roaming\zhanlu`（APPDATA 缺失时的推导）
  5. `%USERPROFILE%\.local\share\zhanlu`（XDG 字面布局）

  都不存在时回落首选候选，错误提示仍指向具体路径。状态页展示解析到的目录与完整候选列表。
- **POSIX 权限位跳过**：登录快照存储（`$DSH_HOME/zhanlu-logins/`）的 `mode & 0o077` 检查与 `chmod` 只在有 POSIX 权限语义的平台上执行——Windows 的 mode 位是合成值（文件 0o666、目录 0o777），照搬会让已保存的登录凭据永远读不出来（v0.3.2 在 Windows 上的实际 bug）。Windows 仍保留「是普通文件、非符号链接」的安全检查。
- **路径拼接全走 `node:path`**：SQLite（`zhanlu.db`）等路径不再手拼斜杠。
- **undici cause 归类**：`fetch failed` 的真实错误码包在 `cause` 里，现在也会归类为「不可达」并给出内网指引（两个平台共同受益）。

### mac / windows 平台选择

三处可选，优先级从高到低：

1. **插件配置**（profile 的 `cordis.patch.yml`）：`platform: mac` 或 `windows` 固定，配置页选择器显示「插件配置固定」。
2. **配置页选择器**：**侧栏「插件」→ 湛卢卡片 → 账号与连通性 → 数据目录平台**，三态开关「自动 / macOS / Windows」，保存即生效（立即重拉凭据与目录，无需重启）。选择存于 `$DSH_HOME/.zhanlu-preferences.json` 的 `platform` 字段。
3. **默认 `auto`**：按 `process.platform` 检测——Windows 上自动用 Windows 候选，macOS/Linux 上自动用 XDG 布局。

`dataDir`（显式目录）优先级最高：设置后固定用该目录，平台选择不再参与。

## 双登录方式（v0.3.0）

插件页“账号与连通性”上方提供 **灵畿 / 移动云** 双态按钮，切换的是网关与对应凭据整套状态，不会修改湛卢 App 的登录。

- 灵畿：`http://rdcloud.4c.hq.cmcc/cmdevops-aiplus-agent-gateway/aigateway`（办公网/VPN）。
- 移动云：`https://ecloud.10086.cn/api/query/aigateway`。
- 首次从 App 当前登录自动保存一份加密快照。要保留另一种登录，先在 App 登录该方式，再点 **读取当前登录**，随后点相应按钮选择。不能从空白恢复历史凭据，也不会替用户重新登录/续期。
- 快照与选择存于 `$DSH_HOME/zhanlu-logins/`：目录700，文件600；凭据加密存储，密钥单独文件保存，不在工作区或分发包内。请把该目录当作敏感数据保护，勿分享。
- 手动选定的登录不会被 App 另一种登录覆盖；同方式的凭据轮换仍按请求更新。App退出后已保存快照仍可使用，是否过期以服务端认证为准。点 **连通性检测** 确认当前可用性；“已保存”不等于“认证通过”。
- 缺少凭据时明确提示，不混用其他方式的密钥。模型目录按凭据身份隔离，切换时清除旧目录/额度视图，异步旧响应不覆盖新登录。
- 未保存的模型设置需先保存再切换。仅支持这两个已核实的网关；自定义网关不再自动留档。
- 更新后须重载插件或自行重启DSH才能启用新后台路由；不会自动重启。旧的未绑定身份目录缓存不沿用；首次启动以代码内公开预置模型供宿主同步校验（不代表认证通过、已加载数为0），随后拉取当前登录目录。已有身份绑定缓存可同步恢复。代码未预置的动态新模型在首次迁移时仍须等待目录返回。

## 每日额度（v0.2.4）

选择湛卢模型时，会话输入栏的模型选择器旁显示「日」额度进度条与剩余百分比，样式及挂载插槽参照 Codex Connect。悬停或键盘聚焦可查看详情，点击可立即查询。其他 provider 不显示此条。额度条左侧另有 ⟳ 一键检测按钮（v0.3.1）：一次点击同时做连通性探测与额度强制刷新，✓绿/✗红短暂回显结果，原因/延迟/模型数在悬停提示中；双击防重。

插件设置页同时保留「查询额度」按钮、剩余/总积分、已用积分、更新时间与进度条。本地累计 token 单独标注，不作为积分余额。两处共用查询状态：首次打开查询一次，之后**每5分钟**自动查询；隐藏页面时暂停，恢复可见后按到期时间补查；最后一个视图卸载时清理计时器与请求。

数据来自 `{auth_zhanlu.json.metadata.modelBaseUrl}/gateway/api/v1/external-ide/budget-info`，复用已有AES解密凭据，仅查询预算、不调用模型、不写凭据。Host按账号和凭据指纹缓存5分钟并去重，手动查询绕过缓存。失败显示原因；同账号网络失败可保留明确标为过期的上次值，账号切换或认证失败不会返回旧账号余额。启用 `disableNetwork` 时额度查询也不联网。

源码和安装副本是分离的。更新后需让DSH重载该插件/重启桌面版；仅刷新页面不保证后台模块重载。本插件不自动重启DSH。

## 模型配置页

在 **侧栏「插件」→ DSH Zhanlu Connect** 打开。页面提供：

| 能力 | 说明 |
|---|---|
| **勾选显隐** | 每个模型一个复选框，取消勾选即从模型选择器移除。提供「全选 / 全不选」。 |
| **逐个窗口** | 每个模型旁的输入框可单独设置上下文窗口（范围 4,096 – 2,097,152）。 |
| **恢复默认** | 单个模型点「恢复窗口」，或点「全部恢复默认」清空所有覆盖。 |
| **状态摘要** | 顶部实时显示「当前显示 N / 总数」「已隐藏 N 个」「N 个模型自定义了窗口」。 |

偏好是**增量式**的：只记录你显式改过的东西（隐藏了谁、覆盖了哪个窗口），其余一律回落到内置默认。因此湛卢上架新模型时它会**自动出现**，不需要你先去「放行」。

保存后立刻生效，无需重启：插件会重建 provider 快照，模型选择器随即更新。偏好存在 `$DSH_HOME/.zhanlu-preferences.json`。

> **注意**：若把所有模型都取消勾选，湛卢分组会从模型选择器中消失（页面会提示）。重新勾选即可恢复。

### 配置页是怎么接上的

- **Host 半区**（`src/config-route.js`）注册两个端点：
  - `GET  /plugins/dsh-zhanlu-connect/config` → 全部模型 + 当前偏好 + 窗口上下限
  - `POST /plugins/dsh-zhanlu-connect/config` → 保存偏好
  GET 返回**全部**模型（含被隐藏的），否则被隐藏的项就再也勾不回来了。
- **浏览器半区**（`lib/client.js`）注册到 `plugins.bundle.config` 插槽，用 `fetch(..., { credentials: 'same-origin' })` 读写端点。
- 复选框状态**只**来自端点响应，不做乐观翻转——保存失败时它停在 host 说的地方，而不是先跳过去再弹回来。
- `webServer` 是**可选**依赖（用 `ctx.inject(['webServer'], cb)` 延迟挂载）：纯 headless 组合没有 HTTP 服务器，此时配置页端点不注册，模型功能不受影响。

## 工作原理

湛卢是 VS Code 分支，把网关凭据以 **AES-256-GCM** 密文落盘：

| 项 | 位置 |
|---|---|
| 凭据密文 | 湛卢数据目录 `auth_zhanlu.json` 的 `key` 字段（目录按平台解析，见上） |
| 主密钥 | 同目录 `.zhanlu-auth.key`（32 字节原始密钥，权限 600；Windows 无 POSIX 权限位） |
| 算法参数 | `metadata.iv`（12 字节）、`metadata.tag`（16 字节）、`cipherVersion: zhanlu-auth-v1`、**无 AAD** |
| 网关 | `state.vscdb` 的 `ecloud.zhanlu.modelBaseUrl` |

插件按湛卢自身 `zl` 里 `Dm6` 的实现解密，然后用密钥访问 OpenAI 兼容网关：

- `GET  {baseURL}/v1/models` → 模型目录
- `POST {baseURL}/v1/chat/completions` → 对话（支持 `stream: true`）

### 为什么不需要回环 shim

网关要求线上模型名带 `zhanlu/` 前缀（漏写返回 403），而 pi-ai 直接把 `Model.id` 当线上名发送。WorkBuddy Connect 为此起了一个本地回环 HTTP 服务来改写请求；本插件改用 pi-ai 自带的 `id` / `name` 二分法——**把前缀留在 `id` 里、把友好名放在 `name` 里**，因此不监听任何端口。

## 安装

需要 DSH 桌面版的 CLI（随 App 分发）：

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "file:/Users/a1234/Desktop/dsh/dsh-zhanlu"
```

装完**重启 DSH** 生效。

### 关于 desktop profile 的手工登记

`dsh plugin --profile desktop add` 在部分环境下会被 pnpm 的 `minimumReleaseAge` 策略拦住——报错指向 profile 里已存在的 `dshmarket@1.66.17`，**与本插件无关**。此时可手工完成等价的登记（本机即采用此方式，已实测生效）：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加：
   ```json
   "dsh-zhanlu-connect": "file:/Users/a1234/Desktop/dsh/dsh-zhanlu"
   ```
2. 同文件 `dsh.profile.bundles` 数组加：`"dsh-zhanlu-connect"`
3. 插件文件需出现在 `~/.dsh/profiles/desktop/node_modules/dsh-zhanlu-connect/`。

bundle 自带的 `cordis.patch.yml` 会自动注入 `llm-zhanlu` 条目，无需手改 profile 的 patch 文件。

## 自检

```bash
cd <插件目录>

# 单元测试（脱网可跑）
node --test test/

# 端到端自检：平台解析 → 数据目录 → 解密 → 网关连通性
node test/doctor.mjs

# 显式选择平台（跨机排障）
node test/doctor.mjs --platform windows
node test/doctor.mjs --platform mac
```

`doctor.mjs` 只读湛卢、不打印任何密钥内容（仅报告长度与形状），并展示数据目录候选列表与解析结果。

## 配置

在 profile 的 `cordis.patch.yml` 里按需覆盖：

```yaml
- id: llm-zhanlu
  name: dsh-zhanlu-connect
  config:
    baseUrl: http://rdcloud.4c.hq.cmcc/cmdevops-aiplus-agent-gateway/aigateway
    dataDir: ''            # 留空按平台候选解析；设置后固定用该目录
    platform: auto         # auto | mac | windows；auto 按当前系统检测
    refreshIntervalMs: 1800000
    disableNetwork: false  # true = 只读本地缓存，完全离线排障
```

## 已知限制

- **依赖内网**：网关 `rdcloud.4c.hq.cmcc` 解析到内网地址（`172.21.x`），脱网（未接办公网/VPN）时模型不可用；插件会降级而不是报错阻塞。
- **Windows 数据目录以候选探测为准**：Windows 上湛卢 App 的落盘位置无法在开发期逐台核实，插件按候选列表探测（首个存在 `auth_zhanlu.json` 的）；若 App 实际写在别处，用 `dataDir` 显式指定即可。
- **上下文容量未经验证**：网关的 `/v1/models` 只返回 id，不带上下文窗口。2026-10-12 按用户要求，全部已知模型及未知模型的默认上下文统一为 `512K`（`524288` tokens）；输出上限保持原值（未知模型为 `32K`）。这是 DSH 侧预设，不代表湛卢 App 原值或网关实际支持上限；若上游容量更小，长请求可能被拒绝或超时。
- **图片输入按实测能力注册**：随机码图片实测确认 `auto`、`deepseek-v4.1-flash`、`deepseek-v4-flash`、`glm-5.3-flash`、`kimi-k3`、`minimax-m3`、`qwen3.7-max`、`qwen3.7-plus`、`qwen3.6-plus`、`qwen3.6-35b-a3b` 支持图片输入；其余模型仍按纯文本注册。实测时间 2026-10-12，网关后续部署变更可能影响能力。
- **凭据格式耦合**：湛卢若更换 `cipherVersion` 或密钥派生方式，插件会明确报 `unsupported-cipher-version` 而不是静默失败；届时需同步更新 `src/credential.js`。
- **未验证**：`thinkingLevelMap` 声明的推理档位来自网关的 OpenAI 兼容语义，未逐档实测其对推理效果的改变。

## 免责声明

本插件读取本机湛卢 App 已登录的凭据以复用你原本就有的模型访问权。请遵守所在组织对账号与网关使用的相关规定，不要把它用于绕过任何访问控制。

## 许可证

MIT
