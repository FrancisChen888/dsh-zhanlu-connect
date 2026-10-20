/**
 * DSH 湛卢连接器 —— 浏览器半区。
 *
 * 提供插件配置页：勾选哪些模型出现在会话的模型选择器里，逐个设置
 * 上下文窗口，以及选择湛卢数据目录的平台布局（mac / windows）。
 *
 * ## 为什么是这个形状
 *
 * DSH 的客户端模块系统要求浏览器半区以 `window.__ModuleLoader__.load({id, factory})`
 * 的形式注册自己，factory 内用 `require(...)` 取 React 等共享依赖。这与
 * WorkBuddy Connect 的 client 半区完全一致——它们是同一代 DSH 内核。
 *
 * 页面注册到 `plugins.bundle.config` 插槽（以包名为键），因此它出现在
 * **侧栏「插件」→ 本插件卡片**的配置页上，而不是设置里那个只读的内置插件清单。
 *
 * ## 状态来源
 *
 * 浏览器不能直接读文件，因此所有读写都走 host 侧端点
 * `/plugins/dsh-zhanlu-connect/config`。勾选状态**只**来自该端点的响应，
 * 不做乐观翻转——保存失败时复选框应停在 host 说的地方，而不是先跳过去再弹回来。
 *
 * @module dsh-zhanlu-connect/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-zhanlu-connect',
  factory: (require) => {
    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const h = react.createElement
    const Fragment = jsxRuntime.Fragment
    const { useState, useEffect, useCallback, useRef } = react

    /** host 侧配置端点；与 src/config-route.js 的 CONFIG_PATH 保持一致。 */
    const CONFIG_PATH = '/plugins/dsh-zhanlu-connect/config'

    /** 组合包名，同时也是本半区在 loader 里的条目名与配置页的槽位键。 */
    const BUNDLE_NAME = 'dsh-zhanlu-connect'

    /** 浏览器半区的 entry 名（与 host 半区的 `llm-zhanlu` 区分开）。 */
    const name = 'dsh-zhanlu-connect-client'

    // ------------------------------------------------------------------
    // 文案
    // ------------------------------------------------------------------

    const zh = {
      title: '模型配置',
      intro: '勾选哪些模型出现在会话的模型选择器里，并可按需调整每个模型的上下文窗口。',
      loading: '正在读取模型列表…',
      loadFailed: '读取失败：{message}',
      retry: '重试',
      saving: '正在保存…',
      saved: '已保存',
      saveFailed: '保存失败：{message}',
      save: '保存',
      resetContext: '恢复默认窗口',
      resetAll: '全部恢复默认',
      visibleSummary: '当前显示 {visible} / {total} 个模型',
      hiddenSummary: '已隐藏 {count} 个',
      overrideSummary: '{count} 个模型自定义了窗口',
      colModel: '模型',
      colContext: '上下文窗口',
      colVisible: '在选择器中显示',
      contextHint: '窗口范围 {min} – {max}；留空表示使用默认值 {default}。',
      defaultLabel: '默认 {value}',
      overrideBadge: '已自定义',
      reasoningBadge: '推理',
      imageInputBadge: '文本 + 图片',
      textInputBadge: '仅文本',
      selectAll: '全选',
      selectNone: '全不选',
      invalidValue: '请输入 {min} – {max} 之间的整数',
      noModels: '湛卢网关尚未返回任何模型。请确认已接入办公网，然后点「重试」。',
      emptySelection: '当前未选中任何模型，湛卢分组将从模型选择器中消失。',
      quotaTitle: '每日额度',
      quotaLoading: '查询中…',
      quotaUnavailable: '额度暂不可用',
      quotaRefresh: '查询额度',
      quotaShort: '日',
      quotaRemainingLine: '剩余 {percent}%（{remaining} / {total} 积分）',
      quotaSpent: '已用 {spent} 积分',
      quotaTokens: '本地累计 token（独立统计）：{usedTotal}',
      quotaSchedule: '每5分钟自动查询；页面隐藏时暂停',
      quotaUpdated: '更新于 {time}',
      quotaStale: '上次数据（已过期），本次查询失败',
      quotaRetryHint: '点击重试查询',
      inputCheck: '检测并刷新湛卢状态',
      inputCheckShort: '检测',
      inputChecking: '检测中…',
      inputCheckOk: '连通正常（{latency}ms，{count} 个模型）',
      inputCheckFail: '检测失败：{message}',
      statusSectionTitle: '账号与连通性',
      loginTitle: '登录方式', loginCapture: '读取当前登录', loginBusy: '处理中…',
      loginActive: '当前使用', loginSwitching: '正在切换登录方式…', loginCapturing: '正在读取凭据…',
      loginCaptured: '凭据已保存，当前使用的登录方式未改变。需要切换时，请点击上方开关。',
      loginSelected: '已切换至{label}，可点击“连通性检测”确认可用性。',
      loginReadHint: '读取只保存 App 当前凭据，不会自动切换。',
      loginMissing: '未保存凭据', loginSaved: '已保存（有效性待检测）', loginFailed: '登录切换失败：{message}',
      loginHint: '两种登录分别保存凭据；此按钮不代替湛卢 App 登录，不改动 App 文件。',
      loginUnsaved: '请先保存模型设置，再切换登录方式。',
      statusGatewaySourceLogin: '所选登录方式',
      statusLightOk: '正常',
      statusLightUnreachable: '网关不可达',
      statusLightCredential: '凭据未就绪',
      statusLightNoModels: '无可用模型',
      statusLightChecking: '检测中',
      statusLightUnknown: '状态未知',
      statusAccount: '账号',
      statusAccountUnknown: '未读取到账号信息',
      statusGateway: '网关地址',
      statusGatewaySourceCredential: '凭据自带',
      statusGatewaySourceConfig: '插件配置',
      statusGatewaySourceDefault: '默认兜底',
      statusModels: '已加载模型',
      statusCredentialMissing: '凭据未就绪',
      statusRefresh: '刷新模型',
      statusCheckAccount: '检测账号状态',
      statusCheckConnectivity: '连通性检测',
      statusChecking: '检测中…',
      statusRefreshOk: '已刷新：{count} 个模型',
      statusAccountOk: '账号正常：{name}',
      statusConnectivityOk: '连通正常（{latency}ms，{count} 个模型）',
      statusCheckFailed: '检测失败：{message}',
      statusUnreachable: '网关不可达（内网地址需办公网/VPN）',
      platformTitle: '数据目录平台',
      platformAuto: '自动',
      platformMac: 'macOS',
      platformWindows: 'Windows',
      platformHint: '湛卢 App 数据目录按此平台布局解析；当前解析到：{dir}',
      platformEffective: '当前生效：{platform}（{source}）',
      platformUnsaved: '请先保存模型设置，再切换平台。',
      platformPinned: '平台已在插件配置中固定为 {value}；此选择将在配置恢复「自动」后生效。',
      platformSwitching: '正在切换数据目录平台…',
      platformSwitchFailed: '平台切换失败：{message}',
      statusDataDir: '数据目录',
      platformSourceConfig: '插件配置固定',
      platformSourcePreference: '手动选择',
      platformSourceAuto: '按系统检测',
    }

    const en = {
      title: 'Model settings',
      intro: 'Choose which models appear in the conversation model picker, and tune each model’s context window.',
      loading: 'Loading models…',
      loadFailed: 'Load failed: {message}',
      retry: 'Retry',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Save failed: {message}',
      save: 'Save',
      resetContext: 'Reset window',
      resetAll: 'Reset all',
      visibleSummary: 'Showing {visible} of {total} models',
      hiddenSummary: '{count} hidden',
      overrideSummary: '{count} with custom window',
      colModel: 'Model',
      colContext: 'Context window',
      colVisible: 'Show in picker',
      contextHint: 'Range {min} – {max}; empty means the default {default}.',
      defaultLabel: 'default {value}',
      overrideBadge: 'custom',
      reasoningBadge: 'reasoning',
      imageInputBadge: 'Text + image',
      textInputBadge: 'Text only',
      selectAll: 'Select all',
      selectNone: 'Select none',
      invalidValue: 'Enter an integer between {min} and {max}',
      noModels: 'The Zhanlu gateway has not returned any models yet. Check your network and press Retry.',
      emptySelection: 'No model is selected; the Zhanlu group will disappear from the model picker.',
      quotaTitle: 'Daily quota',
      quotaLoading: 'Checking…',
      quotaUnavailable: 'Quota unavailable',
      quotaRefresh: 'Check quota',
      quotaShort: 'Day',
      quotaRemainingLine: '{percent}% remaining ({remaining} / {total} credits)',
      quotaSpent: '{spent} credits used',
      quotaTokens: 'Local cumulative tokens (separate metric): {usedTotal}',
      quotaSchedule: 'Refreshes every 5 minutes; pauses while the page is hidden',
      quotaUpdated: 'Updated {time}',
      quotaStale: 'Last known data (stale); the latest query failed',
      quotaRetryHint: 'Click to retry',
      inputCheck: 'Check Zhanlu status and refresh',
      inputCheckShort: 'Check',
      inputChecking: 'Checking…',
      inputCheckOk: 'Connected ({latency}ms, {count} models)',
      inputCheckFail: 'Check failed: {message}',
      statusSectionTitle: 'Account & connectivity',
      loginTitle: 'Login method', loginCapture: 'Read current login', loginBusy: 'Working…',
      loginActive: 'In use', loginSwitching: 'Switching login method…', loginCapturing: 'Reading credentials…',
      loginCaptured: 'Credentials saved; the active login is unchanged. Use the switch above to change it.',
      loginSelected: 'Switched to {label}. Use Test connectivity to verify access.',
      loginReadHint: 'Reading saves the current App credentials; it does not switch logins.',
      loginMissing: 'No saved credential', loginSaved: 'Saved (validation required)', loginFailed: 'Login switch failed: {message}',
      loginHint: 'Credentials are saved separately. This does not sign in or modify the Zhanlu app.',
      loginUnsaved: 'Save model settings before switching login.',
      statusGatewaySourceLogin: 'Selected login method',
      statusLightOk: 'Healthy',
      statusLightUnreachable: 'Gateway unreachable',
      statusLightCredential: 'Credential not ready',
      statusLightNoModels: 'No models',
      statusLightChecking: 'Checking',
      statusLightUnknown: 'Unknown',
      statusAccount: 'Account',
      statusAccountUnknown: 'No account info yet',
      statusGateway: 'Gateway',
      statusGatewaySourceCredential: 'from credential',
      statusGatewaySourceConfig: 'from config',
      statusGatewaySourceDefault: 'default fallback',
      statusModels: 'Models loaded',
      statusCredentialMissing: 'credential not ready',
      statusRefresh: 'Refresh models',
      statusCheckAccount: 'Check account',
      statusCheckConnectivity: 'Test connectivity',
      statusChecking: 'Checking…',
      statusRefreshOk: 'Refreshed: {count} models',
      statusAccountOk: 'Account OK: {name}',
      statusConnectivityOk: 'Connected ({latency}ms, {count} models)',
      statusCheckFailed: 'Check failed: {message}',
      statusUnreachable: 'Gateway unreachable (intranet address needs office network/VPN)',
      platformTitle: 'Data directory platform',
      platformAuto: 'Auto',
      platformMac: 'macOS',
      platformWindows: 'Windows',
      platformHint: 'The Zhanlu app data directory is resolved with this platform layout; currently: {dir}',
      platformEffective: 'In effect: {platform} ({source})',
      platformUnsaved: 'Save model settings before switching platform.',
      platformPinned: 'Platform is pinned to {value} in the plugin config; this choice applies when the config returns to Auto.',
      platformSwitching: 'Switching data directory platform…',
      platformSwitchFailed: 'Platform switch failed: {message}',
      statusDataDir: 'Data directory',
      platformSourceConfig: 'pinned in plugin config',
      platformSourcePreference: 'manual selection',
      platformSourceAuto: 'detected from system',
    }

    /**
     * 极简插值：把 `{name}` 替换成参数。
     *
     * 不引入 i18n 库——本页只有十几条文案，字典加一个 replace 就够，
     * 少一个依赖就少一处版本冲突。
     *
     * @param {string} template
     * @param {Record<string, string | number>} [params]
     * @returns {string}
     */
    function format(template, params = {}) {
      return template.replace(/\{(\w+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
      )
    }

    /** 按当前语言取文案。宿主未提供语言时默认中文。 */
    function useCopy() {
      const [lang, setLang] = useState(
        typeof document !== 'undefined' && /^en\b/i.test(document.documentElement.lang ?? '') ? 'en' : 'zh',
      )
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const observer = new MutationObserver(() => {
          setLang(/^en\b/i.test(document.documentElement.lang ?? '') ? 'en' : 'zh')
        })
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        return () => observer.disconnect()
      }, [])
      const dict = lang === 'en' ? en : zh
      return useCallback((key, params) => format(dict[key] ?? key, params), [dict])
    }

    // ------------------------------------------------------------------
    // 样式（全部内联，避免依赖宿主的样式表）
    // ------------------------------------------------------------------

    const pageStyle = { display: 'grid', gap: 16, padding: '4px 2px 24px' }
    const introStyle = {
      margin: 0,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const summaryStyle = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 10,
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)',
    }
    const chipStyle = {
      padding: '2px 8px',
      borderRadius: 999,
      background: 'var(--dsw-alias-bg-secondary)',
      fontSize: 12,
    }
    const toolbarStyle = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }
    const buttonStyle = {
      padding: '6px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-secondary)',
      background: 'var(--dsw-alias-bg-primary)',
      color: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    }
    const primaryButtonStyle = {
      ...buttonStyle,
      background: 'var(--dsw-alias-bg-inverse, #262626)',
      color: 'var(--dsw-alias-label-inverse, #fff)',
      borderColor: 'transparent',
    }
    const listStyle = {
      display: 'grid',
      gap: 0,
      border: '1px solid var(--dsw-alias-border-secondary)',
      borderRadius: 10,
      overflow: 'hidden',
    }
    const rowStyle = {
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) auto',
      gap: 12,
      alignItems: 'center',
      padding: '10px 12px',
      borderTop: '1px solid var(--dsw-alias-border-secondary)',
    }
    const firstRowStyle = { ...rowStyle, borderTop: 'none' }
    const modelMainStyle = { display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }
    const modelNameStyle = {
      fontSize: 13,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const modelIdStyle = {
      fontSize: 11,
      color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const inputStyle = {
      width: 110,
      padding: '5px 8px',
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border-secondary)',
      background: 'var(--dsw-alias-bg-primary)',
      color: 'inherit',
      fontSize: 13,
      textAlign: 'right',
    }
    const errorInputStyle = { ...inputStyle, borderColor: 'var(--dsw-alias-label-error, #d33)' }
    const noticeStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const errorStyle = { ...noticeStyle, color: 'var(--dsw-alias-label-error, #d33)' }
    /** 账号/连通性分区外框。 */
    const sectionStyle = {
      display: 'grid',
      gap: 10,
      padding: '12px 14px',
      border: '1px solid var(--dsw-alias-line, rgba(0,0,0,.1))',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-secondary, rgba(0,0,0,.02))',
    }
    const sectionTitleStyle = {
      margin: 0,
      fontSize: 13,
      fontWeight: 600,
      color: 'var(--dsw-alias-label)',
    }
    const kvRowStyle = { display: 'flex', gap: 8, alignItems: 'baseline' }
    const kvKeyStyle = {
      flex: '0 0 auto',
      minWidth: 56,
      color: 'var(--dsw-alias-label-secondary)',
    }
    const kvValueStyle = {
      flex: '1 1 auto',
      color: 'var(--dsw-alias-label)',
      wordBreak: 'break-all',
    }
    const badgeStyle = {
      padding: '1px 7px',
      borderRadius: 999,
      background: 'var(--dsw-alias-bg-secondary)',
      fontSize: 11,
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'nowrap',
    }

    // ------------------------------------------------------------------
    // 数据访问
    // ------------------------------------------------------------------

    /**
     * 读取配置端点。
     *
     * @param {AbortSignal} [signal]
     * @returns {Promise<object>}
     */
    async function readConfig(signal) {
      const response = await fetch(CONFIG_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    const QUOTA_REFRESH_MS = 300000
    const QUOTA_PATH = '/plugins/dsh-zhanlu-connect/quota'

    function validQuota(q) {
      return q?.source === 'gateway' && [q.percent, q.remaining, q.total, q.spent, q.updatedAt].every(Number.isFinite)
        && q.percent >= 0 && q.percent <= 100 && q.remaining >= 0 && q.remaining <= q.total && q.total >= 0
    }

    /** 一个页面模块只拥有一条计时器；设置页与所有湛卢会话共享状态。 */
    function createQuotaStore(options = {}) {
      const doc = options.document ?? document
      const clock = options.now ?? Date.now
      const later = options.setTimeout ?? window.setTimeout.bind(window)
      const cancel = options.clearTimeout ?? window.clearTimeout.bind(window)
      const request = options.fetch ?? fetch
      const listeners = new Set()
      let snapshot = { status: 'loading', data: null, loading: false }
      let nextAt = 0, timer, pending, controller, generation = 0
      function publish(next) { snapshot = next; for (const listener of listeners) listener(snapshot) }
      function schedule() {
        cancel(timer); timer = undefined
        if (!listeners.size || doc.hidden || pending) return
        timer = later(() => void refresh(false), Math.max(0, nextAt - clock()))
      }
      function refresh(force = false) {
        if (pending) return pending
        if (!force && (doc.hidden || clock() < nextAt)) { schedule(); return Promise.resolve() }
        const revision = ++generation
        controller = new AbortController()
        const active = controller
        publish({ ...snapshot, loading: true })
        pending = Promise.resolve().then(async () => {
          try {
            const response = await request(QUOTA_PATH + (force ? '?force=1' : ''), {
              headers: { accept: 'application/json' }, credentials: 'same-origin',
              signal: AbortSignal.any([active.signal, AbortSignal.timeout(12000)]),
            })
            const value = response.ok ? await response.json() : null
            if (revision !== generation) return
            if (validQuota(value)) publish({ status: value.stale ? 'stale' : 'ready', data: value, loading: false })
            else publish({ status: 'error', data: null, loading: false, message: value?.message })
          } catch {
            if (revision === generation) publish({ status: 'error', data: null, loading: false })
          } finally {
            if (revision === generation) { pending = undefined; nextAt = clock() + QUOTA_REFRESH_MS; schedule() }
          }
        })
        return pending
      }
      function stop() {
        ++generation; cancel(timer); timer = undefined
        controller?.abort(); pending = undefined
        // 无视图期间可能换账号/退出登录。重挂载先查身份，不能沿用旧余额。
        nextAt = 0
        snapshot = { status: 'loading', data: null, loading: false }
      }
      return {
        getSnapshot: () => snapshot, refresh,
        reset() { stop(); publish({ status: 'loading', data: null, loading: false }); },
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) { doc.addEventListener('visibilitychange', schedule); schedule() }
          return () => {
            listeners.delete(listener)
            if (!listeners.size) { doc.removeEventListener('visibilitychange', schedule); stop() }
          }
        },
        dispose() { listeners.clear(); doc.removeEventListener('visibilitychange', schedule); stop() },
      }
    }
    const quotaStore = createQuotaStore()

    function useQuota(enabled = true) {
      return react.useSyncExternalStore(
        useCallback((listener) => enabled ? quotaStore.subscribe(listener) : () => {}, [enabled]),
        quotaStore.getSnapshot, quotaStore.getSnapshot,
      )
    }
    const number = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
    function quotaColor(percent) {
      return percent >= 60 ? 'var(--dsw-alias-state-success-primary, #22c55e)'
        : percent >= 40 ? 'var(--dsw-alias-state-warn-primary, #eab308)'
        : percent >= 20 ? '#f97316' : 'var(--dsw-alias-state-error-primary, #ef4444)'
    }
    function quotaSummary(state, t) {
      if (!state.data) return t(state.loading || state.status === 'loading' ? 'quotaLoading' : 'quotaUnavailable')
      const q = state.data
      return t('quotaRemainingLine', { percent: q.percent, remaining: number(q.remaining), total: number(q.total) })
        + (state.status === 'stale' ? ` · ${t('quotaStale')}` : '')
    }
    function QuotaMeter({ data, t, compact = false, stale = false }) {
      return h('span', {
        role: 'progressbar', 'aria-label': t('quotaTitle'), 'aria-valuemin': 0, 'aria-valuemax': 100,
        'aria-valuenow': data.percent, 'aria-valuetext': `${data.percent}%`,
        'data-zhanlu-quota-track': true,
        style: { display: 'block', width: compact ? 48 : '100%', height: compact ? 6 : 8,
          borderRadius: 999, background: 'var(--dsw-alias-border-l2, #e5e7eb)', overflow: 'hidden', opacity: stale ? 0.5 : 1 },
      }, h('span', { 'data-zhanlu-quota-progress': true,
        style: { display: 'block', height: '100%', width: `${data.percent}%`, background: quotaColor(data.percent), borderRadius: 'inherit' } }))
    }
    function ZhanluQuotaPanel() {
      const t = useCopy(), state = useQuota(), q = state.data
      return h('section', { 'data-zhanlu-quota-panel': true, 'aria-label': t('quotaTitle'),
        style: { padding: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, display: 'grid', gap: 8 } },
        h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' } },
          h('strong', null, t('quotaTitle')),
          h('button', { type: 'button', style: buttonStyle, disabled: state.loading,
            onClick: () => void quotaStore.refresh(true) }, t(state.loading ? 'quotaLoading' : 'quotaRefresh'))),
        h('span', { role: 'status', style: noticeStyle }, quotaSummary(state, t)),
        q ? h(QuotaMeter, { data: q, t, stale: state.status === 'stale' }) : null,
        q ? h('span', { style: noticeStyle }, t('quotaSpent', { spent: number(q.spent) })) : null,
        state.status === 'error' || state.status === 'stale' ? h('span', { style: errorStyle }, q?.message ?? state.message ?? t('quotaRetryHint')) : null,
        q ? h('span', { style: noticeStyle }, t('quotaUpdated', { time: new Date(q.updatedAt).toLocaleString() })) : null,
        q?.used?.available ? h('span', { style: noticeStyle }, t('quotaTokens', { usedTotal: number(q.used.usedTotal) })) : null,
        h('span', { style: noticeStyle }, t('quotaSchedule')))
    }
    function isZhanluDirectory(state) { return state?.status === 'ready' && state.current?.provider === 'zhanlu' }
    function ZhanluQuotaIndicator({ directory }) {
      const t = useCopy()
      const model = react.useSyncExternalStore(useCallback((listener) => directory.subscribe(listener), [directory]),
        () => directory.getSnapshot(), () => directory.getSnapshot())
      const eligible = isZhanluDirectory(model), state = useQuota(eligible)
      const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false)
      const [check, setCheck] = useState(null) // null | { phase: 'busy' | 'ok' | 'fail', text?: string }
      const checkTimer = useRef(null)
      const tooltipId = react.useId()
      useEffect(() => () => { if (checkTimer.current) window.clearTimeout(checkTimer.current) }, [])
      /** 一键检测：连通性探测 + 强制刷新额度；额度刷新内部自兜底，不会连带 reject。 */
      async function runInputCheck() {
        if (check?.phase === 'busy') return
        setCheck({ phase: 'busy' })
        try {
          const [result] = await Promise.all([postStatusAction('connectivity'), quotaStore.refresh(true)])
          setCheck(result?.ok === true
            ? { phase: 'ok', text: t('inputCheckOk', { latency: result.probe?.latencyMs ?? '?', count: result.probe?.modelCount ?? result.status?.modelCount ?? 0 }) }
            : { phase: 'fail', text: result?.probe?.reason ?? result?.message ?? t('quotaUnavailable') })
        } catch (error) {
          setCheck({ phase: 'fail', text: error instanceof Error ? error.message : String(error) })
        }
        if (checkTimer.current) window.clearTimeout(checkTimer.current)
        checkTimer.current = window.setTimeout(() => setCheck(null), 4000)
      }
      if (!eligible) return null
      const summary = quotaSummary(state, t)
      const detail = summary + (state.data ? ` · ${t('quotaUpdated', { time: new Date(state.data.updatedAt).toLocaleTimeString() })}` : '')
        + ` · ${t('quotaSchedule')} · ${t('quotaRetryHint')}`
      const tooltipVisible = hovered || focused
      const checkLabel = check?.phase === 'busy' ? t('inputChecking')
        : check?.phase === 'fail' ? t('inputCheckFail', { message: check.text }) : check?.text ?? t('inputCheck')
      const checkButton = h('button', { type: 'button', 'data-zhanlu-check': check?.phase ?? 'idle',
        'aria-label': check?.phase === 'busy' ? t('inputChecking') : checkLabel, title: checkLabel,
        disabled: check?.phase === 'busy', onClick: () => void runInputCheck(),
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 2, minWidth: 40, minHeight: 24,
          flexShrink: 0, padding: '0 6px', fontSize: 11, fontWeight: 500,
          border: check?.phase === 'ok' || check?.phase === 'fail' ? '1px solid transparent'
            : '1px solid var(--dsw-alias-border-l2, #e5e7eb)', borderRadius: 6,
          background: check?.phase === 'ok' ? 'var(--dsw-alias-state-success-primary, #22c55e)'
            : check?.phase === 'fail' ? 'var(--dsw-alias-state-error-primary, #ef4444)'
            : 'transparent',
          cursor: check?.phase === 'busy' ? 'wait' : 'pointer',
          color: check?.phase === 'ok' || check?.phase === 'fail' ? '#fff' : 'var(--dsw-alias-label-secondary)' } },
        check?.phase === 'busy' ? '…'
          : check?.phase === 'ok' ? '✓'
          : check?.phase === 'fail' ? '✗'
          : `⟳ ${t('inputCheckShort')}`)
      return h('span', { 'data-zhanlu-indicator': true, style: { display: 'inline-flex', alignItems: 'center', gap: 2 } }, checkButton,
      h('button', { type: 'button', 'data-zhanlu-quota': state.status, title: detail, 'aria-label': detail,
        'aria-describedby': tooltipVisible ? tooltipId : undefined,
        onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false),
        onFocus: () => setFocused(true), onBlur: () => setFocused(false),
        disabled: state.loading, onClick: () => void quotaStore.refresh(true),
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, width: 104, minHeight: 28,
          position: 'relative', flexShrink: 0, padding: 0, border: 0, background: 'transparent', cursor: state.loading ? 'wait' : 'pointer',
          color: 'var(--dsw-alias-label-secondary)', fontSize: 10 } },
        state.data ? h(Fragment, null, h('span', null, t('quotaShort')),
          h(QuotaMeter, { data: state.data, t, compact: true, stale: state.status === 'stale' }),
          h('span', null, `${state.data.percent}%${state.status === 'stale' ? '*' : ''}`))
          : h('span', { role: 'status' }, summary),
        tooltipVisible ? h('span', { id: tooltipId, role: 'tooltip', 'data-zhanlu-quota-tooltip': true,
          style: { position: 'absolute', bottom: 'calc(100% + 6px)', right: 0, zIndex: 1000, width: 240,
            whiteSpace: 'normal', pointerEvents: 'none', padding: '6px 8px', borderRadius: 6, textAlign: 'left',
            background: 'var(--dsw-alias-bg-primary, #fff)', color: 'var(--dsw-alias-label-primary, #111)',
            boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgb(0 0 0 / 15%))', fontSize: 12, lineHeight: '18px' } }, detail) : null))
    }

    /** 读取状态端点（账号 + 网关 + 目录快照）。 */
    async function readStatus(signal) {
      const response = await fetch('/plugins/dsh-zhanlu-connect/status', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /**
     * 触发一次主动检测：refresh / account / connectivity。
     *
     * @param {'refresh' | 'account' | 'connectivity'} action
     * @param {AbortSignal} [signal]
     * @returns {Promise<object>}
     */
    async function postStatusAction(action, signal) {
      const response = await fetch('/plugins/dsh-zhanlu-connect/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action }),
        ...(signal === undefined ? {} : { signal }),
      })
      const value = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new Error(value?.message ?? `HTTP ${response.status}`)
      }
      return value
    }

    /**
     * 保存偏好到配置端点。
     *
     * @param {{ hiddenModels: string[], contextOverrides: Record<string, number> }} payload
     * @param {AbortSignal} [signal]
     * @returns {Promise<object>}
     */
    async function writeConfig(payload, signal) {
      const response = await fetch(CONFIG_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
      })
      const value = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new Error(value?.message ?? `HTTP ${response.status}`)
      }
      return value
    }

    // ------------------------------------------------------------------
    // 页面
    // ------------------------------------------------------------------

    /**
     * 插件配置页。
     *
     * @param {{ view?: 'page' | 'summary' }} props
     */
    function ZhanluConfigPage({ view }) {
      const t = useCopy()
      const [state, setState] = useState(/** @type {{ status: 'loading' | 'ready' | 'error', data?: object, error?: string }} */ ({ status: 'loading' }))
      const [hidden, setHidden] = useState(/** @type {Set<string>} */ (new Set()))
      const [overrides, setOverrides] = useState(/** @type {Record<string, number>} */ ({}))
      /** 输入框里的草稿文本：用户可能正在输入一个暂时非法的值。 */
      const [drafts, setDrafts] = useState(/** @type {Record<string, string>} */ ({}))
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(/** @type {{ kind: 'ok' | 'error', text: string } | undefined} */ (undefined))
      /** 账号与连通性状态快照。 */
      const [statusInfo, setStatusInfo] = useState(/** @type {null | { baseUrl?: string, baseUrlSource?: string, reachable?: boolean, modelCount?: number, reason?: string, unreachable?: boolean, credentialLoaded?: boolean, identityLoaded?: boolean, account?: Record<string, string | undefined> }} */ (null))
      /** 正在执行的主动检测动作；null 表示空闲。 */
      const [checking, setChecking] = useState(/** @type {null | 'refresh' | 'account' | 'connectivity'} */ (null))
      /** 最近一次检测的结果文案（成功或失败），由按钮触发。 */
      const [checkNotice, setCheckNotice] = useState(/** @type {null | { kind: 'ok' | 'error', text: string }} */ (null))
      const mounted = useRef(true)
      const readSeq = useRef(0)
      const loginPending = useRef(false)
      const loginRevision = useRef(0)
      const [loginInfo, setLoginInfo] = useState(null)
      const [loginNotice, setLoginNotice] = useState(null)
      const [loginAction, setLoginAction] = useState(null)
      /** 数据目录平台选择（v0.4.0：auto | mac | windows）；来自配置端点，保存后生效。 */
      const [platformSelection, setPlatformSelection] = useState('auto')
      /** 平台切换的提示文案（模型设置未保存/被插件配置固定等）。 */
      const [platformNotice, setPlatformNotice] = useState(null)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      /** 拉取一次配置，并把它铺进本地编辑态。 */
      const load = useCallback(async () => {
        const seq = ++readSeq.current
        const current = () => mounted.current && seq === readSeq.current
        setState({ status: 'loading' })
        try {
          const controller = new AbortController()
          const data = await readConfig(controller.signal)
          if (!current()) return
          setHidden(new Set(data.models.filter((m) => m.hidden).map((m) => m.id)))
          const nextOverrides = {}
          for (const model of data.models) {
            if (model.overridden) nextOverrides[model.id] = model.contextWindow
          }
          setOverrides(nextOverrides)
          setDrafts({})
          setPlatformSelection(data.platform === 'mac' || data.platform === 'windows' || data.platform === 'auto' ? data.platform : 'auto')
          setState({ status: 'ready', data })
        } catch (error) {
          if (!current()) return
          setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      useEffect(() => {
        const controller = new AbortController()
        const revision = loginRevision.current
        fetch('/plugins/dsh-zhanlu-connect/login', { credentials: 'same-origin', signal: controller.signal })
          .then(async (r) => { const value = await r.json(); if (!r.ok) throw new Error(value.message); return value })
          .then((value) => { if (mounted.current && revision === loginRevision.current) setLoginInfo(value) })
          .catch(() => { if (mounted.current && revision === loginRevision.current && !controller.signal.aborted) setLoginNotice(t('loginMissing')) })
        return () => controller.abort()
      }, [])

      async function changeLogin(mode) {
        if (loginPending.current || checking !== null) return
        loginPending.current = true
        ++loginRevision.current
        setChecking('login'); setLoginAction(mode ?? 'capture'); setLoginNotice(null); setCheckNotice(null)
        quotaStore.reset()
        try {
          const response = await fetch('/plugins/dsh-zhanlu-connect/login', {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(mode ? { action: 'select', mode } : { action: 'capture' }),
          })
          const value = await response.json()
          if (!response.ok) throw new Error(value.message ?? `HTTP ${response.status}`)
          if (!mounted.current) return
          setLoginInfo(value)
          setLoginNotice(mode ? t('loginSelected', { label: value.modes?.find((m) => m.id === value.active)?.label ?? mode }) : t('loginCaptured'))
          const status = await readStatus()
          if (mounted.current) setStatusInfo(status?.status ?? null)
          await load()
        } catch (error) {
          if (mounted.current) setLoginNotice(t('loginFailed', { message: error instanceof Error ? error.message : String(error) }))
        } finally {
          loginPending.current = false
          if (mounted.current) { setChecking(null); setLoginAction(null) }
          void quotaStore.refresh(true)
        }
      }

      function renderLoginSwitch() {
        const configured = state.data?.models ?? []
        const dirty = state.status === 'ready' && (Object.keys(drafts).length > 0 || configured.some((m) =>
          hidden.has(m.id) !== m.hidden || (overrides[m.id] ?? m.defaultContextWindow) !== m.contextWindow))
        const busy = checking !== null || saving || dirty || !loginInfo
        return h('div', { 'data-zhanlu-login-switch': '', style: { display: 'grid', gap: 10, minWidth: 0 } },
          h('style', null,
            '[data-zhanlu-login-option]:focus-visible{outline:2px solid #2563eb!important;outline-offset:3px}' +
            '[data-zhanlu-login-option][aria-pressed="false"]:not(:disabled):hover{background:rgba(37,99,235,.08)!important}'),
          h('span', { style: { ...kvKeyStyle, fontWeight: 600 } }, t('loginTitle')),
          h('div', { role: 'group', 'aria-label': t('loginTitle'), 'aria-busy': checking === 'login',
            style: { display: 'flex', gap: 4, padding: 4, border: '1px solid var(--dsw-alias-border-secondary, #d1d5db)',
              borderRadius: 12, background: 'var(--dsw-alias-bg-secondary, #f1f3f5)', width: 'min(100%, 360px)', boxSizing: 'border-box' } },
            ...(loginInfo?.modes ?? [{ id: 'lingji', label: '灵畿' }, { id: 'ecloud', label: '移动云' }]).map((mode) => {
              const active = loginInfo?.active === mode.id
              return h('button', { key: mode.id, type: 'button', 'data-zhanlu-login-option': mode.id,
                style: { appearance: 'none', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 6,
                  flex: '1 1 0', minWidth: 0, minHeight: 44, padding: '10px 12px', borderRadius: 8,
                  border: active ? '1px solid #2563eb' : '1px solid transparent',
                  background: active ? '#2563eb' : 'transparent', color: active ? '#fff' : 'var(--dsw-alias-label-primary, #1f2937)',
                  font: 'inherit', fontSize: 14, fontWeight: active ? 600 : 500,
                  boxShadow: active ? '0 1px 4px rgba(37,99,235,.2)' : 'none',
                  cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.65 : 1 },
                'aria-pressed': active, disabled: busy,
                title: mode.saved ? t('loginSaved') : t('loginMissing'),
                onClick: () => void changeLogin(mode.id) },
                active ? h('span', { 'aria-hidden': true }, '✓') : null,
                h('span', { style: { whiteSpace: 'nowrap' } }, mode.label),
                active ? h('span', { style: { fontSize: 10, lineHeight: '16px', padding: '0 4px', borderRadius: 4,
                  background: 'rgba(255,255,255,.2)', whiteSpace: 'nowrap' } }, t('loginActive')) : null)
            })),
          checking === 'login' ? h('span', { role: 'status', style: noticeStyle }, t(loginAction === 'capture' ? 'loginCapturing' : 'loginSwitching')) : null,
          h('span', { style: noticeStyle }, (loginInfo?.modes ?? []).map((m) => `${m.label}：${t(m.saved ? 'loginSaved' : 'loginMissing')}`).join(' · ')),
          h('div', { style: { ...toolbarStyle, gap: 10 } },
            h('button', { type: 'button', style: { ...buttonStyle, minHeight: 36,
                border: '1px solid var(--dsw-alias-border-secondary, #d1d5db)', background: 'var(--dsw-alias-bg-primary, #fff)' },
              disabled: checking !== null || saving || dirty,
              onClick: () => void changeLogin(null) }, t(loginAction === 'capture' ? 'loginBusy' : 'loginCapture')),
            h('span', { style: { ...noticeStyle, fontSize: 12 } }, t('loginReadHint'))),
          h('span', { style: noticeStyle }, dirty ? t('loginUnsaved') : t('loginHint')),
          loginNotice ? h('span', { role: 'status', style: noticeStyle }, loginNotice) : null)
      }

      // 账号状态与config并行；额度由独立共享store管理，不随模型列表重载。
      // 状态快照由宿主后台刷新（失败后 60s 重试），页面可见时定期重读，
      // 网关恢复后红灯能自己转绿，而不是停在下一次打开的旧快照上。
      useEffect(() => {
        const controller = new AbortController()
        const revision = loginRevision.current
        let timer
        const pull = () => {
          readStatus(controller.signal)
            .then((data) => {
              if (mounted.current && revision === loginRevision.current) setStatusInfo(data?.status ?? null)
            })
            .catch(() => {
              // 状态端点失败不阻塞页面：账号区显示"未读取到"即可。
            })
        }
        const tick = () => {
          if (document.visibilityState !== 'hidden') pull()
          timer = window.setTimeout(tick, 20000)
        }
        pull()
        timer = window.setTimeout(tick, 20000)
        return () => { window.clearTimeout(timer); controller.abort() }
      }, [])

      /**
       * 执行一次主动检测，并把结果显示在检测按钮下方。
       *
       * @param {'refresh' | 'account' | 'connectivity'} action
       */
      async function runCheck(action) {
        if (loginPending.current) return
        const revision = loginRevision.current
        setChecking(action)
        setCheckNotice(null)
        try {
          const result = await postStatusAction(action)
          if (!mounted.current || revision !== loginRevision.current) return
          if (result?.status !== undefined) setStatusInfo(result.status)
          if (result.ok === false) {
            const unreachable = result.probe?.unreachable === true || result.status?.unreachable === true
            setCheckNotice({
              kind: 'error',
              text: unreachable
                ? t('statusUnreachable')
                : t('statusCheckFailed', {
                    message: result.message ?? result.probe?.reason ?? result.status?.reason ?? '未知原因',
                  }),
            })
            return
          }
          if (action === 'refresh') {
            const count = result.status?.modelCount ?? 0
            setCheckNotice({ kind: 'ok', text: t('statusRefreshOk', { count }) })
            // 目录可能变了，重新拉一次配置让勾选列表同步。
            void load()
          } else if (action === 'account') {
            const name = result.identity?.userName ?? result.status?.account?.userName
            setCheckNotice({
              kind: 'ok',
              text: name ? t('statusAccountOk', { name }) : t('statusAccountUnknown'),
            })
          } else {
            setCheckNotice({
              kind: 'ok',
              text: t('statusConnectivityOk', {
                latency: result.probe?.latencyMs ?? '?',
                count: result.probe?.modelCount ?? result.status?.modelCount ?? 0,
              }),
            })
          }
        } catch (error) {
          if (!mounted.current || revision !== loginRevision.current) return
          setCheckNotice({
            kind: 'error',
            text: t('statusCheckFailed', { message: error instanceof Error ? error.message : String(error) }),
          })
        } finally {
          if (mounted.current && revision === loginRevision.current) setChecking(null)
        }
      }

      /** 网关地址来源的可读标签。 */
      const gatewaySourceLabel = () => {
        const source = statusInfo?.baseUrlSource
        if (source === 'login') return t('statusGatewaySourceLogin')
        if (source === 'credential') return t('statusGatewaySourceCredential')
        if (source === 'config') return t('statusGatewaySourceConfig')
        return t('statusGatewaySourceDefault')
      }

      /** 账号摘要：姓名 + 组织/团队，缺省时给一句明确提示。 */
      const accountSummary = () => {
        const account = statusInfo?.account ?? {}
        if (account.userName === undefined && account.organization === undefined) {
          return t('statusAccountUnknown')
        }
        const parts = []
        if (account.userName !== undefined) parts.push(account.userName)
        if (account.organization !== undefined) parts.push(account.organization)
        if (account.team !== undefined) parts.push(account.team)
        if (account.loginType !== undefined) parts.push(`（${account.loginType}）`)
        return parts.join(' · ')
      }

      function renderQuotaLine() { return h(ZhanluQuotaPanel) }

      /**
       * 数据目录平台选择器（v0.4.0）。
       *
       * 三态开关：自动（按系统检测）/ macOS / Windows，决定湛卢 App 数据目录
       * 按哪套布局解析。Windows 适配后默认 auto 即可在两个平台工作；
       * 显式选择供跨机排障或自动检测不符时使用。
       */
      function renderPlatformSwitch() {
        const pinned = statusInfo?.platformSource === 'config'
        const options = [
          { id: 'auto', label: t('platformAuto') },
          { id: 'mac', label: t('platformMac') },
          { id: 'windows', label: t('platformWindows') },
        ]
        const busy = checking !== null || saving || pinned || statusInfo === null
        const sourceLabel = statusInfo?.platformSource === 'config' ? t('platformSourceConfig')
          : statusInfo?.platformSource === 'preference' ? t('platformSourcePreference')
          : t('platformSourceAuto')
        return h('div', { 'data-zhanlu-platform-switch': '', style: { display: 'grid', gap: 10, minWidth: 0 } },
          h('style', null, '[data-zhanlu-platform-option]:focus-visible{outline:2px solid #2563eb!important;outline-offset:3px}'),
          h('span', { style: { ...kvKeyStyle, fontWeight: 600 } }, t('platformTitle')),
          h('div', { role: 'group', 'aria-label': t('platformTitle'),
            style: { display: 'flex', gap: 4, padding: 4, border: '1px solid var(--dsw-alias-border-secondary, #d1d5db)',
              borderRadius: 12, background: 'var(--dsw-alias-bg-secondary, #f1f3f5)', width: 'min(100%, 360px)', boxSizing: 'border-box' } },
            ...options.map((option) => {
              const active = platformSelection === option.id
              return h('button', { key: option.id, type: 'button', 'data-zhanlu-platform-option': option.id,
                style: { appearance: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  flex: '1 1 0', minWidth: 0, minHeight: 40, padding: '8px 10px', borderRadius: 8,
                  border: active ? '1px solid #2563eb' : '1px solid transparent',
                  background: active ? '#2563eb' : 'transparent', color: active ? '#fff' : 'var(--dsw-alias-label-primary, #1f2937)',
                  font: 'inherit', fontSize: 13, fontWeight: active ? 600 : 500,
                  boxShadow: active ? '0 1px 4px rgba(37,99,235,.2)' : 'none',
                  cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.65 : 1 },
                'aria-pressed': active, disabled: busy,
                title: pinned ? t('platformPinned', { value: statusInfo?.platformSelection ?? option.id }) : undefined,
                onClick: () => void changePlatform(option.id) },
                active ? h('span', { 'aria-hidden': true }, '✓') : null,
                h('span', { style: { whiteSpace: 'nowrap' } }, option.label))
            })),
          h('span', { style: noticeStyle }, t('platformEffective', {
            platform: statusInfo?.platform ?? '—', source: sourceLabel,
          })),
          h('span', { style: noticeStyle }, t('platformHint', { dir: statusInfo?.dataDir ?? '—' })),
          platformNotice ? h('span', { role: 'status', style: noticeStyle }, platformNotice) : null)
      }

      /**
       * 账号与连通性区域。
       *
       * 放在模型列表上方：换账号/换登录方式后第一眼就能看到当前是谁、网关是哪，
       * 再决定要不要刷新。三个按钮分别是刷新目录、检测账号、连通性检测。
       */
      /**
       * 状态指示灯颜色。
       *
       * 判据（与后端 status 字段一一对应，不猜）：
       *   - 检测中（任意 action 在跑）        → 黄
       *   - 账号身份也没读到                  → 红（真异常：未登录或数据目录错）
       *   - 网关不可达                        → 红
       *   - 网关可达但一个模型都没加载到        → 红
       *   - 网关可达且加载到模型              → 绿
       *   - 尚未拿到状态快照                  → 灰
       *
       * 「主动离线」（disableNetwork）不算异常：此时有账号身份与本地缓存，
       * 是用户开的排障模式，用 `reason` 里的「已禁用网络请求」识别，不判红。
       *
       * 注意：`credentialLoaded === false` **不单独判红**——离线排障模式下
       * 不解密凭据，此时账号身份仍可由 identity 提供，属正常降级。
       *
       * @returns {{ color: string, label: string }}
       */
      function statusLight() {
        if (checking !== null) {
          return { color: 'var(--dsw-alias-label-warning, #e8a33d)', label: t('statusLightChecking') }
        }
        if (statusInfo === null) {
          return { color: 'var(--dsw-alias-label-tertiary, #b0b0b0)', label: t('statusLightUnknown') }
        }
        if (statusInfo.catalogSource === 'bootstrap') {
          return { color: 'var(--dsw-alias-label-tertiary, #b0b0b0)', label: t('statusLightUnknown') }
        }
        const account = statusInfo.account ?? {}
        const hasIdentity = account.userName !== undefined || account.organization !== undefined
        if (statusInfo.identityLoaded === false || !hasIdentity) {
          return { color: 'var(--dsw-alias-label-error, #d33)', label: t('statusLightCredential') }
        }
        // 主动离线排障：有身份、有缓存，属正常降级，绿灯。
        const offlineByConfig =
          typeof statusInfo.reason === 'string' && statusInfo.reason.includes('已禁用网络请求')
        if (statusInfo.reachable === false && !offlineByConfig) {
          return { color: 'var(--dsw-alias-label-error, #d33)', label: t('statusLightUnreachable') }
        }
        if (typeof statusInfo.modelCount !== 'number' || statusInfo.modelCount === 0) {
          return { color: 'var(--dsw-alias-label-error, #d33)', label: t('statusLightNoModels') }
        }
        return { color: 'var(--dsw-alias-label-success, #2ea44f)', label: t('statusLightOk') }
      }

      /** 分区标题行：标题文字 + 状态灯（圆点 + 文字标签）。 */
      function renderSectionTitle() {
        const light = statusLight()
        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('p', { style: sectionTitleStyle }, t('statusSectionTitle')),
          h('span', {
            style: {
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: light.color,
              flex: '0 0 auto',
            },
          }),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, light.label),
        )
      }

      function renderStatusSection() {
        return h(
          'div',
          { style: sectionStyle },
          renderSectionTitle(),
          renderLoginSwitch(),
          renderPlatformSwitch(),
          h(
            'div',
            { style: { display: 'grid', gap: 6, fontSize: 13 } },
            h(
              'div',
              { style: kvRowStyle },
              h('span', { style: kvKeyStyle }, t('statusAccount')),
              h('span', { style: kvValueStyle }, accountSummary()),
            ),
            h(
              'div',
              { style: kvRowStyle },
              h('span', { style: kvKeyStyle }, t('statusGateway')),
              h(
                'span',
                { style: kvValueStyle },
                (statusInfo?.baseUrl ?? '—') +
                  (statusInfo?.baseUrl !== undefined ? `（${gatewaySourceLabel()}）` : ''),
              ),
            ),
            h(
              'div',
              { style: kvRowStyle },
              h('span', { style: kvKeyStyle }, t('statusDataDir')),
              h('span', { style: kvValueStyle }, String(statusInfo?.dataDir ?? '—')),
            ),
            h(
              'div',
              { style: kvRowStyle },
              h('span', { style: kvKeyStyle }, t('statusModels')),
              h('span', { style: kvValueStyle }, String(statusInfo?.modelCount ?? 0)),
            ),
            statusInfo?.credentialLoaded === false
              ? h('span', { style: errorStyle }, t('statusCredentialMissing'))
              : null,
            statusInfo?.reachable === false && statusInfo?.reason !== undefined && statusInfo.reason.length > 0
              ? h('span', { style: noticeStyle }, statusInfo.reason)
              : null,
          ),
          h(
            'div',
            { style: toolbarStyle },
            h(
              'button',
              {
                type: 'button',
                style: buttonStyle,
                disabled: checking !== null,
                onClick: () => void runCheck('refresh'),
              },
              checking === 'refresh' ? t('statusChecking') : t('statusRefresh'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: buttonStyle,
                disabled: checking !== null,
                onClick: () => void runCheck('account'),
              },
              checking === 'account' ? t('statusChecking') : t('statusCheckAccount'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: buttonStyle,
                disabled: checking !== null,
                onClick: () => void runCheck('connectivity'),
              },
              checking === 'connectivity' ? t('statusChecking') : t('statusCheckConnectivity'),
            ),
          ),
          checkNotice === null
            ? null
            : h('p', { style: checkNotice.kind === 'ok' ? noticeStyle : errorStyle }, checkNotice.text),
        )
      }

      // summary 视图是插件卡片标题下的一行简介，不需要交互。
      if (view === 'summary') return h('span', { style: introStyle }, t('intro'))

      if (state.status === 'loading') {
        return h('div', { style: pageStyle }, renderQuotaLine(), h('p', { style: introStyle }, t('loading')))
      }
      if (state.status === 'error') {
        return h(
          'div',
          { style: pageStyle },
          renderQuotaLine(),
          h('p', { style: errorStyle }, t('loadFailed', { message: state.error ?? '' })),
          h(
            'div',
            { style: toolbarStyle },
            h('button', { type: 'button', style: buttonStyle, onClick: () => void load() }, t('retry')),
          ),
        )
      }

      const data = /** @type {{ models: Array<object>, limits: { min: number, max: number } }} */ (state.data)
      const models = data.models
      const limits = data.limits
      const visibleCount = models.filter((m) => !hidden.has(m.id)).length

      /**
       * 读一个模型当前生效的窗口值：优先取草稿，其次覆盖，最后默认。
       *
       * @param {any} model
       * @returns {string}
       */
      const draftFor = (model) =>
        Object.prototype.hasOwnProperty.call(drafts, model.id)
          ? drafts[model.id]
          : String(overrides[model.id] ?? model.defaultContextWindow)

      /**
       * 校验一个草稿，返回规范化后的数字或 undefined（非法 / 等于默认值）。
       *
       * @param {any} model
       * @returns {{ ok: boolean, value?: number }}
       */
      const parseDraft = (model) => {
        const raw = draftFor(model).trim()
        if (raw.length === 0) return { ok: true }
        if (!/^\d+$/.test(raw)) return { ok: false }
        const value = Number(raw)
        if (!Number.isSafeInteger(value) || value < limits.min || value > limits.max) return { ok: false }
        // 与默认值相同就不必存覆盖，保持偏好文件干净。
        if (value === model.defaultContextWindow) return { ok: true }
        return { ok: true, value }
      }

      /** 是否有任何草稿非法——有则禁止保存。 */
      const hasInvalidDraft = models.some((m) => !parseDraft(m).ok)

      /** 把当前编辑态组装成提交体（平台选择一并携带）。 */
      const buildPayload = () => {
        /** @type {Record<string, number>} */
        const nextOverrides = {}
        for (const model of models) {
          const parsed = parseDraft(model)
          if (parsed.ok && parsed.value !== undefined) nextOverrides[model.id] = parsed.value
        }
        return { hiddenModels: [...hidden], contextOverrides: nextOverrides, platform: platformSelection }
      }

      const save = async (platformOverride) => {
        setSaving(true)
        setNotice(undefined)
        try {
          const payload = buildPayload()
          if (platformOverride !== undefined) payload.platform = platformOverride
          await writeConfig(payload)
          if (!mounted.current) return
          // 保存成功后以提交体为准刷新本地态，并清掉草稿。
          setOverrides(payload.contextOverrides)
          setDrafts({})
          if (payload.platform) setPlatformSelection(payload.platform)
          setNotice({ kind: 'ok', text: t('saved') })
          // 平台变化影响数据目录与凭据来源；重新拉状态让解析结果立即回显。
          readStatus().then((data) => {
            if (mounted.current) setStatusInfo(data?.status ?? null)
          }).catch(() => {})
        } catch (error) {
          if (!mounted.current) return
          setNotice({
            kind: 'error',
            text: t('saveFailed', { message: error instanceof Error ? error.message : String(error) }),
          })
        } finally {
          if (mounted.current) setSaving(false)
        }
      }

      const toggle = (id, nextVisible) => {
        setHidden((prev) => {
          const next = new Set(prev)
          if (nextVisible) next.delete(id)
          else next.add(id)
          return next
        })
        setNotice(undefined)
      }

      const resetContext = (model) => {
        setOverrides((prev) => {
          const next = { ...prev }
          delete next[model.id]
          return next
        })
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[model.id]
          return next
        })
        setNotice(undefined)
      }

      const resetAllContext = () => {
        setOverrides({})
        setDrafts({})
        setNotice(undefined)
      }

      const setAllVisible = (visible) => {
        setHidden(visible ? new Set() : new Set(models.map((m) => m.id)))
        setNotice(undefined)
      }

      /**
       * 切换数据目录平台（v0.4.0）：立即保存（携带平台字段），
       * 宿主按新平台重解析数据目录并重拉凭据/目录。
       *
       * 模型设置有未保存改动时禁止切换（与登录开关同一纪律），
       * 避免把草稿静默提交进偏好。
       *
       * @param {'auto' | 'mac' | 'windows'} next
       */
      const changePlatform = async (next) => {
        if (saving || checking !== null) return
        if (next === platformSelection) return
        const hostModels = state.data?.models ?? []
        const modelsDirty = state.status === 'ready' && (Object.keys(drafts).length > 0 || hostModels.some((m) =>
          hidden.has(m.id) !== m.hidden || (overrides[m.id] ?? m.defaultContextWindow) !== m.contextWindow))
        if (modelsDirty) { setPlatformNotice(t('platformUnsaved')); return }
        setPlatformSelection(next)
        setPlatformNotice(undefined)
        await save(next)
      }

      const overrideCount = Object.keys(overrides).length

      return h(
        'div',
        { style: pageStyle },
        h('p', { style: introStyle }, t('intro')),
        renderStatusSection(),
        renderQuotaLine(),

        h(
          'div',
          { style: summaryStyle },
          h('span', null, t('visibleSummary', { visible: visibleCount, total: models.length })),
          hidden.size > 0 ? h('span', { style: chipStyle }, t('hiddenSummary', { count: hidden.size })) : null,
          overrideCount > 0
            ? h('span', { style: chipStyle }, t('overrideSummary', { count: overrideCount }))
            : null,
        ),

        h(
          'div',
          { style: toolbarStyle },
          h('button', { type: 'button', style: buttonStyle, onClick: () => setAllVisible(true) }, t('selectAll')),
          h('button', { type: 'button', style: buttonStyle, onClick: () => setAllVisible(false) }, t('selectNone')),
          overrideCount > 0
            ? h('button', { type: 'button', style: buttonStyle, onClick: resetAllContext }, t('resetAll'))
            : null,
          h(
            'button',
            {
              type: 'button',
              style: primaryButtonStyle,
              disabled: saving || hasInvalidDraft,
              onClick: () => void save(),
            },
            saving ? t('saving') : t('save'),
          ),
          notice !== undefined
            ? h('span', { style: notice.kind === 'error' ? errorStyle : noticeStyle }, notice.text)
            : null,
        ),

        models.length === 0
          ? h('p', { style: noticeStyle }, t('noModels'))
          : h(
              'div',
              { style: listStyle },
              models.map((model, index) =>
                h(
                  'label',
                  { key: model.id, style: index === 0 ? firstRowStyle : rowStyle },
                  h(
                    'span',
                    { style: modelMainStyle },
                    h('input', {
                      type: 'checkbox',
                      checked: !hidden.has(model.id),
                      onChange: (event) => toggle(model.id, event.currentTarget.checked),
                    }),
                    h(
                      'span',
                      { style: { display: 'grid', minWidth: 0 } },
                      h(
                        'span',
                        { style: modelMainStyle },
                        h('span', { style: modelNameStyle }, model.name),
                        h(
                          'span',
                          { style: badgeStyle },
                          Array.isArray(model.input) && model.input.includes('image')
                            ? t('imageInputBadge')
                            : t('textInputBadge'),
                        ),
                        model.reasoning
                          ? h('span', { style: badgeStyle }, t('reasoningBadge'))
                          : null,
                        overrides[model.id] !== undefined
                          ? h('span', { style: badgeStyle }, t('overrideBadge'))
                          : null,
                      ),
                      h('span', { style: modelIdStyle }, model.id),
                    ),
                  ),
                  h(
                    'span',
                    { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    h('input', {
                      type: 'number',
                      min: limits.min,
                      max: limits.max,
                      step: 1024,
                      value: draftFor(model),
                      disabled: hidden.has(model.id),
                      style: parseDraft(model).ok ? inputStyle : errorInputStyle,
                      title: t('contextHint', {
                        min: limits.min,
                        max: limits.max,
                        default: model.defaultContextWindow,
                      }),
                      onChange: (event) => {
                        // React 会在事件处理结束后清空 currentTarget；状态更新回调可能稍后执行。
                        // 同步读取字符串，不能把事件对象带进 updater。
                        const value = event.currentTarget.value
                        setDrafts((prev) => ({ ...prev, [model.id]: value }))
                        setNotice(undefined)
                      },
                    }),
                    overrides[model.id] !== undefined
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: buttonStyle,
                            onClick: (event) => {
                              event.preventDefault()
                              resetContext(model)
                            },
                          },
                          t('resetContext'),
                        )
                      : null,
                  ),
                ),
              ),
            ),

        visibleCount === 0 && models.length > 0 ? h('p', { style: errorStyle }, t('emptySelection')) : null,
        h(
          'p',
          { style: noticeStyle },
          t('contextHint', {
            min: limits.min,
            max: limits.max,
            default: models[0]?.defaultContextWindow ?? '—',
          }),
        ),
      )
    }

    /**
     * 注册配置页。
     *
     * `plugins.bundle.config` 以**组合包名**为键，因此页面出现在侧栏
     * 「插件」页的本插件卡片下，而不是设置里的只读清单。
     *
     * @param {any} ctx
     */
    function apply(ctx) {
      // 槽位注册必须等 Plugins 页声明出该槽位之后再做——`slots.inject` 正是
      // 这个「等声明」的钩子。直接 register 会在槽位尚未声明时抛错，而浏览器
      // 半区的 entry 一旦激活失败，DSH 会把整个 web-boot 判为失败、应用起不来。
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          { name: 'plugins.bundle.config', key: BUNDLE_NAME },
          ZhanluConfigPage,
        ),
      )
      // 与Codex相同的官方Composer槽位与会话模型store，无DOM观察器/宿主补丁。
      ctx.inject(['slots', 'modelDirectories', 'remote.session'], (scope) => {
        scope.slots.inject('conversation.input.right', () => scope.slots.register({
          name: 'conversation.input.right', id: 'zhanlu-quota', order: 20,
          inject: (sessionId) => ({ directory: scope.modelDirectories.directoryFor(sessionId).store }),
        }, ZhanluQuotaIndicator))
      })
      ctx.effect(() => () => quotaStore.dispose())
    }

    // 与 WorkBuddy Connect 的浏览器半区同形：显式导出 name / inject / apply。
    // `inject: ['slots']` 是**必需**的——没有它访问 ctx.slots 就会失败，进而
    // 触发 web-boot 致命错误（2026-10-12 实测因此崩溃三次，勿删）。
    return { name, inject: ['slots'], apply, ZhanluConfigPage, ZhanluQuotaPanel, ZhanluQuotaIndicator,
      createQuotaStore, validQuota, isZhanluDirectory, quotaSummary }
  },
})
