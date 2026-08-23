// dsh-provider-usage — Client half (M1.1).
// 右下角悬浮鲸鱼 🐳（可拖动、位置记忆 localStorage）；点击弹出用量对话框。
// - 拖动：按住拖动换位置，松手持久化（dsh-pet 同款交互）
// - 默认位置 right:24 / bottom:120 —— 避开右下角官方退出按钮区
// - 自愈看门狗：每 10s 检查鲸鱼是否还在 DOM，丢了自动重新注册
// - 点击时查询（Host 30s 缓存复用），面板打开期间 30s 自动刷新

window.__ModuleLoader__.load({
  id: 'dsh-provider-usage',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'settings.providerUsage';
    const inject = ['slots'];
    const POS_KEY = 'dsh-provider-usage.pos';
    const BADGE_SIZE = 56;

    const zh = {
      title: 'OpenCode Go 用量',
      loading: '查询中…',
      refresh: '刷新',
      close: '关闭',
      stale: '未更新',
      remaining: '剩余',
      rolling: '5小时滚动',
      weekly: '7天（每周）',
      monthly: '每月',
      errorTitle: '无法获取用量',
    };
    const en = {
      title: 'OpenCode Go Usage',
      loading: 'Querying…',
      refresh: 'Refresh',
      close: 'Close',
      stale: 'stale',
      remaining: 'Remaining',
      rolling: '5-hour rolling',
      weekly: '7-day (weekly)',
      monthly: 'Monthly',
      errorTitle: 'Failed to fetch usage',
    };

    var styleId = 'dsh-provider-usage/styles.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + styleId + '"]') === null) {
      var css = [
        '.dsh-pu-badge{position:fixed;width:' + BADGE_SIZE + 'px;height:' + BADGE_SIZE + 'px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;cursor:grab;user-select:none;touch-action:none;pointer-events:auto;background:linear-gradient(135deg,#3b7cff,#2563eb);border:2px solid rgba(255,255,255,.25);box-shadow:0 6px 20px rgba(37,99,235,.35);z-index:9999;transition:transform .15s ease}',
        '.dsh-pu-badge:hover{transform:scale(1.06)}',
        '.dsh-pu-badge.dragging{cursor:grabbing;transform:none;transition:none}',
        '.dsh-pu-backdrop{position:fixed;inset:0;z-index:9998;background:transparent;pointer-events:auto}',
        '.dsh-pu-dialog{position:fixed;width:330px;max-height:70vh;overflow:auto;border-radius:14px;z-index:9997;pointer-events:auto;background:var(--dsw-alias-bg-overlay,#1c2333);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 12px 36px rgba(0,0,0,.35);padding:14px 16px;font-family:inherit;color:var(--dsw-alias-label-primary,#e6e9f2);font-size:13px;line-height:1.5}',
        '.dsh-pu-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}',
        '.dsh-pu-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}',
        '.dsh-pu-dot{width:8px;height:8px;border-radius:50%;flex:none}',
        '.dsh-pu-dot.ok{background:#22c55e}.dsh-pu-dot.warn{background:#f59e0b}.dsh-pu-dot.err{background:#ef4444}',
        '.dsh-pu-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a7);white-space:nowrap}',
        '.dsh-pu-remain{display:flex;align-items:baseline;gap:8px;margin:6px 0 10px}',
        '.dsh-pu-remain-big{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;color:#22c55e}',
        '.dsh-pu-remain-label{font-size:12px;color:var(--dsw-alias-label-secondary,#aab2c5)}',
        '.dsh-pu-row{display:grid;grid-template-columns:74px 1fr 96px;align-items:center;gap:8px;margin:7px 0}',
        '.dsh-pu-row-label{font-size:12px;color:var(--dsw-alias-label-secondary,#aab2c5);white-space:nowrap}',
        '.dsh-pu-bar{height:7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));overflow:hidden}',
        '.dsh-pu-bar-fill{height:100%;border-radius:999px;transition:width .3s}',
        '.dsh-pu-bar-fill.ok{background:#22c55e}.dsh-pu-bar-fill.warn{background:#f59e0b}.dsh-pu-bar-fill.err{background:#ef4444}',
        '.dsh-pu-row-values{font-size:11px;color:var(--dsw-alias-label-secondary,#aab2c5);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.dsh-pu-reset{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a7);text-align:right;white-space:nowrap;grid-column:3}',
        '.dsh-pu-extra{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));font-size:12px;color:var(--dsw-alias-label-secondary,#aab2c5);white-space:pre-wrap}',
        '.dsh-pu-error{border:1px solid var(--dsw-alias-border-l1,rgba(239,68,68,.4));border-radius:10px;padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#aab2c5)}',
        '.dsh-pu-error b{color:#ef4444}',
        '.dsh-pu-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px}',
        '.dsh-pu-btn{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15));background:transparent;color:var(--dsw-alias-label-primary,#e6e9f2);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;cursor:pointer}',
        '.dsh-pu-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
        '.dsh-pu-diag{font-size:10px;color:var(--dsw-alias-label-tertiary,#6b7385);margin-top:8px;line-height:1.4}',
      ].join('');
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-provider-usage';
      tag.dataset.pluginCss = styleId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function fmtTime(ms) {
      if (!ms) return '-';
      var d = new Date(ms);
      var hh = String(d.getHours()).padStart(2, '0');
      var mm = String(d.getMinutes()).padStart(2, '0');
      var ss = String(d.getSeconds()).padStart(2, '0');
      return hh + ':' + mm + ':' + ss;
    }

    function toneOf(remainingPct) {
      if (remainingPct === null) return 'err';
      if (remainingPct >= 50) return 'ok';
      if (remainingPct >= 20) return 'warn';
      return 'err';
    }

    function clampPos(left, top) {
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      left = Math.max(8, Math.min(left, vw - BADGE_SIZE - 8));
      top = Math.max(8, Math.min(top, vh - BADGE_SIZE - 8));
      return { left: left, top: top };
    }

    function loadPos() {
      try {
        var saved = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null');
        if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
          return clampPos(saved.left, saved.top);
        }
      } catch (e) { /* ignore */ }
      // 默认：right:24 / bottom:120 —— 避开右下角官方退出按钮区
      return clampPos(window.innerWidth - BADGE_SIZE - 24, window.innerHeight - BADGE_SIZE - 120);
    }

    function WindowRow(props) {
      var label = props.label;
      var win = props.win || {};
      var used = win.usedPct;
      var remain = win.remainingPct;
      var resetsAt = win.resetsAt;
      var limited = win.status === 'rate-limited';
      var tone = limited ? 'err' : toneOf(remain);
      return React.createElement('div', { className: 'dsh-pu-row' },
        React.createElement('span', { className: 'dsh-pu-row-label' }, label),
        React.createElement('div', { className: 'dsh-pu-bar' },
          React.createElement('div', {
            className: 'dsh-pu-bar-fill ' + tone,
            style: { width: Math.min(100, used === null ? 0 : used) + '%' },
          })),
        React.createElement('span', { className: 'dsh-pu-row-values' },
          (used === null ? '--' : Math.round(used) + '%') +
          ' · ' + (remain === null ? '--' : Math.round(remain) + '%')),
        React.createElement('span', { className: 'dsh-pu-reset' },
          resetsAt ? '重置 ' + fmtTime(new Date(resetsAt).getTime()) : ''),
      );
    }

    function WhaleBadge() {
      var [pos, setPos] = useState(loadPos);
      var [open, setOpen] = useState(false);
      var [data, setData] = useState(null);
      var [loading, setLoading] = useState(false);
      var [loadError, setLoadError] = useState(null);
      var [dragging, setDragging] = useState(false);
      var dragRef = useRef(null);

      var load = useCallback(function () {
        setLoading(true);
        fetch('/api/provider-usage/opencode-go', { headers: { accept: 'application/json' } })
          .then(function (res) { return res.json().catch(function () { return null; }); })
          .then(function (json) {
            setData(json);
            setLoadError(null);
          })
          .catch(function (e) {
            setLoadError(String((e && e.message) || e));
          })
          .finally(function () { setLoading(false); });
      }, []);

      useEffect(function () {
        if (!open) return undefined;
        load();
        var timer = window.setInterval(load, 30000);
        return function () { window.clearInterval(timer); };
      }, [open, load]);

      function onPointerDown(e) {
        e.stopPropagation();
        try { e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          left: pos.left,
          top: pos.top,
          moved: false,
        };
      }

      function onPointerMove(e) {
        var d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        var dx = e.clientX - d.startX;
        var dy = e.clientY - d.startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
        if (d.moved) {
          setDragging(true);
          setPos(clampPos(d.left + dx, d.top + dy));
        }
      }

      function onPointerUp(e) {
        var d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        dragRef.current = null;
        if (d.moved) {
          setDragging(false);
          try { window.localStorage.setItem(POS_KEY, JSON.stringify(clampPos(d.left + (e.clientX - d.startX), d.top + (e.clientY - d.startY)))); } catch (err) { /* ignore */ }
          return;
        }
        setOpen(function (v) { return !v; });
      }

      var dialogStyle = null;
      if (pos) {
        var vw = window.innerWidth;
        var left = Math.max(8, Math.min(pos.left - 300 + 28, vw - 330 - 8));
        var top = pos.top >= 420 ? Math.max(8, pos.top - BADGE_SIZE - 16 - 340) : pos.top + BADGE_SIZE + 10;
        dialogStyle = { left: left, top: top };
      }

      return React.createElement(React.Fragment, null,
        React.createElement('div', {
          className: 'dsh-pu-badge' + (dragging ? ' dragging' : ''),
          style: pos ? { left: pos.left, top: pos.top } : null,
          title: 'OpenCode Go 用量（拖动可换位置）',
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
          onPointerCancel: onPointerUp,
        }, '🐳'),
        open ? React.createElement('div', {
          className: 'dsh-pu-backdrop',
          onClick: function (e) { e.stopPropagation(); setOpen(false); },
        }) : null,
        open ? React.createElement('div', { className: 'dsh-pu-dialog', style: dialogStyle, onClick: function (e) { e.stopPropagation(); } },
          React.createElement(UsageDialog, {
            data: data, loading: loading, loadError: loadError, load: load, onClose: function () { setOpen(false); },
          }),
        ) : null,
      );
    }

    function UsageDialog(props) {
      var data = props.data;
      var loading = props.loading;
      var loadError = props.loadError;
      var load = props.load;
      var onClose = props.onClose;

      var dot = 'ok';
      if (!data || !data.ok) dot = data && data.stale ? 'warn' : 'err';
      else if (data.stale) dot = 'warn';

      var meta = '';
      if (data && data.fetchedAt) meta = fmtTime(data.fetchedAt) + (data.stale ? ' · ' + zh.stale : '');
      else meta = zh.loading;

      var body = null;
      if (loading && !data) {
        body = React.createElement('div', null, zh.loading);
      } else if (!data && loadError) {
        body = React.createElement('div', { className: 'dsh-pu-error' },
          React.createElement('b', null, zh.errorTitle + '：'), String(loadError),
        );
      } else if (data && !data.ok && !data.stale) {
        var em = (data.error && data.error.message) || '未知错误';
        body = React.createElement('div', { className: 'dsh-pu-error' },
          React.createElement('b', null, zh.errorTitle + '：'), ' ' + em,
        );
      } else if (data && data.ok) {
        body = React.createElement('div', null,
          React.createElement('div', { className: 'dsh-pu-remain' },
            React.createElement('span', { className: 'dsh-pu-remain-big' },
              data.remaining === null ? '--' : Math.round(data.remaining) + '%'),
            React.createElement('span', { className: 'dsh-pu-remain-label' }, ' ' + zh.remaining + '（' + zh.monthly + '）'),
          ),
          React.createElement(WindowRow, { label: zh.rolling, win: data.windows && data.windows.rolling }),
          React.createElement(WindowRow, { label: zh.weekly, win: data.windows && data.windows.weekly }),
          React.createElement(WindowRow, { label: zh.monthly, win: data.windows && data.windows.monthly }),
          data.extra ? React.createElement('div', { className: 'dsh-pu-extra' }, data.extra) : null,
        );
      }

      var diag = '';
      if (data && data.credential && data.credential.source) {
        var last = data.snapshots && data.snapshots.length > 0 ? data.snapshots[data.snapshots.length - 1] : null;
        diag = '凭证: ' + data.credential.source + (data.credential.keyHint ? ' (' + data.credential.keyHint + ')' : '') +
          (last && last.httpStatus ? ' · HTTP ' + last.httpStatus : '');
      }

      return React.createElement('div', null,
        React.createElement('div', { className: 'dsh-pu-head' },
          React.createElement('span', { className: 'dsh-pu-title' },
            React.createElement('span', { className: 'dsh-pu-dot ' + dot }), ' ' + zh.title),
          React.createElement('span', { className: 'dsh-pu-meta' }, meta),
        ),
        body,
        diag ? React.createElement('div', { className: 'dsh-pu-diag' }, diag) : null,
        React.createElement('div', { className: 'dsh-pu-footer' },
          React.createElement('span', { className: 'dsh-pu-meta' }, '每 30 秒自动刷新 · 可拖动'),
          React.createElement('span', null,
            React.createElement('button', { type: 'button', className: 'dsh-pu-btn', onClick: function (e) { e.stopPropagation(); load(); } }, zh.refresh),
            ' ',
            React.createElement('button', { type: 'button', className: 'dsh-pu-btn', onClick: function (e) { e.stopPropagation(); onClose(); } }, zh.close),
          ),
        ),
      );
    }

    function apply(ctx) {
      var registered = null;

      function mount() {
        registered = ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: 'provider-usage-badge', order: 50 },
            function () { return React.createElement(WhaleBadge); },
          );
        });
      }

      function ensureMounted() {
        try {
          if (document.querySelector('.dsh-pu-badge')) return;
          if (registered) {
            try { registered(); } catch (e) { /* ignore */ }
            registered = null;
          }
          mount();
        } catch (e) {
          console.warn('[dsh-provider-usage] re-mount failed:', e);
        }
      }

      try { mount(); } catch (e) {
        console.warn('[dsh-provider-usage] slot mount failed:', e);
      }

      ctx.effect(function () {
        var timer = window.setInterval(ensureMounted, 10000);
        return function () {
          window.clearInterval(timer);
          if (registered) {
            try { registered(); } catch (e) { /* ignore */ }
            registered = null;
          }
        };
      }, 'dsh-provider-usage: ui watchdog');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
