// dsh-provider-usage — Client half (M2 简易版)。
// 右下角常驻用量卡片（可拖动、位置记忆）+ 设置页（用量中心）：提供方实例管理
// （OpenCode Go 订阅 / DeepSeek 余额），卡片按结果字段自适应渲染（%+倒计时=订阅卡；
// 金额+币种=余额卡）。
// 设置项全部即时生效（localStorage 持久化，无需重启）。

window.__ModuleLoader__.load({
  id: 'dsh-provider-usage',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const { useState, useEffect, useLayoutEffect, useCallback, useRef } = React;
    // 与 dsh-pet 同构：直接在 document.body 上自建 React root（逃出 shell.overlay
    // 的 z-index:20 层叠上下文，避免被 better-sidebar 等 body 顶层浮层整层盖住）
    const { createRoot } = require('react-dom/client');

    const inject = ['slots'];
    const SETTINGS_KEY = 'dsh-provider-usage.settings';
    const DEFAULT_SETTINGS = { visible: true, refreshMs: 30000, providerId: 'opencode-go', right: 16, bottom: 16, settingsVersion: 5 };
    // 卡片常驻 body 顶层（z-index 与 dsh-pet 同值，≈int32 上限）
    const Z_INDEX = 2147483000;
    // 适配器元数据（与 host ADAPTERS 对应；logo 与显示名用于设置页/菜单）
    const ADAPTER_META = {
      'usage-percent': { displayName: 'OpenCode Go（订阅额度）' },
      'balance-json': { displayName: 'DeepSeek' },
    };
    // 供应商实例清单（用户可配置：名称可改、可增删、可同类型多个；key 引用走 DSH 凭证）
    const PROVIDERS_KEY = 'dsh-provider-usage.providers';
    const DEFAULT_PROVIDERS = [
      { id: 'opencode-go', name: 'OpenCode Go', adapter: 'usage-percent', ref: 'OPENCODE_GO_API_KEY' },
      { id: 'deepseek-balance', name: 'DeepSeek', adapter: 'balance-json', ref: 'DEEPSEEK_API_KEY' },
    ];
    // 官方 logo（资源来源：Rainytoken 整理，见 tmp/Rainytoken 评估）
    // OpenCode Go：opencode.ai/zh/go hero 区官方 SVG（viewBox 54×30，#211E1E + #CFCECD，需浅色衬底）
    // 官方 logo 形状不变；深/浅两色映射为亮色系（透明底，适配暗色卡片）：
    // 深 S → 暖白 #EFE0E5，浅 S → 草莓粉 #FFB3C6
    const LOGO_OCGO = React.createElement('svg', { viewBox: '0 0 54 30', width: 27, height: 15, 'aria-hidden': 'true', style: { display: 'block' } },
      React.createElement('path', { fill: '#EFE0E5', d: 'M24 30H0V0H24V6H6V24H18V18H12V12H24V30Z' }),
      React.createElement('path', { fill: '#FFB3C6', d: 'M12 18H18V24H6V12H12V18Z' }),
      React.createElement('path', { fill: '#FFB3C6', d: 'M48 12V24H36V12H48Z' }),
      React.createElement('path', { fill: '#EFE0E5', d: 'M54 30H30V0H54V30ZM36 24H48V6H36V24Z' }));
    // DeepSeek：官方鲸 logo PNG（225×225 RGBA）→ data URI，透明底直接展示
    const LOGO_DEEPSEEK = 'data:image/png;base64,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';

    const zh = {
      loading: '查询中…',
      refresh: '刷新',
      stale: '未更新',
      remaining: '剩余',
      rolling: '5小时滚动',
      weekly: '7天（每周）',
      monthly: '每月',
      errorTitle: '无法获取用量',
      nav: '用量中心',
    };

    var styleId = 'dsh-provider-usage/styles.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + styleId + '"]') === null) {
      var css = [
        // 官方「模型」设置页完整样式（1:1 注入，dsh-client-ui-settings-models 同款）
        ".zGbnIq_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}.zGbnIq_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}.zGbnIq_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}.zGbnIq_notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}.zGbnIq_savedNotice{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}.zGbnIq_rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none;display:flex}.zGbnIq_rowCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}.zGbnIq_rowHead{align-items:center;gap:10px;display:flex}.zGbnIq_rowIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}.zGbnIq_rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}.zGbnIq_rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}.zGbnIq_credentialDot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}.zGbnIq_credentialDotConfigured{background:var(--dsw-alias-state-success-primary)}.zGbnIq_credentialDotMissing{background:var(--dsw-alias-state-error-primary)}.zGbnIq_rowActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}.zGbnIq_primaryButton,.zGbnIq_secondaryButton,.zGbnIq_addButton{box-sizing:border-box;height:36px;font:inherit;cursor:pointer;border:none;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.zGbnIq_primaryButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.zGbnIq_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.zGbnIq_secondaryButton,.zGbnIq_addButton{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}.zGbnIq_secondaryButton:hover:not(:disabled),.zGbnIq_addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.zGbnIq_secondaryButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.zGbnIq_dangerButton{box-sizing:border-box;height:36px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:18px;justify-content:center;align-items:center;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.zGbnIq_dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.zGbnIq_rowActions .zGbnIq_secondaryButton,.zGbnIq_rowActions .zGbnIq_dangerButton{border-radius:14px;height:28px;padding:0 10px;font-size:12px;line-height:18px}.zGbnIq_primaryButton:disabled,.zGbnIq_secondaryButton:disabled,.zGbnIq_dangerButton:disabled,.zGbnIq_addButton:disabled,.zGbnIq_linkButton:disabled,.zGbnIq_addModelButton:disabled{opacity:.4;cursor:default}.zGbnIq_primaryButton:focus-visible,.zGbnIq_secondaryButton:focus-visible,.zGbnIq_dangerButton:focus-visible,.zGbnIq_addButton:focus-visible,.zGbnIq_linkButton:focus-visible,.zGbnIq_addModelButton:focus-visible,.zGbnIq_iconButton:focus-visible,.zGbnIq_customizedSummary:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.zGbnIq_editor{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}.zGbnIq_editorHeader{align-items:baseline;gap:8px;display:flex}.zGbnIq_editorTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}.zGbnIq_editorRoute{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.zGbnIq_field{flex-direction:column;gap:6px;display:flex}.zGbnIq_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}.zGbnIq_linkButton{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:14px;align-items:center;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}.zGbnIq_linkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.zGbnIq_advancedHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.zGbnIq_editorActions{justify-content:flex-end;gap:8px;display:flex}.zGbnIq_addBlock{flex-direction:column;gap:12px;display:flex}.zGbnIq_addActions{flex-wrap:wrap;gap:10px;display:flex}.zGbnIq_addButton{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;flex:1 1 0;gap:6px;min-width:180px;height:44px}.zGbnIq_addCard,.zGbnIq_setupCard{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;list-style:none;display:flex}.zGbnIq_addCard .zGbnIq_editor,.zGbnIq_setupCard .zGbnIq_editor{background:0 0;padding:0}.zGbnIq_customized{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}.zGbnIq_customizedSummary{cursor:pointer;width:fit-content;color:var(--dsw-alias-label-secondary);border-radius:6px;align-items:center;gap:6px;margin-left:-4px;padding:2px 4px;font-size:12px;font-weight:500;line-height:18px;list-style:none;display:flex}.zGbnIq_customizedSummary::-webkit-details-marker{display:none}.zGbnIq_customizedSummary:before{content:\"\";border-bottom:1.5px solid;border-right:1.5px solid;width:5px;height:5px;transition:transform .12s;transform:rotate(-45deg)translate(-1px,-1px)}.zGbnIq_customized[open]>.zGbnIq_customizedSummary:before{transform:rotate(45deg)translate(-1px,-1px)}.zGbnIq_customizedSummary:hover{color:var(--dsw-alias-label-primary)}.zGbnIq_customizedBody{flex-direction:column;gap:12px;padding-top:12px;display:flex}.zGbnIq_modelCatalog{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:12px;display:flex}.zGbnIq_modelCatalogHeading{flex-direction:column;gap:2px;display:flex}.zGbnIq_modelCatalogTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}.zGbnIq_modelCatalogMeta,.zGbnIq_modelEmpty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.zGbnIq_modelList{flex-direction:column;gap:8px;display:flex}.zGbnIq_modelListHead{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.zGbnIq_modelEntry{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px}.zGbnIq_modelRow{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto;align-items:center;gap:6px;display:grid}.zGbnIq_iconButton{box-sizing:border-box;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;display:inline-flex}.zGbnIq_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.zGbnIq_iconButton:disabled{cursor:default;opacity:.4}.zGbnIq_iconButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}.zGbnIq_modelAdvanced{grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;padding:8px 4px 2px;display:grid}.zGbnIq_modelField{flex-direction:column;gap:4px;display:flex}.zGbnIq_modelFieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.zGbnIq_modelEmpty{border:1px dashed var(--dsw-alias-border-l3);text-align:center;border-radius:8px;padding:12px}.zGbnIq_addModelButton{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:14px;align-self:flex-start;align-items:center;gap:4px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}.zGbnIq_addModelButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.zGbnIq_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}select.zGbnIq_input{cursor:pointer;max-width:240px}.zGbnIq_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}.zGbnIq_input::placeholder{color:var(--dsw-alias-label-dimmed)}.zGbnIq_input:disabled{opacity:.6;cursor:default}.zGbnIq_selectInput{appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:32px}.zGbnIq_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}.zGbnIq_deleteDialog{width:min(480px,100%)}.zGbnIq_deleteConfirm:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.zGbnIq_deleteConfirm:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.zGbnIq_hiddenLabel{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}@media (prefers-reduced-motion:reduce){.zGbnIq_customizedSummary:before{transition:none}}.zGbnIq_fetchDialog{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);max-width:520px}.zGbnIq_candidateActions{justify-content:flex-end;margin-bottom:6px;display:flex}.zGbnIq_candidateList{flex-direction:column;gap:2px;max-height:320px;margin:0;padding:0;list-style:none;display:flex;overflow-y:auto}.zGbnIq_candidate{border-radius:6px}.zGbnIq_candidateLabel{cursor:pointer;align-items:center;gap:8px;padding:6px 8px;display:flex}.zGbnIq_candidateId{font-family:var(--ds-font-family-code);overflow-wrap:anywhere;flex:auto;font-size:13px}",
        // 官方「插件」设置页二级菜单样式（1:1 注入，dsh-client-ui-settings-plugins PluginsSettingsSection 同款）
        ".pbvGtq_section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}.pbvGtq_heading{margin:0;font-size:18px;font-weight:600}.pbvGtq_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}.pbvGtq_tabs{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-end;gap:22px;margin-top:2px;display:flex}.pbvGtq_tab{color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;position:relative}.pbvGtq_tab:hover,.pbvGtq_tab[data-active=true]{color:var(--dsw-alias-label-primary)}.pbvGtq_tab[data-active=true]:after,.pbvGtq_tab:focus-visible:after{background:var(--dsw-alias-label-primary);content:\"\";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}.pbvGtq_tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;color:var(--dsw-alias-label-primary);border-radius:2px}.pbvGtq_panel{min-width:0;padding-top:2px}",
        // 用量统计页样式
        ".zGbnIq_statsGrid{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 0;display:grid}.zGbnIq_stat{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:10px;flex-direction:column;gap:2px;padding:8px 10px;display:flex}.zGbnIq_statValue{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;line-height:22px}.zGbnIq_statLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.zGbnIq_chips{flex-wrap:wrap;gap:6px;margin:10px 0 2px;display:flex}.zGbnIq_chip{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border-radius:999px;padding:2px 12px;font-size:12px;line-height:18px}.zGbnIq_chip:hover{color:var(--dsw-alias-label-primary)}.zGbnIq_chip[data-active=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}",
        ".zGbnIq_json{max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin:10px 0 0;padding:8px 10px;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all}",
        ".zGbnIq_progress{height:3px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;position:relative;margin:8px 0 2px}.zGbnIq_progress i{position:absolute;top:0;bottom:0;width:36%;border-radius:999px;background:var(--dsw-alias-brand-primary,#6c8ef5);animation:zGbnIq-progress 1.2s ease-in-out infinite}@keyframes zGbnIq-progress{0%{left:-36%}100%{left:100%}}",
        ".zGbnIq_cntCard{cursor:pointer;transition:border-color .15s,background .15s}.zGbnIq_cntCard:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover-solid)}.zGbnIq_cntCard:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}",
        // ── 常驻用量卡片（Rainytoken 暗色视觉：暖深底/草莓粉/三色窗口条）──
        '.dsh-pu-card{position:fixed;right:16px;bottom:16px;width:304px;box-sizing:border-box;border-radius:16px;pointer-events:auto;background:linear-gradient(180deg,#2A1F25 0%,#241A20 100%);border:1px solid #4D3A42;box-shadow:0 10px 28px rgba(31,20,25,.5),0 2px 6px rgba(31,20,25,.4);padding:14px 14px 12px;font-family:inherit;color:#EFE0E5;font-size:13px;line-height:1.5;touch-action:none;user-select:none;cursor:grab;transition:border-color .2s,transform .2s,box-shadow .2s}',
        '.dsh-pu-card:hover{border-color:#6b5560;transform:translateY(-1px);box-shadow:0 12px 32px rgba(31,20,25,.55),0 2px 8px rgba(31,20,25,.45)}',
        '.dsh-pu-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
        '.dsh-pu-logo{width:30px;height:30px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;overflow:hidden;background:transparent}',
        '.dsh-pu-logo.go svg,.dsh-pu-logo.deepseek img{display:block}',
        '.dsh-pu-title-btn{display:flex;align-items:center;gap:7px;cursor:pointer;border:none;background:none;padding:0;margin:0;font:inherit;flex:1;min-width:0;text-align:left;color:inherit;border-radius:8px}',
        '.dsh-pu-title-btn:hover{background:rgba(255,179,198,.07)}',
        '.dsh-pu-title-btn .caret{font-size:9px;color:#A9949D;flex:none;transition:transform .15s,color .15s}',
        '.dsh-pu-title-btn:hover .caret{color:#FFB3C6}',
        '.dsh-pu-menu{position:absolute;left:10px;top:46px;width:232px;box-sizing:border-box;background:#2A1F25;border:1px solid #4D3A42;border-radius:12px;box-shadow:0 14px 36px rgba(31,20,25,.65);padding:6px;z-index:5;display:flex;flex-direction:column;gap:2px}',
        '.dsh-pu-menu-item{display:flex;align-items:center;gap:9px;width:100%;border:none;background:transparent;color:#EFE0E5;border-radius:8px;padding:8px 10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-align:left}',
        '.dsh-pu-menu-item:hover{background:rgba(255,179,198,.1)}',
        '.dsh-pu-menu-item.active{background:rgba(255,179,198,.14);color:#FFB3C6}',
        '.dsh-pu-menu-item .mini-logo{width:22px;height:22px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;overflow:hidden}',
        '.dsh-pu-menu-item .check{margin-left:auto;color:#FFB3C6;font-size:12px}',
        '.dsh-pu-card-title{font-size:14px;font-weight:600;color:#EFE0E5;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsh-pu-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 8px;font-size:10px;font-weight:600;flex:none}',
        '.dsh-pu-chip.ok{background:rgba(102,187,106,.14);color:#7ED68A}',
        '.dsh-pu-chip.warn{background:rgba(255,167,38,.15);color:#FFC46B}',
        '.dsh-pu-chip.err{background:rgba(233,30,99,.16);color:#F06292}',
        '.dsh-pu-chip i{width:6px;height:6px;border-radius:50%;background:currentColor;font-style:normal}',
        '.dsh-pu-chip.dsh-pu-chip-loading i{animation:dsh-pu-ms-breathe 1.2s ease-in-out infinite}',
        '.dsh-pu-meta{font-size:10px;color:#C9B8BE;white-space:nowrap}',
        '.dsh-pu-refresh{width:24px;height:24px;border-radius:50%;border:1px solid rgba(255,179,198,.25);background:rgba(255,179,198,.12);color:#FFB3C6;font-size:13px;line-height:1;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}',
        '.dsh-pu-refresh:hover{background:rgba(255,179,198,.22);color:#FFD1DC}',
        '.dsh-pu-remain{display:flex;align-items:baseline;gap:8px;margin:2px 0 10px}',
        '.dsh-pu-remain-big{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;color:#EFE0E5;letter-spacing:.5px}',
        '.dsh-pu-remain-label{font-size:11px;color:#C9B8BE}',
        '.dsh-pu-row{display:grid;grid-template-columns:44px 42px 1fr 58px;align-items:center;gap:8px;margin:7px 0}',
        '.dsh-pu-row-label{font-size:11px;color:#C9B8BE;white-space:nowrap}',
        '.dsh-pu-row-used{font-size:11px;font-weight:600;color:#EFE0E5;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.dsh-pu-bar{height:5px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden}',
        '.dsh-pu-bar-fill{height:100%;border-radius:999px;transition:width .3s}',
        '.dsh-pu-bar-fill.pink{background:#FF85A2}.dsh-pu-bar-fill.orange{background:#FFA726}.dsh-pu-bar-fill.magenta{background:#E91E63}',
        '.dsh-pu-reset{font-size:10px;color:#B9A7AE;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
        '.dsh-pu-error{border:1px solid rgba(233,30,99,.4);border-radius:10px;padding:8px 10px;font-size:11px;color:#C9B8BE}',
        '.dsh-pu-error b{color:#F06292}',
        '.dsh-pu-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.06)}',
        // ── 官方样式补充：状态点三态（官方只有 configured/missing）与添加按钮加号 ──
        '.zGbnIq_credentialDot.dsh-pu-dot-loading{background:var(--dsw-alias-state-success-primary,#22c55e);animation:dsh-pu-ms-breathe 1.2s ease-in-out infinite}',
        '.zGbnIq_credentialDot.dsh-pu-dot-gray{background:var(--dsw-alias-label-tertiary,#8b93a7)}',
        '@keyframes dsh-pu-ms-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.72)}}',
        '.ms-plus{color:var(--dsw-alias-brand-primary);font-size:15px;line-height:1}',
      ].join('');
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-provider-usage';
      tag.dataset.pluginCss = styleId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ── 设置存储（localStorage，即时生效）───────────────────────────────
    function loadSettings() {
      try {
        var s = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null');
        if (s && typeof s === 'object' &&
            (s.settingsVersion === DEFAULT_SETTINGS.settingsVersion || s.settingsVersion === 3 || s.settingsVersion === 4)) {
          // v3→v4 新增 providerId（默认 opencode-go），其余偏好保留
          return Object.assign({}, DEFAULT_SETTINGS, s, {
            providerId: typeof s.providerId === 'string' ? s.providerId : DEFAULT_SETTINGS.providerId,
          });
        }
        // 设置结构升级：v2→v3 移除用户可配置的 zIndex（固定与 dsh-pet 一致），其余偏好保留
        if (s && typeof s === 'object') {
          return Object.assign({}, DEFAULT_SETTINGS, {
            visible: typeof s.visible === 'boolean' ? s.visible : true,
            refreshMs: typeof s.refreshMs === 'number' ? s.refreshMs : DEFAULT_SETTINGS.refreshMs,
          });
        }
      } catch (e) { /* ignore */ }
      return Object.assign({}, DEFAULT_SETTINGS);
    }
    var settingsState = loadSettings();
    var settingsListeners = new Set();
    function saveSettings() {
      try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsState)); } catch (e) { /* ignore */ }
    }
    function getSettings() { return settingsState; }
    function setSettings(patch) {
      settingsState = Object.assign({}, settingsState, patch);
      saveSettings();
      settingsListeners.forEach(function (fn) { fn(); });
    }
    function subscribeSettings(fn) {
      settingsListeners.add(fn);
      return function () { settingsListeners.delete(fn); };
    }
    function useSettings() {
      var [s, setS] = useState(getSettings);
      useEffect(function () { return subscribeSettings(function () { setS(getSettings()); }); }, []);
      return s;
    }

    // ── 供应商实例清单（localStorage，即时生效）──────────────────────
    function loadProviders() {
      try {
        var arr = JSON.parse(window.localStorage.getItem(PROVIDERS_KEY) || 'null');
        if (Array.isArray(arr)) {
          if (arr.length === 0) return []; // 用户删光后保持空清单，不复活默认实例
          return arr.filter(function (p) {
            return p && typeof p === 'object' && typeof p.adapter === 'string' && ADAPTER_META[p.adapter];
          }).map(function (p) {
            var name = typeof p.name === 'string' && p.name ? p.name : (ADAPTER_META[p.adapter] || {}).displayName;
            if (String(p.id || '') === 'deepseek-balance' && name === 'DeepSeek 余额') name = 'DeepSeek'; // 0.4.0 更名
            // source：Key 解析位置（vault=插件私有库直取；dsh=DSH 凭证链）；type：创建方式（import=导入 / manual=自定义）
            var source = p.source === 'vault' ? 'vault' : 'dsh';
            // 显式 type 优先；旧数据无 type 时由 source 推导（vault→manual，其余→import）
            var type = p.type === 'manual' || p.type === 'import' ? p.type : (source === 'vault' ? 'manual' : 'import');
            return { id: String(p.id || ''), name: name, adapter: p.adapter, ref: typeof p.ref === 'string' ? p.ref : '', source: source, type: type };
          });
        }
      } catch (e) { /* ignore */ }
      return DEFAULT_PROVIDERS.slice();
    }
    var providersState = loadProviders();
    var providersListeners = new Set();
    function saveProviders() {
      try { window.localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providersState)); } catch (e) { /* ignore */ }
    }
    function getProviders() { return providersState; }
    function setProviders(list) {
      providersState = list;
      saveProviders();
      providersListeners.forEach(function (fn) { fn(); });
    }
    function subscribeProviders(fn) {
      providersListeners.add(fn);
      return function () { providersListeners.delete(fn); };
    }
    function useProviders() {
      var [p, setP] = useState(getProviders);
      useEffect(function () { return subscribeProviders(function () { setP(getProviders()); }); }, []);
      return p;
    }
    /** 当前选中实例；若被删除则回落到第一个。 */
    function currentProvider(providers, providerId) {
      for (var i = 0; i < providers.length; i++) if (providers[i].id === providerId) return providers[i];
      return providers[0] || null;
    }

    // ── 工具 ──────────────────────────────────────────────────────────
    function fmtTime(ms) {
      if (!ms) return '-';
      var d = new Date(ms);
      var hh = String(d.getHours()).padStart(2, '0');
      var mm = String(d.getMinutes()).padStart(2, '0');
      var ss = String(d.getSeconds()).padStart(2, '0');
      return hh + ':' + mm + ':' + ss;
    }
    /** Rainytoken 小组件 formatReset 同款：>1 天 → “3d4h”/“3d”，>1 时 → “5h32m”/“5h”，否则 “42m”/“<1m”；无效返回空串 */
    function fmtResetIn(ms) {
      if (!ms || ms <= 0) return '';
      var sec = Math.floor(ms / 1000);
      var days = Math.floor(sec / 86400);
      var hours = Math.floor((sec % 86400) / 3600);
      var minutes = Math.floor((sec % 3600) / 60);
      if (days > 0) return days + 'd' + (hours > 0 ? hours + 'h' : '');
      if (hours > 0) return hours + 'h' + (minutes > 0 ? minutes + 'm' : '');
      if (minutes > 0) return minutes + 'm';
      return '<1m';
    }
    function WindowRow(props) {
      // Rainytoken 小组件同款行：标签 | 已用% | 进度条（窗口固定色）| 重置倒计时（紧凑格式，如 3d4h / 5h32m / 42m）
      var label = props.label, win = props.win || {}, bar = props.bar || 'pink';
      var used = win.usedPct, resetsAt = win.resetsAt;
      var remain = resetsAt ? new Date(resetsAt).getTime() - Date.now() : 0;
      var resetText = fmtResetIn(remain);
      return React.createElement('div', { className: 'dsh-pu-row' },
        React.createElement('span', { className: 'dsh-pu-row-label' }, label),
        React.createElement('span', { className: 'dsh-pu-row-used' }, used === null ? '--' : Math.round(used) + '%'),
        React.createElement('div', { className: 'dsh-pu-bar' },
          React.createElement('div', { className: 'dsh-pu-bar-fill ' + bar, style: { width: Math.min(100, used === null ? 0 : used) + '%' } })),
        React.createElement('span', { className: 'dsh-pu-reset', title: resetText ? '约 ' + resetText + ' 后重置' : '' }, resetText));
    }

    // ── 用量卡片（布局借鉴 Rainytoken 小组件卡片，常驻右下角）──────────
    function UsageCard() {
      var s = useSettings();
      var providers = useProviders();
      var [data, setData] = useState(null);
      var [loading, setLoading] = useState(false);
      var [loadError, setLoadError] = useState(null);
      var [menuOpen, setMenuOpen] = useState(false);
      var menuRef = useRef(null);
      var cardRef = useRef(null);
      // dsh-pet 同款拖拽：pointer 事件 + right/bottom 位置记忆（存 localStorage）
      var [dragPos, setDragPos] = useState(null);
      var dragRef = useRef(null);
      var draggedRef = useRef(false);
      // 整卡入屏钳制：右/下距离 ≤ 视口 − 卡片自身宽/高 → 左/上边缘永不为负
      function clampCard(right, bottom, w, h) {
        return {
          right: Math.max(0, Math.min(right, Math.max(0, window.innerWidth - w))),
          bottom: Math.max(0, Math.min(bottom, Math.max(0, window.innerHeight - h))),
        };
      }
      function onPointerDown(e) {
        if (e.button && e.button !== 0) return;
        e.preventDefault();
        if (e.target && e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
        var start = dragPos || { right: s.right, bottom: s.bottom };
        dragRef.current = { startX: e.clientX, startY: e.clientY, right: start.right, bottom: start.bottom };
        draggedRef.current = false;
      }
      function onPointerMove(e) {
        var d = dragRef.current;
        if (!d) return;
        var dx = e.clientX - d.startX;
        var dy = e.clientY - d.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) draggedRef.current = true;
        var el = cardRef.current;
        var w = el && el.offsetWidth ? el.offsetWidth : 304;
        var h = el && el.offsetHeight ? el.offsetHeight : 200;
        setDragPos(clampCard(d.right - dx, d.bottom - dy, w, h));
      }
      function clearDrag() {
        dragRef.current = null;
        if (dragPos) setSettings({ right: dragPos.right, bottom: dragPos.bottom });
        // 关键：拖完必须清空 dragPos，否则渲染永远用拖拽时固化的坐标，
        // resize/挂载钳制只改 settings，pos 却停留在旧的越界值上。
        setDragPos(null);
      }
      function onPointerUp() {
        if (!dragRef.current) return;
        clearDrag();
      }
      // 挂载恢复 / 内容高度变化时，把持久化位置拉回视口内；拖动中跳过
      useLayoutEffect(function () {
        if (dragRef.current || !s.visible) return;
        var el = cardRef.current;
        if (!el || !el.offsetWidth || !el.offsetHeight) return;
        var c = clampCard(s.right, s.bottom, el.offsetWidth, el.offsetHeight);
        if (c.right !== s.right || c.bottom !== s.bottom) setSettings(c);
      }, [s.right, s.bottom, s.visible, data, loading, loadError]);
      // 窗口缩放后同样拉回（防止 resize 后越界）
      useLayoutEffect(function () {
        if (!s.visible) return undefined;
        function onResize() {
          if (dragRef.current) return;
          var el = cardRef.current;
          if (!el || !el.offsetWidth || !el.offsetHeight) return;
          var c = clampCard(s.right, s.bottom, el.offsetWidth, el.offsetHeight);
          if (c.right !== s.right || c.bottom !== s.bottom) setSettings(c);
        }
        window.addEventListener('resize', onResize);
        return function () { window.removeEventListener('resize', onResize); };
      }, [s.right, s.bottom, s.visible, data]);
      var current = currentProvider(providers, s.providerId);
      var multiple = providers.length > 1;
      var curKey = current ? current.id + '|' + current.adapter + '|' + current.ref : 'none';

      var load = useCallback(function (force) {
        if (!current) return;
        setLoading(true);
        // force=true 时绕过 host 30s 缓存（noCache=1），手动点刷新/改 Key 后走真实上游
        var qs = 'adapter=' + encodeURIComponent(current.adapter) + (current.ref ? '&ref=' + encodeURIComponent(current.ref) : '') + (current.source === 'vault' ? '&source=vault' : '') + (force ? '&noCache=1' : '');
        fetch('/api/provider-usage/query?' + qs, { headers: { accept: 'application/json' } })
          .then(function (res) { return res.json().catch(function () { return null; }); })
          .then(function (json) { setData(json); setLoadError(null); })
          .catch(function (e) { setLoadError(String((e && e.message) || e)); })
          .finally(function () { setLoading(false); });
      }, [curKey]);

      useEffect(function () {
        load();
        var timer = window.setInterval(load, s.refreshMs || 30000);
        return function () { window.clearInterval(timer); };
      }, [load, s.refreshMs]);

      // 点击卡片外部关闭菜单
      useEffect(function () {
        if (!menuOpen) return undefined;
        function onDoc(e) {
          var card = cardRef.current;
          if (card && !card.contains(e.target)) setMenuOpen(false);
        }
        document.addEventListener('mousedown', onDoc);
        return function () { document.removeEventListener('mousedown', onDoc); };
      }, [menuOpen]);

      if (!s.visible || !current) return null;

      // 状态语义：请求中=呼吸绿“查询中”（优先于旧数据状态）；正常/注意（stale 或余额不足）/错误
      var loadingCls = loading ? ' dsh-pu-chip-loading' : '';
      var level = loading ? 'ok' : 'err';
      var chipText = loading ? zh.loading : '错误';
      if (!loading && data && data.ok && data.isValid !== false) { level = 'ok'; chipText = '正常'; }
      else if (!loading && data && data.error) { level = 'err'; chipText = '查询失败'; }
      else if (!loading && data && data.stale) { level = 'warn'; chipText = '未更新'; }
      else if (!loading && data && data.ok && data.isValid === false) { level = 'warn'; chipText = '注意'; }
      var title = current.name;
      var meta = data && data.fetchedAt ? fmtTime(data.fetchedAt) + (data.stale ? ' · ' + zh.stale : '') : zh.loading;
      var isBalance = current.adapter === 'balance-json';
      var logoClass = isBalance ? 'deepseek' : 'go';
      var logoEl = isBalance
        ? React.createElement('img', { src: LOGO_DEEPSEEK, width: 24, height: 24, alt: '' })
        : LOGO_OCGO;

      var body = null;
      if (loading && !data) {
        body = React.createElement('div', null, zh.loading);
      } else if (!data && loadError) {
        body = React.createElement('div', { className: 'dsh-pu-error' }, React.createElement('b', null, zh.errorTitle + '：'), String(loadError));
      } else if (data && !data.ok && !data.stale) {
        var em = (data.error && data.error.message) || '未知错误';
        body = React.createElement('div', { className: 'dsh-pu-error' }, React.createElement('b', null, zh.errorTitle + '：'), ' ' + em);
      } else if (data) {
        var isPct = data.unit === '%';
        var main = data.remaining === null ? '--' : (isPct ? Math.round(data.remaining) + '%' : Number(data.remaining).toFixed(2) + ' ' + data.unit);
        var mainLabel = zh.remaining + (isPct ? '（' + zh.monthly + '）' : '');
        var winRows = data.windows
          ? [React.createElement(WindowRow, { key: 'r', label: zh.rolling, win: data.windows.rolling, bar: 'pink' }),
             React.createElement(WindowRow, { key: 'w', label: zh.weekly, win: data.windows.weekly, bar: 'orange' }),
             React.createElement(WindowRow, { key: 'm', label: zh.monthly, win: data.windows.monthly, bar: 'magenta' })]
          : null;
        var warn = data.isValid === false && data.invalidMessage
          ? React.createElement('div', { className: 'dsh-pu-error' }, data.invalidMessage)
          : null;
        // 窗口行/主值/警告条已覆盖全部信息，extra 全文不再展示（保持卡片干净）
        var extra = null;
        body = React.createElement('div', null,
          React.createElement('div', { className: 'dsh-pu-remain' },
            React.createElement('span', { className: 'dsh-pu-remain-big' }, main),
            React.createElement('span', { className: 'dsh-pu-remain-label' }, ' ' + mainLabel)),
          warn,
          winRows,
          extra);
      }

      var menu = null;
      if (multiple && menuOpen) {
        menu = React.createElement('div', { ref: menuRef, className: 'dsh-pu-menu' },
          providers.map(function (p) {
            var active = p.id === current.id;
            var mini = p.adapter === 'balance-json'
              ? React.createElement('img', { src: LOGO_DEEPSEEK, width: 16, height: 16, alt: '' })
              : LOGO_OCGO;
            return React.createElement('button', {
              key: p.id, type: 'button', className: 'dsh-pu-menu-item' + (active ? ' active' : ''),
              onClick: function (e) { if (draggedRef.current) { draggedRef.current = false; return; } e.stopPropagation(); setSettings({ providerId: p.id }); setMenuOpen(false); },
            },
              React.createElement('span', { className: 'mini-logo' }, mini),
              p.name,
              active ? React.createElement('span', { className: 'check' }, '✓') : null);
          }));
      }

      var pos = dragPos || { right: s.right, bottom: s.bottom };
      return React.createElement('div', { ref: cardRef, className: 'dsh-pu-card',
        style: { zIndex: Z_INDEX, right: pos.right, bottom: pos.bottom, cursor: dragRef.current ? 'grabbing' : 'grab' },
        onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: onPointerUp,
        onPointerCancel: clearDrag },
        React.createElement('div', { className: 'dsh-pu-card-head' },
          React.createElement('button', {
            type: 'button', className: 'dsh-pu-title-btn',
            title: multiple ? '选择提供方' : '',
            onClick: function (e) { if (draggedRef.current) { draggedRef.current = false; return; } e.stopPropagation(); if (multiple) setMenuOpen(!menuOpen); },
          },
            React.createElement('span', { className: 'dsh-pu-logo ' + logoClass }, logoEl),
            React.createElement('span', { className: 'dsh-pu-card-title' }, title),
            multiple ? React.createElement('span', { className: 'caret' }, menuOpen ? '▴' : '▾') : null),
          React.createElement('span', { className: 'dsh-pu-chip ' + level + loadingCls }, React.createElement('i', null), chipText)),
        menu,
        body,
        React.createElement('div', { className: 'dsh-pu-card-foot' },
          React.createElement('span', { className: 'dsh-pu-meta' }, meta + ' · 每 ' + Math.round((s.refreshMs || 30000) / 1000) + 's'),
          React.createElement('button', { type: 'button', className: 'dsh-pu-refresh', title: zh.refresh, onClick: function () { if (draggedRef.current) { draggedRef.current = false; return; } load(true); } }, '↻')));
    }

    // ── 用量统计页（本地 Token 统计：DSH 会话日志折叠；只画可获取指标）──
    function fmtCnt(n) {
      n = Number(n) || 0;
      if (n >= 1000000000000) return (n / 1000000000000).toFixed(1).replace(/\.0$/, '') + 'T';
      if (n >= 1000000000) return (n / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B';
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      return String(n);
    }
    // 完整数字（千分位），点击缩略框时展示
    function fmtFull(n) {
      try { return (Number(n) || 0).toLocaleString('en-US'); }
      catch (e) { return String(Number(n) || 0); }
    }
    // 缩略数字框：点击在「缩写 ↔ 完整数字」之间切换；未缩略（<1000）时无需点击
    function FmtValue(props) {
      var value = Number(props.value) || 0;
      var short = fmtCnt(value);
      var long = fmtFull(value);
      var [full, setFull] = useState(false);
      if (short === long) return React.createElement('span', { className: props.className }, short);
      return React.createElement('span', {
        className: props.className,
        role: 'button',
        tabIndex: 0,
        'aria-label': full ? '收起完整数值' : '展开完整数值（' + long + '）',
        onClick: function () { setFull(!full); },
        onKeyDown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFull(!full); }
        },
      }, full ? long : short);
    }
    // 缩略数字卡片：点击整张卡片在「缩写 ↔ 完整数字」之间切换（未缩略时不可点击）
    function CntStatCard(props) {
      var value = Number(props.value) || 0;
      var short = fmtCnt(value);
      var long = fmtFull(value);
      var [full, setFull] = useState(false);
      function renderBody() {
        return [
          React.createElement('span', { className: 'zGbnIq_statValue' }, full ? long : short),
          React.createElement('span', { className: 'zGbnIq_statLabel' }, props.label),
        ];
      }
      if (short === long) return React.createElement('div', { key: props.label, className: 'zGbnIq_stat' }, renderBody());
      return React.createElement('div', {
        key: props.label,
        className: 'zGbnIq_stat zGbnIq_cntCard',
        role: 'button',
        tabIndex: 0,
        'aria-label': full ? '收起完整数值' : '展开完整数值（' + long + '）',
        onClick: function () { setFull(!full); },
        onKeyDown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFull(!full); }
        },
      }, renderBody());
    }
    function fmtPct(rate) {
      if (!(rate >= 0) || rate === null || rate === undefined) return '--';
      return (rate * 100).toFixed(1) + '%';
    }
    function UsageStatsPage(props) {
      var active = !!props.active;
      var [data, setData] = useState(null);
      var [loading, setLoading] = useState(false);
      var [err, setErr] = useState(null);
      var [provider, setProvider] = useState(''); // '' = 全部
      var [range, setRange] = useState('1'); // 默认近 1 天；'0'=全部 / '1'=近1天 / '7'=近7天 / '30'=近30天
      var dataRef = useRef(null); // 轮询静默刷新判定用（避免闭包陈旧）
      function setDataBoth(v) { dataRef.current = v; setData(v); }
      function load(force) {
        // 自然日语义：近 1 天 = 今天 00:00 起；近 7/30 天 = 今天 + 前 N-1 个完整自然日（0 点边界）
        var nowD = new Date(Date.now());
        var todayStart = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()).getTime();
        var since = range === '1' ? todayStart : (range === '7' ? todayStart - 6 * 86400000 : (range === '30' ? todayStart - 29 * 86400000 : 0));
        var q = '/api/provider-usage/local-usage?provider=' + encodeURIComponent(provider) + '&since=' + since + (force ? '&noCache=1' : '');
        // 有旧数据时静默刷新（不闪进度条/查询中文案）；首查或手动刷新才显示加载态
        if (!dataRef.current || force) setLoading(true);
        setErr(null);
        fetch(q, { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (j) {
            if (j && j.ok && j.detected !== false) { setDataBoth(j); if (j.error) setErr(j.error.message); }
            else if (j && j.error) { setErr(j.error.message || '无法读取本地用量统计'); }
            else { setErr('无法读取本地用量统计'); }
          })
          .catch(function () { setErr('读取失败'); })
          .finally(function () { setLoading(false); });
      }
      useEffect(function () { if (active) load(false); }, [active, provider, range]);
      useEffect(function () {
        if (!active) return undefined;
        var t = window.setInterval(function () { load(false); }, 30000);
        return function () { window.clearInterval(t); };
      }, [active, provider, range]);

      var total = data && data.totals ? data.totals : null;
      // host 按天物化聚合后直接给出 providers / byModel（不再有会话级数据）
      var provs = data && Array.isArray(data.providers) ? data.providers.slice() : [];
      provs.sort();
      var byModel = (data && data.byModel && typeof data.byModel === 'object') ? data.byModel : {};
      var modelNames = Object.keys(byModel).sort();
      // 按模型汇总表：列定义与表头标签同源,确保表头和每行 modelRow 严格列对齐
      // (列宽选择 44/52px 是历史决定;表头改 grid 后,任一数据列被内容撑大都会同步挤压表头)
      var MODEL_COLS = 'minmax(0,1.2fr) 44px 52px 52px 52px 52px';
      var MODEL_HEADERS = ['请求', '输入', '输出', '缓存读取', '命中率'];
      // 按模型汇总表头:6 列 grid,与下方 modelRow 一一对应(第 1 列为模型名,留空)
      // 抽成函数避免主 render 函数中嵌套过深,标签和列宽与数据行同源(MODEL_HEADERS / MODEL_COLS)
      function ModelHeader() {
        return React.createElement('div', {
          className: 'zGbnIq_modelCatalogMeta',
          style: { display: 'grid', gridTemplateColumns: MODEL_COLS, alignItems: 'center', gap: '6px' },
        },
          React.createElement('span', null),
          MODEL_HEADERS.map(function (label) { return React.createElement('span', { key: label }, label) }));
      }

      var chips = [React.createElement("button", { key: "", type: "button", className: "zGbnIq_chip", "data-active": provider === "" ? "true" : undefined, onClick: function () { setProvider(""); } }, "全部")];
      for (var ci = 0; ci < provs.length; ci++) {
        (function (pv) {
          chips.push(React.createElement("button", { key: pv, type: "button", className: "zGbnIq_chip", "data-active": provider === pv ? "true" : undefined, onClick: function () { setProvider(pv); } }, pv));
        })(provs[ci]);
      }

      var stats = null;
      if (total) {
        var statCells = [
          ["请求数", "text", String(total.requests)],
          ["输入", "cnt", total.inputTokens],
          ["输出", "cnt", total.outputTokens],
          ["缓存读取", "cnt", total.cacheReadTokens],
          ["命中率", "text", fmtPct(total.cacheHitRate)],
          ["真实总 token", "cnt", total.realTotalTokens],
        ].map(function (pair) {
          if (pair[1] === "cnt") {
            return React.createElement(CntStatCard, { key: pair[0], label: pair[0], value: pair[2] });
          }
          return React.createElement("div", { key: pair[0], className: "zGbnIq_stat" },
            React.createElement("span", { className: "zGbnIq_statValue" }, pair[2]),
            React.createElement("span", { className: "zGbnIq_statLabel" }, pair[0]));
        });
        stats = React.createElement("div", { className: "zGbnIq_statsGrid" }, statCells);
      }

      var modelRows = modelNames.map(function (mn) {
        var md = byModel[mn];
        var hit = (md.inputTokens + md.cacheReadTokens) > 0 ? md.cacheReadTokens / (md.inputTokens + md.cacheReadTokens) : 0;
        return React.createElement("div", { key: mn, className: "zGbnIq_modelRow", style: { gridTemplateColumns: MODEL_COLS } },
          React.createElement("span", { className: "zGbnIq_candidateId" }, mn),
          React.createElement("span", { className: "zGbnIq_statLabel" }, String(md.requests)),
          React.createElement(FmtValue, { value: md.inputTokens, className: "zGbnIq_statLabel" }),
          React.createElement(FmtValue, { value: md.outputTokens, className: "zGbnIq_statLabel" }),
          React.createElement(FmtValue, { value: md.cacheReadTokens, className: "zGbnIq_statLabel" }),
          React.createElement("span", { className: "zGbnIq_statLabel" }, fmtPct(hit)));
      });

      return React.createElement("div", null,
        React.createElement("div", { className: "zGbnIq_rowHead", style: { marginBottom: "4px" } },
          React.createElement("p", { className: "zGbnIq_intro", style: { flex: "1", margin: "0" } }, "统计 DSH 会话日志中的 Token 用量（本机解析；历史按天存储，只算当天）。" + (data && data.days ? " 已聚合 " + data.days + " 天数据。" : "")),
          React.createElement("select", { className: "zGbnIq_input zGbnIq_selectInput", style: { width: "auto" }, value: range, onChange: function (e) { setRange(e.target.value); } },
            React.createElement("option", { value: "1" }, "近 1 天"),
            React.createElement("option", { value: "7" }, "近 7 天"),
            React.createElement("option", { value: "30" }, "近 30 天"),
            React.createElement("option", { value: "0" }, "全部时间")),
          React.createElement("button", { type: "button", className: "zGbnIq_linkButton", onClick: function () { load(true); } }, "刷新")),
        loading ? React.createElement("div", null,
          React.createElement("div", { className: "zGbnIq_progress" }, React.createElement("i", null)),
          React.createElement("p", { className: "zGbnIq_advancedHint" }, "查询中…")) : null,
        err ? React.createElement("p", { className: "zGbnIq_error" }, err) : null,
        total ? React.createElement("div", null,
          React.createElement("div", { className: "zGbnIq_chips" }, chips),
          stats,
          React.createElement("div", { className: "zGbnIq_modelCatalog" },
            React.createElement("div", { className: "zGbnIq_modelCatalogHeading" },
              React.createElement("span", { className: "zGbnIq_modelCatalogTitle" }, "按模型汇总"),
              ModelHeader()),
            React.createElement("div", { className: "zGbnIq_modelList" }, modelRows))) : null,
        !total && !loading && !err && data ? React.createElement("div", { className: "zGbnIq_modelEmpty" }, "没有匹配的 DSH 会话。") : null);
    }
    // 提供方状态归一：dot 颜色/标签/可点击性/展开内容都从这里出,6 个 if-else 收敛为 1 个表
    // level: 'ok' 绿 / 'err' 红 / 'loading' 脉冲灰 / 'unknown' 静默灰
    // detailKind: 'err' 渲染红字错误, 'resp' 渲染 JSON 响应, null 不可展开
    // detailText: detailKind 非空时,errOpen 展开的纯文本(可序列化)
    function statusOf(refKnown, refCheckFailed, configured, qs) {
      if (!refKnown && refCheckFailed) {
        return { level: 'err',     label: '状态检查失败',  clickable: true,  detailKind: 'err', dotCls: ' zGbnIq_credentialDotMissing', detailText: '状态检查失败：无法读取 Key 配置状态。' };
      }
      if (!refKnown) {
        return { level: 'loading', label: '检查 Key…',     clickable: false, detailKind: null,  dotCls: ' dsh-pu-dot-loading',          detailText: null };
      }
      if (!configured) {
        return { level: 'unknown', label: 'Key 未配置',    clickable: false, detailKind: null,  dotCls: ' dsh-pu-dot-gray',              detailText: null };
      }
      if (!qs || qs.loading) {
        return { level: 'loading', label: '查询中…',        clickable: false, detailKind: null,  dotCls: ' dsh-pu-dot-loading',          detailText: null };
      }
      if (qs.ok) {
        return { level: 'ok',      label: '查询正常',      clickable: true,  detailKind: 'resp', dotCls: ' zGbnIq_credentialDotConfigured', detailText: typeof qs.resp === 'string' ? qs.resp : JSON.stringify(qs.resp || {}, null, 2) };
      }
      return { level: 'err',     label: '查询失败' + (qs.err ? '：' + qs.err : ''), clickable: true,  detailKind: 'err',  dotCls: ' zGbnIq_credentialDotMissing', detailText: '查询失败：' + (qs.err || '未知错误') };
    }
    function SettingsCard() {
      var s = useSettings();
      var providers = useProviders();
      var [refStatus, setRefStatus] = useState({});
      var [refCheckFailed, setRefCheckFailed] = useState(false);
      var [queryStatus, setQueryStatus] = useState({});
      var [errOpen, setErrOpen] = useState({}); // 展开的错误详情（按实例 id）
      var refsKey = providers.map(function (p) { return p.ref || ''; }).join(',');
      // 添加卡：mode = null | 'import' | 'manual'；编辑卡：edit = null | { id, kind, adapter, ref }
      var [mode, setMode] = useState(null);
      var [edit, setEdit] = useState(null);
      var [nonce, setNonce] = useState(0); // 改 Key 后 +1 → 全量强制刷新（noCache）
      var [dshItems, setDshItems] = useState([]);
      var [form, setForm] = useState({ provider: '', name: '', adapter: 'usage-percent', key: '', ref: '' });
      var [busy, setBusy] = useState(false);
      var [formError, setFormError] = useState(null);

      function removeProvider(p) {
        var next = providers.filter(function (x) { return x.id !== p.id; });
        if (p.source === 'vault' && p.ref) {
          // 删除自定义实例时同步清理插件私有库中的 Key（fire-and-forget）
          fetch('/api/provider-usage/credentials?ref=' + encodeURIComponent(p.ref), { headers: { accept: 'application/json' } })
            .catch(function () { /* ignore */ });
        }
        setProviders(next);
        if ((s.providerId || '') === p.id) setSettings({ providerId: next.length > 0 ? next[0].id : '' });
      }

      function openImport() {
        setMode('import');
        setEdit(null);
        setFormError(null);
        setBusy(true);
        fetch('/api/provider-usage/dsh-providers', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (j) {
            var items = j && Array.isArray(j.items) ? j.items : [];
            setDshItems(items);
            var first = items[0] || null;
            setForm({ provider: first ? first.route : '', name: first ? first.displayName : '', adapter: first ? first.adapter : 'usage-percent', key: '', ref: '', nameTouched: false });
          })
          .catch(function () { setDshItems([]); })
          .finally(function () { setBusy(false); });
      }
      function openManual() {
        setMode('manual');
        setEdit(null);
        setFormError(null);
        setForm({ provider: '', name: 'OpenCode Go', adapter: 'usage-percent', key: '', nameTouched: false });
      }
      function cancelAdd() { setMode(null); setEdit(null); setFormError(null); }

      async function saveImport() {
        if (!form.provider) { setFormError('请选择要导入的提供方'); return; }
        var name = form.name.trim();
        if (!name) { setFormError('请输入名称'); return; }
        var item = null;
        for (var i = 0; i < dshItems.length; i++) if (dshItems[i].route === form.provider) item = dshItems[i];
        if (!item) { setFormError('导入项不存在'); return; }
        var inst = { id: item.route + '-' + Date.now(), name: name, adapter: item.adapter, ref: item.ref, source: 'dsh', type: 'import' };
        setProviders(providers.concat([inst]));
        setSettings({ providerId: inst.id });
        setMode(null);
      }

      async function saveManual() {
        var name = form.name.trim();
        if (!name) { setFormError('请输入名称'); return; }
        if (!form.key) { setFormError('请输入 API 密钥值'); return; }
        var instId = form.adapter + '-' + Date.now();
        setBusy(true);
        setFormError(null);
        try {
          // 私有库键 = 实例 id（与 DSH 凭证完全隔离，无需递增/防重名）
          var resp = await fetch('/api/provider-usage/credentials', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ref: instId, value: form.key }),
          });
          var j = await resp.json().catch(function () { return null; });
          if (!j || !j.ok) { setFormError((j && j.error && j.error.message) || '保存 Key 失败'); return; }
          var inst = { id: instId, name: name, adapter: form.adapter, ref: instId, source: 'vault', type: 'manual' };
          setProviders(providers.concat([inst]));
          setSettings({ providerId: inst.id });
          setMode(null);
        } catch (e) {
          setFormError('保存 Key 失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }

      // ── 编辑：导入的只改名称；自定义（vault）可改名称 + 覆盖 Key ──
      function startEdit(p) {
        setMode(null);
        setEdit({ id: p.id, kind: p.type === 'manual' ? 'manual' : 'import', adapter: p.adapter, ref: p.ref });
        setForm({ provider: '', name: p.name, adapter: p.adapter, key: '', ref: p.ref, nameTouched: true });
        setFormError(null);
      }

      async function saveEdit() {
        if (!edit) return;
        var name = form.name.trim();
        if (!name) { setFormError('请输入名称'); return; }
        var keyChanged = edit.kind === 'manual' && form.key;
        if (keyChanged) {
          setBusy(true);
          setFormError(null);
          try {
            // 覆盖私有库中同一 ref 的值（不新建条目）
            var resp = await fetch('/api/provider-usage/credentials', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ref: edit.ref, value: form.key }),
            });
            var j = await resp.json().catch(function () { return null; });
            if (!j || !j.ok) { setFormError((j && j.error && j.error.message) || '保存 Key 失败'); return; }
          } catch (e) {
            setFormError('保存 Key 失败：' + String((e && e.message) || e));
            return;
          } finally {
            setBusy(false);
          }
        }
        setProviders(providers.map(function (p) { return p.id === edit.id ? Object.assign({}, p, { name: name }) : p; }));
        if (keyChanged) setNonce(function (n) { return n + 1; });
        setEdit(null);
        setForm({ provider: '', name: '', adapter: 'usage-percent', key: '', ref: '', nameTouched: false });
      }

      // ── 状态查询（打开设置页时：describe + 每实例实际查询）──
      useEffect(function () {
        var alive = true;
        var refs = [];
        providers.forEach(function (p) { if (p.ref && refs.indexOf(p.ref) < 0) refs.push(p.ref); });
        if (refs.length === 0) { setRefStatus({}); setRefCheckFailed(false); setQueryStatus({}); return undefined; }

        function startQueries(configuredMap, force) {
          var jobs = [];
          providers.forEach(function (p) {
            if (!p.ref) return;
            if (configuredMap && !configuredMap[p.ref]) return;
            var key = p.adapter + '|' + p.ref;
            setQueryStatus(function (prev) {
              var next = Object.assign({}, prev);
              next[key] = { loading: true };
              return next;
            });
            var qs = 'adapter=' + encodeURIComponent(p.adapter) + '&ref=' + encodeURIComponent(p.ref) + (p.source === 'vault' ? '&source=vault' : '') + (force ? '&noCache=1' : '');
            jobs.push(fetch('/api/provider-usage/query?' + qs, { headers: { accept: 'application/json' } })
              .then(function (r) { return r.json().catch(function () { return null; }); })
              .then(function (res) {
                if (!alive) return;
                setQueryStatus(function (prev) {
                  var next = Object.assign({}, prev);
                  next[key] = { ok: !!(res && res.ok), err: (res && res.error && res.error.message) || '', resp: res || null };
                  return next;
                });
              })
              .catch(function () {
                if (!alive) return;
                setQueryStatus(function (prev) {
                  var next = Object.assign({}, prev);
                  next[key] = { ok: false, err: '网络请求失败' };
                  return next;
                });
              }));
          });
          return Promise.all(jobs);
        }

        setRefCheckFailed(false);
        fetch('/api/provider-usage/credential-refs?refs=' + encodeURIComponent(refs.join(',')), { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (j) {
            if (!alive) return;
            if (j && Array.isArray(j.refs)) {
              var map = {};
              var storeMap = {};
              j.refs.forEach(function (x) { map[x.name] = !!x.configured; storeMap[x.name] = x.store; });
              setRefStatus(map);
              // 旧数据自愈：source 非 vault 但 Key 只存在插件私有库 → 升级为手动实例（可改名称+Key）
              var changed = false;
              var next = providers.map(function (p) {
                if (p.source === 'vault' || !p.ref) return p;
                if (storeMap[p.ref] === 'vault') { changed = true; return Object.assign({}, p, { source: 'vault' }); }
                return p;
              });
              if (changed) setProviders(next);
              return startQueries(map, nonce > 0);
            }
            return startQueries(null, nonce > 0);
          })
          .catch(function () {
            if (!alive) return;
            setRefCheckFailed(true);
            startQueries(null, nonce > 0);
          });
        return function () { alive = false; };
      }, [refsKey, nonce]);

      var adapterOptions = Object.keys(ADAPTER_META).map(function (a) {
        return React.createElement('option', { key: a, value: a }, ADAPTER_META[a].displayName);
      });

      var addCard = null;
      if (mode === 'import') {
        addCard = React.createElement('div', { className: 'zGbnIq_editor' },
          React.createElement('div', { className: 'zGbnIq_editorHeader' },
            React.createElement('span', { className: 'zGbnIq_editorTitle' }, '从 DSH 导入提供方')),
          busy ? React.createElement('p', { className: 'zGbnIq_advancedHint' }, '加载中…') : null,
          React.createElement('div', { className: 'zGbnIq_field' },
            React.createElement('span', { className: 'zGbnIq_fieldLabel' }, '提供方'),
            React.createElement('select', {
              className: 'zGbnIq_input zGbnIq_selectInput', value: form.provider,
                onChange: function (e) {
                  var item = null;
                  for (var i = 0; i < dshItems.length; i++) if (dshItems[i].route === e.target.value) item = dshItems[i];
                  setForm(Object.assign({}, form, { provider: e.target.value, adapter: item ? item.adapter : form.adapter, name: !form.nameTouched && item ? item.displayName : form.name }));
                },
              }, dshItems.map(function (it) {
                return React.createElement('option', { key: it.route, value: it.route }, it.displayName + (it.configured ? '（已配置）' : '（未配置）'));
            }))),
          React.createElement('div', { className: 'zGbnIq_field' },
            React.createElement('span', { className: 'zGbnIq_fieldLabel' }, '名称'),
            React.createElement('input', {
              className: 'zGbnIq_input', value: form.name,
              onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value, nameTouched: true })); },
            })),
          (function () {
            var sel = null;
            for (var i = 0; i < dshItems.length; i++) if (dshItems[i].route === form.provider) sel = dshItems[i];
            return sel ? React.createElement('div', { className: 'zGbnIq_field' },
              React.createElement('span', { className: 'zGbnIq_advancedHint' }, 'Key 将从 DSH 获取（' + sel.ref + '）')) : null;
          })(),
          formError ? React.createElement('p', { className: 'zGbnIq_error' }, formError) : null,
          React.createElement('div', { className: 'zGbnIq_editorActions' },
            React.createElement('button', { type: 'button', className: 'zGbnIq_secondaryButton', onClick: cancelAdd }, '取消'),
            React.createElement('button', { type: 'button', className: 'zGbnIq_primaryButton', disabled: busy, onClick: saveImport }, '保存')));
      } else if (mode === 'manual') {
        addCard = React.createElement('div', { className: 'zGbnIq_editor' },
          React.createElement('div', { className: 'zGbnIq_editorHeader' },
            React.createElement('span', { className: 'zGbnIq_editorTitle' }, '添加自定义提供方（手动 Key）')),
          React.createElement('p', { className: 'zGbnIq_advancedHint' }, 'Key 将加密保存到插件私有库（本机），查询时直接使用，不经过 DSH 凭证'),
          React.createElement('div', { className: 'zGbnIq_field' },
            React.createElement('span', { className: 'zGbnIq_fieldLabel' }, '提供方'),
            React.createElement('select', {
              className: 'zGbnIq_input zGbnIq_selectInput', value: form.adapter,
                onChange: function (e) {
                  var next = Object.assign({}, form, { adapter: e.target.value });
                  if (!form.nameTouched) next.name = e.target.value === 'balance-json' ? 'DeepSeek' : 'OpenCode Go';
                  setForm(next);
                },
            }, adapterOptions)),
          React.createElement('div', { className: 'zGbnIq_field' },
            React.createElement('span', { className: 'zGbnIq_fieldLabel' }, '名称'),
            React.createElement('input', {
              className: 'zGbnIq_input', value: form.name,
              onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value, nameTouched: true })); },
            })),
          React.createElement('div', { className: 'zGbnIq_field' },
            React.createElement('span', { className: 'zGbnIq_fieldLabel' }, 'API 密钥'),
            React.createElement('input', {
              type: 'password', className: 'zGbnIq_input', value: form.key,
              placeholder: '输入 API 密钥',
              autoComplete: 'off',
              onChange: function (e) { setForm(Object.assign({}, form, { key: e.target.value })); },
            })),
          formError ? React.createElement('p', { className: 'zGbnIq_error' }, formError) : null,
          React.createElement('div', { className: 'zGbnIq_editorActions' },
            React.createElement('button', { type: 'button', className: 'zGbnIq_secondaryButton', onClick: cancelAdd }, '取消'),
            React.createElement('button', { type: 'button', className: 'zGbnIq_primaryButton', disabled: busy, onClick: saveManual }, '保存')));
      } else if (edit) {
        var editManual = edit.kind === 'manual';
        addCard = React.createElement('div', { className: 'zGbnIq_editor' },
          React.createElement('div', { className: 'zGbnIq_editorHeader' },
            React.createElement('span', { className: 'zGbnIq_editorTitle' }, editManual ? '编辑自定义提供方' : '编辑提供方')),
          editManual
            ? React.createElement('p', { className: 'zGbnIq_advancedHint' }, 'Key 加密保存在插件私有库（本机）；输入新 Key 即覆盖，留空表示不修改')
            : React.createElement('p', { className: 'zGbnIq_advancedHint' }, 'Key 继续从 DSH 获取（' + edit.ref + '），这里只改名称'),
          React.createElement('div', { className: 'zGbnIq_field' },
            React.createElement('span', { className: 'zGbnIq_fieldLabel' }, '提供方'),
            React.createElement('select', { className: 'zGbnIq_input zGbnIq_selectInput', value: edit.adapter, disabled: true }, adapterOptions)),
          React.createElement('div', { className: 'zGbnIq_field' },
            React.createElement('span', { className: 'zGbnIq_fieldLabel' }, '名称'),
            React.createElement('input', {
              className: 'zGbnIq_input', value: form.name,
              onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value, nameTouched: true })); },
            })),
          editManual ? React.createElement('div', { className: 'zGbnIq_field' },
            React.createElement('span', { className: 'zGbnIq_fieldLabel' }, 'API 密钥'),
            React.createElement('input', {
              type: 'password', className: 'zGbnIq_input', value: form.key,
              placeholder: '留空则不修改', autoComplete: 'off',
              onChange: function (e) { setForm(Object.assign({}, form, { key: e.target.value })); },
            })) : null,
          formError ? React.createElement('p', { className: 'zGbnIq_error' }, formError) : null,
          React.createElement('div', { className: 'zGbnIq_editorActions' },
            React.createElement('button', { type: 'button', className: 'zGbnIq_secondaryButton', onClick: cancelAdd }, '取消'),
            React.createElement('button', { type: 'button', className: 'zGbnIq_primaryButton', disabled: busy, onClick: saveEdit }, '保存')));
      }

      // 插件页同款二级菜单（官方 dsh-client-ui-settings-plugins 结构）：提供方设置 / 用量统计 两个互不影响的分页
      var tabsList = [
        { id: 'providers', label: '提供方设置' },
        { id: 'usage', label: '用量统计' },
      ];
      var [tab, setTab] = useState('providers');
      var tabsRef = useRef([]);
      function onTabKey(e, idx) {
        var len = tabsList.length;
        var next = null;
        if (e.key === 'ArrowRight') next = (idx + 1) % len;
        else if (e.key === 'ArrowLeft') next = (idx - 1 + len) % len;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = len - 1;
        else return;
        e.preventDefault();
        var t = tabsList[next];
        setTab(t.id);
        var el = tabsRef.current[next];
        if (el && el.focus) el.focus();
      }

      // 页面 1：提供方设置（原设置页内容原样保留，两页互不影响）
      var providersPanel = React.createElement('div', { className: 'zGbnIq_section' },
          React.createElement('h2', { className: 'zGbnIq_title' }, '提供方'),
          React.createElement('p', { className: 'zGbnIq_intro' }, '填入各供应方的 Key 引用即可查询其用量与余额。'),
          React.createElement('ul', { className: 'zGbnIq_rows' },
            providers.length === 0
              ? React.createElement('li', { className: 'zGbnIq_rowCard' },
                  React.createElement('span', { className: 'zGbnIq_rowName' }, '暂无提供方，点击下方按钮添加'))
              : providers.map(function (pl) {
              var qs = pl.ref ? queryStatus[pl.adapter + '|' + pl.ref] : null;
              var refKnownRow = pl.ref ? Object.prototype.hasOwnProperty.call(refStatus, pl.ref) : true;
              var status = pl.ref ? statusOf(refKnownRow, refCheckFailed, !!refStatus[pl.ref], qs) : null;
              return React.createElement(ProviderRow, {
                key: pl.id,
                provider: pl,
                status: status,
                expanded: !!errOpen[pl.id],
                onToggle: function () { setErrOpen(function (prev) { var n = Object.assign({}, prev); n[pl.id] = !prev[pl.id]; return n; }); },
                onEdit: function () { startEdit(pl); },
                onRemove: function () { removeProvider(pl); },
              });
            })),
          (mode || edit) ? addCard : React.createElement('div', { className: 'zGbnIq_addBlock' },
            React.createElement('div', { className: 'zGbnIq_addActions' },
              React.createElement('button', { type: 'button', className: 'zGbnIq_addButton', onClick: openImport },
                React.createElement('span', { className: 'ms-plus' }, '＋'), '从 DSH 导入提供方'),
              React.createElement('button', { type: 'button', className: 'zGbnIq_addButton', onClick: openManual },
                React.createElement('span', { className: 'ms-plus' }, '＋'), '添加自定义提供方'))));

      // 页面 2：用量统计（本地 Token 统计；active 时才加载/轮询，切页不互相干扰）
      var usagePanel = React.createElement('div', { className: 'pbvGtq_panel', role: 'tabpanel', id: 'pu-tab-usage', 'aria-labelledby': 'pu-tab-btn-usage', hidden: tab !== 'usage' },
        React.createElement(UsageStatsPage, { active: tab === 'usage' }));

      // 二级菜单（插件页同款：下划线高亮 + 方向键切换）
      var tabsBar = React.createElement('div', { className: 'pbvGtq_tabs', role: 'tablist', 'aria-label': '用量中心视图' },
        tabsList.map(function (t, idx) {
          var active = t.id === tab;
          return React.createElement('button', {
            key: t.id,
            ref: function (el) { tabsRef.current[idx] = el; },
            id: 'pu-tab-btn-' + t.id, type: 'button', role: 'tab',
            className: 'pbvGtq_tab',
            'aria-selected': active ? 'true' : 'false',
            'aria-controls': 'pu-tab-' + t.id,
            tabIndex: active ? 0 : -1,
            'data-active': active ? 'true' : undefined,
            onClick: function () { setTab(t.id); },
            onKeyDown: function (e) { onTabKey(e, idx); },
          }, t.label);
        }));

      return React.createElement('div', { className: 'pbvGtq_section' },
        React.createElement('h2', { className: 'pbvGtq_heading' }, '用量中心'),
        React.createElement('p', { className: 'pbvGtq_intro' }, '管理提供方并查看本地用量统计。'),
        tabsBar,
        React.createElement('div', { className: 'pbvGtq_panel', role: 'tabpanel', id: 'pu-tab-providers', 'aria-labelledby': 'pu-tab-btn-providers', hidden: tab !== 'providers' }, providersPanel),
        usagePanel);
    }
    // 提供方单行：状态点 + 名称 + 编辑/删除 + 展开详情
    // 状态判定全部交给 statusOf；本组件只做渲染
    function ProviderRow(props) {
      var pl = props.provider;
      var status = props.status;
      var expanded = props.expanded;
      var onToggle = props.onToggle;
      var onEdit = props.onEdit;
      var onRemove = props.onRemove;
      var dotEl = status.dotCls ? React.createElement('span', {
        className: 'zGbnIq_credentialDot' + status.dotCls,
        role: 'img', 'aria-label': status.label,
        style: status.clickable ? { cursor: 'pointer' } : undefined,
        onClick: status.clickable ? onToggle : undefined,
      }) : null;
      var detailEl = null;
      if (expanded && status.detailKind) {
        if (status.detailKind === 'err') {
          detailEl = React.createElement('p', { className: 'zGbnIq_error', style: { margin: '10px 0 0' } }, status.detailText);
        } else if (status.detailKind === 'resp') {
          detailEl = React.createElement('div', { className: 'zGbnIq_json' }, status.detailText);
        }
      }
      return React.createElement('li', { key: pl.id, className: 'zGbnIq_rowCard' },
        React.createElement('div', { className: 'zGbnIq_rowHead' },
          React.createElement('span', { className: 'zGbnIq_rowIdentity' },
            React.createElement('span', { className: 'zGbnIq_rowName' }, pl.name),
            dotEl),
          React.createElement('span', { className: 'zGbnIq_rowActions' },
            React.createElement('button', { type: 'button', className: 'zGbnIq_secondaryButton', onClick: onEdit }, '编辑'),
            React.createElement('button', { type: 'button', className: 'zGbnIq_dangerButton', onClick: onRemove }, '删除'))),
        detailEl);
    }
    // ── 挂载：用量卡片走 body 顶层 React root（与 dsh-pet 同构），设置页走插槽 ──
    function apply(ctx) {
      var rootEl = null;
      var reactRoot = null;

      // 与 dsh-pet 完全一致的挂载方式：document.body 上自建 root。
      // 这样用量卡片与 better-sidebar / pet 同处 body 顶层（z-index: 2147483000），
      // 不再被 shell.overlay 的 z-index:20 层叠上下文困住。
      function mount() {
        if (reactRoot) { try { reactRoot.unmount(); } catch (e) { /* ignore */ } reactRoot = null; }
        if (rootEl && rootEl.isConnected) { try { rootEl.remove(); } catch (e) { /* ignore */ } }
        rootEl = document.createElement('div');
        rootEl.setAttribute('data-provider-usage-root', '');
        document.body.appendChild(rootEl);
        reactRoot = createRoot(rootEl);
        reactRoot.render(React.createElement(UsageCard));
      }

      function ensureMounted() {
        try {
          if (!getSettings().visible) return; // 用户主动隐藏，不自动复活
          if (getProviders().length === 0) return; // 无提供方实例：卡片本就渲染 null，避免 10s 空转重挂
          if (rootEl && rootEl.isConnected && document.querySelector('.dsh-pu-card')) return;
          mount();
        } catch (e) {
          console.warn('[dsh-provider-usage] re-mount failed:', e);
        }
      }

      try { mount(); } catch (e) {
        console.warn('[dsh-provider-usage] body mount failed:', e);
      }

      var disposers = [];
      try {
        disposers.push(ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: 'provider-usage-settings', order: 40, label: function () { return zh.nav; } },
            function () { return React.createElement(SettingsCard); });
        }));
      } catch (e) {
        console.warn('[dsh-provider-usage] settings section mount failed:', e);
      }

      ctx.effect(function () {
        var timer = window.setInterval(ensureMounted, 10000);
        return function () {
          window.clearInterval(timer);
          if (reactRoot) { try { reactRoot.unmount(); } catch (e) { /* ignore */ } reactRoot = null; }
          if (rootEl && rootEl.isConnected) { try { rootEl.remove(); } catch (e) { /* ignore */ } rootEl = null; }
          for (var i = 0; i < disposers.length; i++) { try { disposers[i](); } catch (e) { /* ignore */ } }
        };
      }, 'dsh-provider-usage: ui mounts');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
