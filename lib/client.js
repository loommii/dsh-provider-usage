// dsh-provider-usage — Client half (M1.5).
// 悬浮鲸鱼 🐳（可拖动、位置记忆）+ 设置页（设置 → 「OpenCode Go 用量」）。
// 设置项全部即时生效（localStorage 持久化，无需重启）：
//   显示/隐藏、z-index、尺寸、面板刷新间隔、重置位置、状态诊断。

window.__ModuleLoader__.load({
  id: 'dsh-provider-usage',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const { useState, useEffect, useLayoutEffect, useCallback, useRef } = React;

    const inject = ['slots'];
    const POS_KEY = 'dsh-provider-usage.pos';
    const SETTINGS_KEY = 'dsh-provider-usage.settings';
    const DEFAULT_SETTINGS = { visible: true, zIndex: 2147483000, size: 160, refreshMs: 30000, posEpoch: 0, settingsVersion: 2 };
    const Z_MAX = 2147483000;
    // 与 dsh-pet 一致的显示参数（DISPLAY_SIZE_MIN/MAX；right/bottom 默认 24/20）
    const SIZE_MIN = 32, SIZE_MAX = 512;

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
      nav: 'OpenCode Go 用量',
      settingsTitle: 'OpenCode Go 用量 · 设置',
      secVisible: '显示悬浮鲸鱼',
      secZ: 'z-index（层级）',
      secSize: '鲸鱼尺寸（px）',
      secRefresh: '面板自动刷新间隔',
      secPos: '位置',
      btnResetPos: '重置到右下角',
      btnDefaults: '恢复默认设置',
      hintZ: '越大越靠上；建议 9999 ~ 2147483000。DSH 官方宠物使用 2147483000。',
      hintInstant: '所有设置即时生效（保存在本机浏览器，无需重启）。',
      statusTitle: '当前状态',
      source: '数据源',
      keyFrom: '凭证来源',
      httpNow: '最近一次 HTTP',
      updatedAt: '更新于',
      noConfig: '—',
      diag: '诊断',
    };

    var styleId = 'dsh-provider-usage/styles.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + styleId + '"]') === null) {
      var css = [
        '.dsh-pu-badge{position:fixed;display:flex;align-items:center;justify-content:center;cursor:grab;user-select:none;touch-action:none;pointer-events:auto;transition:transform .15s ease}',
        '.dsh-pu-badge:hover{transform:scale(1.06)}',
        '.dsh-pu-sprite{background-repeat:no-repeat;pointer-events:none;filter:drop-shadow(0 4px 10px rgba(37,99,235,.35))}',
        '.dsh-pu-badge.dragging{cursor:grabbing;transform:none;transition:none}',
        '.dsh-pu-backdrop{position:fixed;inset:0;background:transparent;pointer-events:auto}',
        '.dsh-pu-dialog{position:fixed;width:330px;max-height:70vh;overflow:auto;border-radius:14px;pointer-events:auto;background:var(--dsw-alias-bg-overlay,#1c2333);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 12px 36px rgba(0,0,0,.35);padding:14px 16px;font-family:inherit;color:var(--dsw-alias-label-primary,#e6e9f2);font-size:13px;line-height:1.5}',
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
        // settings page
        '.dsh-pus{max-width:640px;display:flex;flex-direction:column;gap:14px;font-family:inherit}',
        '.dsh-pus h3{margin:0;font-size:15px;font-weight:600}',
        '.dsh-pus-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:10px}',
        '.dsh-pus-label{font-size:13px;color:var(--dsw-alias-label-primary,#e6e9f2)}',
        '.dsh-pus-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a7);margin-top:4px}',
        '.dsh-pus-input{width:110px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.05));color:var(--dsw-alias-label-primary,#e6e9f2);padding:5px 8px;font:inherit;font-size:12px}',
        '.dsh-pus-status{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#aab2c5)}',
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
        if (s && typeof s === 'object' && s.settingsVersion === DEFAULT_SETTINGS.settingsVersion) {
          return Object.assign({}, DEFAULT_SETTINGS, s);
        }
        // 设置结构升级：对齐 dsh-pet 默认（size 160 / right 24 / bottom 20），位置一并重置
        if (s && typeof s === 'object') {
          try { window.localStorage.removeItem(POS_KEY); } catch (e) { /* ignore */ }
          return Object.assign({}, DEFAULT_SETTINGS, {
            visible: typeof s.visible === 'boolean' ? s.visible : true,
            zIndex: typeof s.zIndex === 'number' ? s.zIndex : DEFAULT_SETTINGS.zIndex,
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

    // ── 工具 ──────────────────────────────────────────────────────────
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
    function clampPos(left, top, size) {
      var vw = window.innerWidth, vh = window.innerHeight;
      left = Math.max(8, Math.min(left, vw - size - 8));
      top = Math.max(8, Math.min(top, vh - size - 8));
      return { left: left, top: top };
    }
    function loadPos(size) {
      try {
        var saved = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null');
        if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
          return clampPos(saved.left, saved.top, size);
        }
      } catch (e) { /* ignore */ }
      // 默认：right:24 / bottom:20（与 dsh-pet 默认一致）
      return clampPos(window.innerWidth - size - 24, window.innerHeight - size - 20, size);
    }

    function WindowRow(props) {
      var label = props.label, win = props.win || {};
      var used = win.usedPct, remain = win.remainingPct, resetsAt = win.resetsAt;
      var limited = win.status === 'rate-limited';
      var tone = limited ? 'err' : toneOf(remain);
      return React.createElement('div', { className: 'dsh-pu-row' },
        React.createElement('span', { className: 'dsh-pu-row-label' }, label),
        React.createElement('div', { className: 'dsh-pu-bar' },
          React.createElement('div', { className: 'dsh-pu-bar-fill ' + tone, style: { width: Math.min(100, used === null ? 0 : used) + '%' } })),
        React.createElement('span', { className: 'dsh-pu-row-values' },
          (used === null ? '--' : Math.round(used) + '%') + ' · ' + (remain === null ? '--' : Math.round(remain) + '%')),
        React.createElement('span', { className: 'dsh-pu-reset' },
          resetsAt ? '重置 ' + fmtTime(new Date(resetsAt).getTime()) : ''));
    }

    // ── 鲸鱼娘（精致版）精灵动画 ─────────────────────────────────────
    // 图集布局：8 列 × 9 行；行序 0 idle / 1 running-right / 2 running-left /
    // 3 waving / 4 jumping / 5 failed / 6 waiting / 7 running / 8 review。
    var TRACK_ROW = { idle: 0, 'running-right': 1, 'running-left': 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };
    var FALLBACK_MANIFEST = {
      sprite2d: {
        frames: [6, 8, 8, 4, 5, 8, 6, 6, 6],
        tracks: {
          idle: { durations: [500, 500, 600, 500, 500, 600] },
          waving: { durations: [450, 450, 450, 450] },
        },
      },
    };
    var SPRITE_URL = '/api/provider-usage/asset/whale-refined/spritesheet.webp';
    var MANIFEST_URL = '/api/provider-usage/asset/whale-refined/pet.json';

    function Sprite(props) {
      var size = props.size;
      var waveSignal = props.waveSignal || 0;
      var [manifest, setManifest] = useState(null);
      var [state, setState] = useState({ track: 'idle', frame: 0 });

      useEffect(function () {
        fetch(MANIFEST_URL, { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (j) { if (j && j.sprite2d) setManifest(j); })
          .catch(function () { /* fallback */ });
        var img = new Image();
        img.src = SPRITE_URL;
      }, []);

      // 点击触发挥手（单次播放后回 idle）
      useEffect(function () {
        if (waveSignal > 0) setState({ track: 'waving', frame: 0 });
      }, [waveSignal]);

      var s2d = (manifest && manifest.sprite2d) || FALLBACK_MANIFEST.sprite2d;
      var frames = s2d.frames || FALLBACK_MANIFEST.sprite2d.frames;
      var tracks = s2d.tracks || FALLBACK_MANIFEST.sprite2d.tracks;
      var rowIdx = TRACK_ROW[state.track] || 0;
      var frameCount = frames[rowIdx] || 6;
      var durations = (tracks[state.track] && tracks[state.track].durations) || [];
      var delay = durations[state.frame] != null ? durations[state.frame] : 400;

      useEffect(function () {
        var timer = setTimeout(function () {
          var next = state.frame + 1;
          if (next >= frameCount) {
            setState({ track: 'idle', frame: 0 }); // 非 idle 动画播完回 idle
          } else {
            setState({ track: state.track, frame: next });
          }
        }, delay);
        return function () { clearTimeout(timer); };
      }, [state, frameCount, delay]);

      // background-size: 800% 900%（8 列 9 行）；position 按 列/行 计算
      var posX = (state.frame * 100) / 7;
      var posY = (rowIdx * 100) / 8;
      var w = Math.round((size * 192) / 208);
      return React.createElement('div', {
        className: 'dsh-pu-sprite',
        style: {
          width: w,
          height: size,
          backgroundImage: "url('" + SPRITE_URL + "')",
          backgroundSize: '800% 900%',
          backgroundPosition: posX + '% ' + posY + '%',
        },
      });
    }

    // ── 悬浮鲸鱼 ──────────────────────────────────────────────────────
    function WhaleBadge() {
      var s = useSettings();
      var [pos, setPos] = useState(function () { return loadPos(s.size); });
      var [open, setOpen] = useState(false);
      var [data, setData] = useState(null);
      var [loading, setLoading] = useState(false);
      var [loadError, setLoadError] = useState(null);
      var [dragging, setDragging] = useState(false);
      var [wave, setWave] = useState(0);
      var [dialogPos, setDialogPos] = useState(null);
      var dialogRef = useRef(null);
      var dragRef = useRef(null);

      // 位置重置（设置页按钮 → posEpoch +1）
      var epoch = s.posEpoch;
      useEffect(function () {
        setPos(loadPos(s.size));
      }, [epoch, s.size]);

      var load = useCallback(function () {
        setLoading(true);
        fetch('/api/provider-usage/opencode-go', { headers: { accept: 'application/json' } })
          .then(function (res) { return res.json().catch(function () { return null; }); })
          .then(function (json) { setData(json); setLoadError(null); })
          .catch(function (e) { setLoadError(String((e && e.message) || e)); })
          .finally(function () { setLoading(false); });
      }, []);

      useEffect(function () {
        if (!open) return undefined;
        load();
        var timer = window.setInterval(load, s.refreshMs);
        return function () { window.clearInterval(timer); };
      }, [open, load, s.refreshMs]);

      if (!s.visible) return null;

      function onPointerDown(e) {
        e.stopPropagation();
        try { e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, left: pos.left, top: pos.top, moved: false };
      }
      function onPointerMove(e) {
        var d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        var dx = e.clientX - d.startX, dy = e.clientY - d.startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
        if (d.moved) { setDragging(true); setPos(clampPos(d.left + dx, d.top + dy, s.size)); }
      }
      function onPointerUp(e) {
        var d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        dragRef.current = null;
        if (d.moved) {
          setDragging(false);
          try { window.localStorage.setItem(POS_KEY, JSON.stringify(clampPos(d.left + (e.clientX - d.startX), d.top + (e.clientY - d.startY), s.size))); } catch (err) { /* ignore */ }
          return;
        }
        setOpen(function (v) { return !v; });
        setWave(function (w) { return w + 1; }); // 点击挥一下手
      }

      // 动态层级：打开面板时 🐳 降到遮罩/面板之下
      var z = s.zIndex;

      // 实测对话框高度后贴紧宠物放置（上方 12px；鲸鱼偏上时放下方 10px）
      useLayoutEffect(function () {
        if (!open || !pos) return;
        var el = dialogRef.current;
        if (!el) return;
        var h = el.offsetHeight || 340;
        var above = pos.top >= 380;
        var top = above ? Math.max(8, pos.top - s.size - 12 - h) : pos.top + s.size + 10;
        var left = Math.max(8, Math.min(pos.left + s.size / 2 - 165, window.innerWidth - 330 - 8));
        setDialogPos({ left: left, top: top });
      }, [open, pos, s.size, data, loading, loadError]);

      return React.createElement(React.Fragment, null,
        React.createElement('div', {
          className: 'dsh-pu-badge' + (dragging ? ' dragging' : ''),
          style: pos ? { left: pos.left, top: pos.top, width: s.size, height: s.size, zIndex: open ? z - 3 : z } : null,
          title: 'OpenCode Go 用量（拖动可换位置）',
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
          onPointerCancel: onPointerUp,
        }, React.createElement(Sprite, { size: s.size, waveSignal: wave })),
        open ? React.createElement('div', {
          className: 'dsh-pu-backdrop',
          style: { zIndex: z - 2 },
          onClick: function (e) { e.stopPropagation(); setOpen(false); },
        }) : null,
        open ? React.createElement('div', {
          ref: dialogRef,
          className: 'dsh-pu-dialog',
          style: Object.assign({ zIndex: z - 1, visibility: dialogPos ? 'visible' : 'hidden', left: dialogPos ? dialogPos.left : 8, top: dialogPos ? dialogPos.top : 8 },
            dialogPos ? {} : { left: 8, top: 8 }),
          onClick: function (e) { e.stopPropagation(); },
        },
          React.createElement(UsageDialog, {
            data: data, loading: loading, loadError: loadError, load: load, onClose: function () { setOpen(false); },
          })) : null);
    }

    function UsageDialog(props) {
      var data = props.data, loading = props.loading, loadError = props.loadError, load = props.load, onClose = props.onClose;
      var dot = 'ok';
      if (!data || !data.ok) dot = data && data.stale ? 'warn' : 'err';
      var meta = data && data.fetchedAt ? fmtTime(data.fetchedAt) + (data.stale ? ' · ' + zh.stale : '') : zh.loading;

      var body = null;
      if (loading && !data) {
        body = React.createElement('div', null, zh.loading);
      } else if (!data && loadError) {
        body = React.createElement('div', { className: 'dsh-pu-error' }, React.createElement('b', null, zh.errorTitle + '：'), String(loadError));
      } else if (data && !data.ok && !data.stale) {
        var em = (data.error && data.error.message) || '未知错误';
        body = React.createElement('div', { className: 'dsh-pu-error' }, React.createElement('b', null, zh.errorTitle + '：'), ' ' + em);
      } else if (data && data.ok) {
        body = React.createElement('div', null,
          React.createElement('div', { className: 'dsh-pu-remain' },
            React.createElement('span', { className: 'dsh-pu-remain-big' }, data.remaining === null ? '--' : Math.round(data.remaining) + '%'),
            React.createElement('span', { className: 'dsh-pu-remain-label' }, ' ' + zh.remaining + '（' + zh.monthly + '）')),
          React.createElement(WindowRow, { label: zh.rolling, win: data.windows && data.windows.rolling }),
          React.createElement(WindowRow, { label: zh.weekly, win: data.windows && data.windows.weekly }),
          React.createElement(WindowRow, { label: zh.monthly, win: data.windows && data.windows.monthly }),
          data.extra ? React.createElement('div', { className: 'dsh-pu-extra' }, data.extra) : null);
      }

      var diag = '';
      if (data && data.credential && data.credential.source) {
        var last = data.snapshots && data.snapshots.length > 0 ? data.snapshots[data.snapshots.length - 1] : null;
        diag = '凭证: ' + data.credential.source + (data.credential.keyHint ? ' (' + data.credential.keyHint + ')' : '') +
          (last && last.httpStatus ? ' · HTTP ' + last.httpStatus : '');
      }

      return React.createElement('div', null,
        React.createElement('div', { className: 'dsh-pu-head' },
          React.createElement('span', { className: 'dsh-pu-title' }, React.createElement('span', { className: 'dsh-pu-dot ' + dot }), ' ' + zh.title),
          React.createElement('span', { className: 'dsh-pu-meta' }, meta)),
        body,
        diag ? React.createElement('div', { className: 'dsh-pu-diag' }, diag) : null,
        React.createElement('div', { className: 'dsh-pu-footer' },
          React.createElement('span', { className: 'dsh-pu-meta' }, '每 ' + Math.round((getSettings().refreshMs || 30000) / 1000) + ' 秒自动刷新 · 可拖动'),
          React.createElement('span', null,
            React.createElement('button', { type: 'button', className: 'dsh-pu-btn', onClick: function (e) { e.stopPropagation(); load(); } }, zh.refresh),
            ' ',
            React.createElement('button', { type: 'button', className: 'dsh-pu-btn', onClick: function (e) { e.stopPropagation(); onClose(); } }, zh.close))));
    }

    // ── 设置页 ───────────────────────────────────────────────────────
    function StatusCard() {
      var [data, setData] = useState(null);
      var load = useCallback(function () {
        fetch('/api/provider-usage/opencode-go', { headers: { accept: 'application/json' } })
          .then(function (res) { return res.json().catch(function () { return null; }); })
          .then(setData)
          .catch(function () { setData(null); });
      }, []);
      useEffect(function () { load(); }, [load]);

      var dot = 'ok', line = zh.loading;
      if (data) {
        if (!data.ok) dot = data.stale ? 'warn' : 'err';
        var last = data.snapshots && data.snapshots.length > 0 ? data.snapshots[data.snapshots.length - 1] : null;
        line = (data.ok ? '查询正常' : (data.error ? data.error.message : zh.errorTitle)) +
          (data.fetchedAt ? ' · ' + zh.updatedAt + ' ' + fmtTime(data.fetchedAt) : '') +
          (last && last.httpStatus ? ' · HTTP ' + last.httpStatus : '') +
          (data.stale ? ' · ' + zh.stale : '');
      }
      var cfg = data && data.config;

      return React.createElement('div', { className: 'dsh-pus-status' },
        React.createElement('div', null,
          React.createElement('span', { className: 'dsh-pu-dot ' + dot }), ' ' + line),
        React.createElement('div', null, zh.source + '：opencode.ai/zen/go/v1/usage' + (cfg ? '（baseUrl ' + cfg.baseUrl + '，超时 ' + cfg.timeoutMs + 'ms）' : '')),
        data && data.credential && data.credential.source ? React.createElement('div', null,
          zh.keyFrom + '：' + data.credential.source + (data.credential.keyHint ? ' (' + data.credential.keyHint + ')' : '')) : null,
        React.createElement('div', null,
          React.createElement('button', { type: 'button', className: 'dsh-pu-btn', onClick: load }, zh.refresh)));
    }

    function SettingsCard() {
      var s = useSettings();

      function setNum(field, val, min, max) {
        var n = Math.round(Number(val));
        if (Number.isNaN(n)) return;
        setSettings({ [field]: Math.max(min, Math.min(max, n)) });
      }

      return React.createElement('div', { className: 'dsh-pus' },
        React.createElement('h3', null, zh.settingsTitle),
        React.createElement('div', { className: 'dsh-pus-row' },
          React.createElement('span', { className: 'dsh-pus-label' }, zh.secVisible),
          React.createElement('input', {
            type: 'checkbox', checked: !!s.visible,
            onChange: function (e) { setSettings({ visible: e.target.checked }); },
          })),
        React.createElement('div', { className: 'dsh-pus-row' },
          React.createElement('span', null,
            React.createElement('div', { className: 'dsh-pus-label' }, zh.secZ),
            React.createElement('div', { className: 'dsh-pus-hint' }, zh.hintZ)),
          React.createElement('input', {
            type: 'number', className: 'dsh-pus-input', value: s.zIndex, min: 1, max: Z_MAX, step: 1,
            onChange: function (e) { setNum('zIndex', e.target.value, 1, Z_MAX); },
          })),
        React.createElement('div', { className: 'dsh-pus-row' },
          React.createElement('span', { className: 'dsh-pus-label' }, zh.secSize),
          React.createElement('input', {
            type: 'number', className: 'dsh-pus-input', value: s.size, min: SIZE_MIN, max: SIZE_MAX, step: 4,
            onChange: function (e) { setNum('size', e.target.value, SIZE_MIN, SIZE_MAX); },
          })),
        React.createElement('div', { className: 'dsh-pus-row' },
          React.createElement('span', { className: 'dsh-pus-label' }, zh.secRefresh),
          React.createElement('select', {
            className: 'dsh-pus-input', value: s.refreshMs,
            onChange: function (e) { setSettings({ refreshMs: Number(e.target.value) }); },
          },
          React.createElement('option', { value: 15000 }, '15 秒'),
          React.createElement('option', { value: 30000 }, '30 秒'),
          React.createElement('option', { value: 60000 }, '60 秒'),
          React.createElement('option', { value: 120000 }, '2 分钟'))),
        React.createElement('div', { className: 'dsh-pus-row' },
          React.createElement('span', { className: 'dsh-pus-label' }, zh.secPos),
          React.createElement('button', { type: 'button', className: 'dsh-pu-btn', onClick: function () {
            try { window.localStorage.removeItem(POS_KEY); } catch (e) { /* ignore */ }
            setSettings({ posEpoch: (getSettings().posEpoch || 0) + 1 });
          } }, zh.btnResetPos)),
        React.createElement('div', { className: 'dsh-pus-row' },
          React.createElement('button', { type: 'button', className: 'dsh-pu-btn', onClick: function () {
            try { window.localStorage.removeItem(POS_KEY); } catch (e) { /* ignore */ }
            setSettings(Object.assign({}, DEFAULT_SETTINGS, { posEpoch: (getSettings().posEpoch || 0) + 1 }));
          } }, zh.btnDefaults)),
        React.createElement(StatusCard, null),
        React.createElement('div', { className: 'dsh-pus-hint' }, zh.hintInstant));
    }

    // ── 挂载：悬浮鲸鱼 + 设置分区 ──────────────────────────────────────
    function apply(ctx) {
      var registered = null;

      function mount() {
        registered = ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: 'provider-usage-badge', order: 50 },
            function () { return React.createElement(WhaleBadge); });
        });
      }

      function ensureMounted() {
        try {
          if (!getSettings().visible) return; // 用户主动隐藏，不自动复活
          if (document.querySelector('.dsh-pu-badge')) return;
          if (registered) { try { registered(); } catch (e) { /* ignore */ } registered = null; }
          mount();
        } catch (e) {
          console.warn('[dsh-provider-usage] re-mount failed:', e);
        }
      }

      try { mount(); } catch (e) {
        console.warn('[dsh-provider-usage] slot mount failed:', e);
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
          if (registered) { try { registered(); } catch (e) { /* ignore */ } registered = null; }
          for (var i = 0; i < disposers.length; i++) { try { disposers[i](); } catch (e) { /* ignore */ } }
        };
      }, 'dsh-provider-usage: ui mounts');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
