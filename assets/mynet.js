/* mynet.js —— 自有 IP + 双测速浮窗（底部单浮窗，无 ID 冲突）
 *
 * 测速段：并列显示两个 chip
 *   - Google 连通 78ms
 *   - CF 连通 142ms
 * 两个端点并发测、独立着色、独立更新；点击任一 chip 只重测它。
 *
 * 其它设计点：
 *   - 单 IIFE，DOM 节点走 mynet- 前缀（#mynet-bot）
 *   - 底部单一浮窗，没有顶部重复
 *   - 距底 >24px 才显示（贴底时隐）
 *   - 6h localStorage 缓存
 *   - 整段 base 文本 Google 蓝
 *   - IP 区最前面带 "Your IP" 标签
 *   - 不显示"测速"措辞（仅展示端点连通性，不代表真实访问速度）
 *   - 移动端：IP 单独一行，probes 紧跟下一行（不被截，且居中）
 */

(function () {
  'use strict';
  if (window.__MYNET_INITED__) return;
  window.__MYNET_INITED__ = true;

  // ---------------- 配置 ----------------
  const CACHE_KEY = 'mynet_cache_v1';
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const BOTTOM_HIDE_PX = 24;
  const PROBE_TIMEOUT_MS = 1500;
  const IP_FETCH_TIMEOUT_MS = 4000;

  // IP 接口：只保留实测在浏览器/webview 里带 CORS 头、稳定可用的端点，并发竞速取最快返回的那个。
  // 排除原因：
  //   - ip-api.com：免费 HTTPS 端点 403 且无 CORS 头
  //   - ipapi.co / freeipapi.com：部分 webview(如 VDS)会拦截，产生红色 CORS 报错
  //   - ipwhois.app：部分网络返回 403
  // 留下 ipwho.is 与 api.ip.sb，两个都稳定带 Access-Control-Allow-Origin。
  // 各接口返回字段结构不同，统一在 normalizeIP 里归一化。
  const IP_ENDPOINTS = [
    'https://ipwho.is/',
    'https://api.ip.sb/geoip'
  ];

  // 测速点：每个端点有 name / url / key
  // 注意：这里测的是"端点连通性"，不是真实访问速度。
  // google = 中国到 Google 优选反代（用 gstatic 204，国内能通）
  // cf     = 到 Cloudflare 反代/优选节点（用优选反代 204 反映就近 PoP 延迟）
  const PROBES = {
    google: {
      key: 'google', name: 'Google',
      urls: [
        'https://www.gstatic.com/generate_204',
        'https://www.google.com/generate_204',
        'http://connectivitycheck.platform.hicloud.com/generate_204'
      ]
    },
    cf: {
      key: 'cf', name: 'CF',
      urls: [
        'https://cf.090227.xyz/generate_204',
        'https://cdn.inumc.dpdns.org/generate_204',
        'https://cp.cloudflare.com/generate_204',
      ]
    }
  };
  // chip 标签前缀：仅展示"端点连通性"，不是真实访问延迟
  // 用户访问站点时实际走的是优选/反代，不等于这两个直连端点的延迟
  const PROBE_LABEL = '连通';

  // ---------------- 工具 ----------------
  const isDesktop = (() => {
    const ua = navigator.userAgent || '';
    const hasTouch = (navigator.maxTouchPoints || 0) > 0;
    const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    const isIPadDesktopMode = /Macintosh/i.test(ua) && hasTouch;
    return !isMobileUA && !isIPadDesktopMode;
  })();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fetchWithTimeout(url, timeoutMs, opt) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, Object.assign({
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    }, opt || {})).finally(() => clearTimeout(t));
  }

  function promiseAny(promises) {
    if (Promise.any) return Promise.any(promises);
    return new Promise((resolve, reject) => {
      let rejects = 0;
      const errs = [];
      promises.forEach((p, i) => {
        Promise.resolve(p).then(resolve, (e) => {
          errs[i] = e;
          if (++rejects === promises.length) reject(new AggregateError(errs, 'all failed'));
        });
      });
    });
  }

  async function fetchIPRace() {
    const tasks = IP_ENDPOINTS.map(async (url) => {
      const res = await fetchWithTimeout(url, IP_FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error('not ok');
      const j = await res.json();
      const ip = j && (j.ip || j.query || j.ipAddress);
      if (!ip) throw new Error('no ip');
      return j;
    });
    return promiseAny(tasks);
  }

  function normalizeIP(data) {
    if (!data) return null;
    // 不同接口字段结构差异较大，这里统一抽取。
    // ip.sb / ipwhois.app / ipwho.is 会把 ASN/ISP 放在 connection 对象里
    const conn = data.connection || {};
    const ip = data.ip || data.query || data.ipAddress || '';
    if (!ip) return null;
    const country = data.country_name || data.country || data.countryName || '';
    const city = data.city || data.cityName || '';
    const region = data.region || data.regionName || data.region_name || data.state || '';
    const finalCity = city || region || '';
    const loc = (country && finalCity && country !== finalCity)
      ? `${country} · ${finalCity}`
      : (country || finalCity);
    let asn = data.asn || conn.asn || '';
    // ip.sb / ipwho.is 的 asn 是纯数字，补成 ASxxxx 形式
    if (typeof asn === 'number') asn = asn ? 'AS' + asn : '';
    if (!asn && typeof data.org === 'string' && /^AS\d+\b/i.test(data.org)) {
      asn = (data.org.match(/^AS\d+\b/i) || [''])[0];
    }
    if (!asn && typeof data.as === 'string') {
      asn = (data.as.match(/^AS\d+\b/i) || [''])[0];
    }
    let org = data.org || data.organization || data.isp || conn.org || conn.isp
      || conn.organization || data.asn_organization || data.as_desc || '';
    if (!org && typeof data.as === 'string') {
      org = data.as.replace(/^AS\d+\s*/i, '');
    }
    return { ip, loc, asn, org };
  }

  function formatBaseText(n) {
    if (!n || !n.ip) return '无法解析 IP 信息';
    const isIPv4 = n.ip.includes('.') && !n.ip.includes(':');
    const isIPv6 = n.ip.includes(':');
    let label = n.ip;
    if (isIPv6) label = n.ip.split(':').slice(0, 3).join(':');
    if (!isDesktop) return n.loc ? `${label} ｜ ${n.loc}` : label;
    const parts = [];
    if (n.loc) parts.push(n.loc);
    const asnOrg = [n.asn, n.org].filter(Boolean).join(' ');
    if (asnOrg) parts.push(asnOrg);
    return parts.length ? `${label} ｜ ${parts.join(' ｜ ')}` : label;
  }

  function latencyClass(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms < 80)  return 'lat-excellent';
    if (ms < 150) return 'lat-good';
    if (ms < 300) return 'lat-mid';
    return 'lat-bad';
  }

  function getDownlinkStr() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c || typeof c.downlink !== 'number' || !isFinite(c.downlink)) return '';
    const dl = c.downlink >= 10 ? Math.round(c.downlink) : Math.round(c.downlink * 10) / 10;
    return `↓${dl}Mbps`;
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.ts || !obj.data) return null;
      if (Date.now() - obj.ts > CACHE_TTL_MS) return null;
      return obj.data;
    } catch (e) { return null; }
  }
  function saveCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
  }

  // 单点测速：no-cors 计时，串行尝试多个 url，直到通为止
  async function pingOnce(target) {
    for (let i = 0; i < target.urls.length; i++) {
      const url = target.urls[i];
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const t0 = performance.now();
      try {
        await fetch(url, {
          signal: ctrl.signal, mode: 'no-cors', cache: 'no-store', credentials: 'omit',
          redirect: 'follow'
        });
        return { name: target.name, key: target.key, ms: Math.round(performance.now() - t0), via: url };
      } catch (e) {
        // 试下一个
      } finally {
        clearTimeout(t);
      }
    }
    return { name: target.name, key: target.key, ms: NaN, via: '' };
  }

  // ---------------- 浮窗 ----------------
  const STYLE_ID = 'mynet-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      .mynet-bar {
        position: fixed;
        left: 50%;
        z-index: 9999;
        transition: opacity .25s ease, transform .25s ease;
        max-width: calc(100vw - 24px);
      }
      .mynet-bar.mynet-bot { bottom: 16px; transform: translateX(-50%); }
      .mynet-bar.mynet-hidden {
        opacity: 0;
        pointer-events: none;
      }
      .mynet-bar.mynet-bot.mynet-hidden { transform: translateX(-50%) translateY( 18px); }

      .mynet-inner {
        display: inline-flex;
        align-items: center;
        gap: 0;
        padding: 8px 16px;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(220, 220, 220, 0.9);
        max-width: calc(100vw - 24px);
      }
      /* 文本区：base 跟 probes 紧凑在一行，宽度不够时 probes 自然到下一行；
         换行后每行内容居中，避免小窗口下两个 chip 偏左 */
      .mynet-text {
        font-size: 13px;
        color: #1a73e8;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        column-gap: 6px;
        row-gap: 4px;
        min-width: 0;
        max-width: calc(100vw - 56px);
      }
      /* IP 区：标签 + IP 值组合，整组可收缩截断 */
      .mynet-ip-wrap {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        flex: 0 1 auto;
        min-width: 0;
      }
      .mynet-label {
        font-weight: 700;
        color: #5a5a8a;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .mynet-base {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        color: #1a73e8;
      }
      /* 移动端：IP 组独占一行，probes 紧跟下一行并居中 */
      @media (max-width: 600px) {
        .mynet-text { font-size: 12px; max-width: calc(100vw - 40px); }
        .mynet-ip-wrap { flex-basis: 100%; justify-content: center; }
        .mynet-probes { flex-basis: 100%; justify-content: center; }
      }

      /* 两个 chip 的容器 */
      .mynet-probes {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      /* 单个 chip：可点击；测速时透明+模糊过渡 */
      .mynet-probe {
        font-weight: 700;
        cursor: pointer;
        user-select: none;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(0,0,0,0.03);
        transition: opacity .22s ease, transform .22s ease, filter .22s ease, background .15s ease;
        white-space: nowrap;
      }
      .mynet-probe:hover  { background: rgba(0,0,0,0.06); }
      .mynet-probe.pending { opacity: 0.55; filter: blur(0.3px); }
      .mynet-probe.lat-pending { color: #6b7280; }
      .mynet-probe.lat-pending::after {
        content: "…";
        margin-left: 2px;
        animation: mynet-blink 1.2s steps(2, end) infinite;
      }
      @keyframes mynet-blink {
        0%   { opacity: 0.2; }
        50%  { opacity: 1; }
        100% { opacity: 0.2; }
      }

      .mynet-probe.lat-excellent { color: #16a34a; }
      .mynet-probe.lat-good      { color: #2563eb; }
      .mynet-probe.lat-mid       { color: #f59e0b; }
      .mynet-probe.lat-bad       { color: #ef4444; }
      .mynet-probe.lat-fail      { color: #9ca3af; }

      @media (max-width: 600px) {
        .mynet-bar.mynet-bot { bottom: 8px; }
        .mynet-inner { padding: 8px 12px; }
        .mynet-probes { gap: 6px; }
        .mynet-probe  { padding: 1px 6px; font-size: 11px; }
      }
    `;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  // 创建一个浮窗：bar 容器 + 内部 DOM（两个 chip）
  // IP 区最前面带 "Your IP" 标签，后面紧跟 IP 文本与 probes
  function buildBar(slot) {
    const bar = document.createElement('div');
    bar.className = `mynet-bar mynet-${slot}`;
    bar.innerHTML = `
      <div class="mynet-inner">
        <div class="mynet-text">
          <span class="mynet-ip-wrap">
            <span class="mynet-label">Your IP</span>
            <span class="mynet-base">加载中…</span>
          </span>
          <span class="mynet-probes">
            <span class="mynet-probe" data-probe="google" title="Google 端点连通性（不代表真实访问速度）">Google ${PROBE_LABEL} --ms</span>
            <span class="mynet-probe" data-probe="cf"     title="Cloudflare 端点连通性（不代表真实访问速度）">CF ${PROBE_LABEL} --ms</span>
          </span>
        </div>
      </div>
    `;
    document.body.appendChild(bar);
    return bar;
  }

  // ---------------- 状态：底部浮窗 ----------------
  const state = {
    botBar: null,
    data: null,
    // 测速结果：{ google: {ms,cls}, cf: {ms,cls} }
    probes: { google: null, cf: null },
    // 正在测的 key 集合（用于避免重入）
    pending: { google: false, cf: false }
  };

  // 渲染某个 chip（同步到浮窗）
  function renderProbe(probeKey, text, cls, pending) {
    state.probes[probeKey] = { text, cls };
    const bar = state.botBar;
    if (!bar) return;
    const el = bar.querySelector(`.mynet-probe[data-probe="${probeKey}"]`);
    if (!el) return;
    el.className = `mynet-probe ${cls || ''}${pending ? ' pending' : ''}`;
    el.textContent = text;
  }

  // 测一个端点，结果同步到两个浮窗
  async function probeOne(probeKey) {
    if (state.pending[probeKey]) return;
    state.pending[probeKey] = true;

    const target = PROBES[probeKey];
    renderProbe(probeKey, `${target.name} ${PROBE_LABEL}中`, 'lat-pending', true);

    const r = await pingOnce(target);
    state.pending[probeKey] = false;

    if (r && Number.isFinite(r.ms)) {
      renderProbe(probeKey, `${target.name} ${PROBE_LABEL} ${r.ms}ms`, latencyClass(r.ms), false);
    } else {
      renderProbe(probeKey, `${target.name} --ms`, 'lat-fail', false);
    }
    updateBarTitle();
  }

  // 并发测全部端点（首屏用）
  async function probeAll() {
    if (!isDesktop) {
      // 移动端：直接显示占位，不阻塞视觉，但仍后台跑
      renderProbe('google', `Google ${PROBE_LABEL} --ms`, 'lat-fail', false);
      renderProbe('cf',     `CF ${PROBE_LABEL} --ms`,     'lat-fail', false);
      updateBarTitle();
      const tasks = ['google', 'cf'].map((k) => probeOne(k));
      await Promise.allSettled(tasks);
      return;
    }
    // 桌面端：立刻显示"测速中"
    renderProbe('google', `Google ${PROBE_LABEL}中`, 'lat-pending', true);
    renderProbe('cf',     `CF ${PROBE_LABEL}中`,     'lat-pending', true);

    const tasks = ['google', 'cf'].map((k) => probeOne(k));
    await Promise.allSettled(tasks);
  }

  // 更新 title（hover 时显示完整信息）
  function updateBarTitle() {
    const bar = state.botBar;
    if (!bar) return;
    const base = bar.querySelector('.mynet-base')?.textContent || '';
    const down = getDownlinkStr();
    const parts = [
      `Your IP ${base}`,
      `Google 端点连通性 ${state.probes.google?.text || '…'}`,
      `Cloudflare 端点连通性 ${state.probes.cf?.text || '…'}`
    ];
    if (down) parts.push(down);
    bar.setAttribute('title', parts.join(' ｜ ') + ' ｜ 注：仅代表到该直连端点的延迟，不等于本站真实访问速度');
  }

  // 设置 base 段（IP 文字）
  function setBase(text) {
    const bar = state.botBar;
    if (!bar) return;
    const el = bar.querySelector('.mynet-base');
    if (el) el.textContent = text || '';
    updateBarTitle();
  }

  // ---------------- 滚动显隐（只控底 bar） ----------------
  function updateBot() {
    if (!state.botBar) return;
    const doc = document.documentElement;
    const scrollTop = doc.scrollTop || document.body.scrollTop || 0;
    const viewportH = window.innerHeight || doc.clientHeight || 0;
    const scrollH = doc.scrollHeight || document.body.scrollHeight || 0;
    const distanceFromBottom = scrollH - (scrollTop + viewportH);
    // 不可滚（distanceFromBottom <= 0）或距底 <= 24px 时隐藏
    const canScroll = (scrollH - viewportH) > 0;
    const shouldHide = canScroll && distanceFromBottom <= BOTTOM_HIDE_PX;
    state.botBar.classList.toggle('mynet-hidden', shouldHide);
  }
  function onScrollResize() { updateBot(); }
  function attachScroll() {
    window.addEventListener('scroll', onScrollResize, { passive: true });
    window.addEventListener('resize', onScrollResize, { passive: true });
    onScrollResize();
  }

  // 绑定点击：重测该端点
  function bindProbeClicks() {
    const handler = (probeKey) => async (e) => {
      e.stopPropagation();
      if (!isDesktop) return;
      if (state.pending[probeKey]) return;
      probeOne(probeKey);
    };
    const bar = state.botBar;
    if (!bar) return;
    bar.querySelectorAll('.mynet-probe').forEach((el) => {
      const k = el.getAttribute('data-probe');
      el.addEventListener('click', handler(k), { passive: true });
    });
  }

  // ---------------- 入口 ----------------
  async function main() {
    injectStyle();
    // 只建一个底 bar
    state.botBar = buildBar('bot');
    attachScroll();
    bindProbeClicks();

    // 1) 先用缓存秒显
    const cached = loadCache();
    if (cached) {
      state.data = cached;
      setBase(formatBaseText(cached));
    }

    // 2) 后台拉真实 IP
    try {
      const raw = await fetchIPRace();
      const n = normalizeIP(raw);
      if (n && n.ip) {
        state.data = n;
        saveCache(n);
        setBase(formatBaseText(n));
      } else if (!cached) {
        setBase('无法获取 IP 信息');
      }
    } catch (e) {
      if (!cached) setBase('无法获取 IP 信息');
    }

    // 3) 测速
    await probeAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
