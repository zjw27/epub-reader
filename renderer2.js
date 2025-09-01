window.__restoring = false;
(() => {
  if (window.__overlayOffsetWired) return;
  window.__overlayOffsetWired = true;

  function overlayHeight() {
    const o = navigator.windowControlsOverlay;
    try {
      // 兼容两个命名：getTitlebarAreaRect（标准）/ getTitleBarAreaRect（早期）
      const getter = o && (o.getTitlebarAreaRect || o.getTitleBarAreaRect);
      if (o && o.visible && typeof getter === 'function') {
        const r = getter.call(o);
        const h = Math.max(0, Math.round(r?.height || 0));
        if (h) return h;
      }
    } catch { }
    return 36; // 兜底：与你在 main.js 里 titleBarOverlay.height 一致
  }

  function applyOverlayHeight() {
    document.documentElement.style.setProperty('--overlay-h', `${overlayHeight()}px`);
  }

  // 首次 & 变化时更新（事件也要做兼容）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyOverlayHeight, { once: true });
  } else {
    applyOverlayHeight();
  }
  window.addEventListener('resize', applyOverlayHeight);
  navigator.windowControlsOverlay?.addEventListener?.('geometrychange', applyOverlayHeight);
})();

// ==== epubCache.js（可直接贴到 renderer 顶部或单独引入）====
const EpubCache = (() => {
  const DB = 'epub-cache', VER = 1;
  const T_BOOKS = 'books', T_CHAPS = 'chapters';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(T_BOOKS)) {
          const s = db.createObjectStore(T_BOOKS, { keyPath: 'key' }); // key = path|sig
          s.createIndex('byPath', 'path', { unique: false });
        }
        if (!db.objectStoreNames.contains(T_CHAPS)) {
          const s = db.createObjectStore(T_CHAPS, { keyPath: 'key' }); // key = `${bookKey}#${idx}`
          s.createIndex('byBook', 'bookKey', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const tx = (db, stores, mode) => db.transaction(stores, mode);

  // 生成“书签名”：path + （可选）文件时间/大小。没有 stat 的话仅用 path 也能工作
  const makeBookKey = ({ path, sig }) => `${path}|${sig || 'plain'}`;

  async function saveMeta({ path, sig, title, chaptersMeta }) {
    const db = await openDB();
    const key = makeBookKey({ path, sig });
    await new Promise((res, rej) => {
      const t = tx(db, [T_BOOKS], 'readwrite');
      t.objectStore(T_BOOKS).put({ key, path, sig: sig || null, title, chaptersMeta, ts: Date.now() });
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    return key;
  }

  async function saveChapter({ bookKey, idx, html }) {
    const db = await openDB();
    await new Promise((res, rej) => {
      const t = tx(db, [T_CHAPS], 'readwrite');
      t.objectStore(T_CHAPS).put({ key: `${bookKey}#${idx}`, bookKey, idx, html });
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }

  async function loadSnapshotByPath(path) {
    const db = await openDB();
    // 取到最新的该 path 的书（如果你给了 sig，会唯一）
    const books = await new Promise((res, rej) => {
      const t = tx(db, [T_BOOKS], 'readonly');
      const out = [];
      const idx = t.objectStore(T_BOOKS).index('byPath').openCursor(IDBKeyRange.only(path), 'prev');
      idx.onsuccess = e => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
      idx.onerror = () => rej(idx.error);
    });
    if (!books.length) return null;
    const meta = books[0]; // 最新
    const chaps = await new Promise((res, rej) => {
      const t = tx(db, [T_CHAPS], 'readonly');
      const out = new Map();
      const idx = t.objectStore(T_CHAPS).index('byBook').openCursor(IDBKeyRange.only(meta.key));
      idx.onsuccess = e => { const c = e.target.result; if (c) { out.set(c.value.idx, c.value.html); c.continue(); } else res(out); };
      idx.onerror = () => rej(idx.error);
    });
    return { meta, chapters: chaps };
  }

  async function clearByPath(path) {
    const db = await openDB();
    const snap = await loadSnapshotByPath(path);
    if (!snap) return;
    await new Promise((res, rej) => {
      const t = tx(db, [T_BOOKS, T_CHAPS], 'readwrite');
      t.objectStore(T_BOOKS).delete(snap.meta.key);
      const ix = t.objectStore(T_CHAPS).index('byBook').openCursor(IDBKeyRange.only(snap.meta.key));
      ix.onsuccess = e => {
        const c = e.target.result; if (c) { t.objectStore(T_CHAPS).delete(c.value.key); c.continue(); } else res();
      };
      ix.onerror = () => rej(ix.error);
    });
  }
  return { saveMeta, saveChapter, loadSnapshotByPath, clearByPath, makeBookKey };
})();

let offOpenEPUB;  // 保存解绑函数

// ------------------------------------ DOMContentLoaded ------------------------------------
window.addEventListener('DOMContentLoaded', () => {

  // =========================
  // 0) DOM 引用 & 运行时状态
  // =========================
  let bookTitleEl = document.getElementById('bookTitle');
  let toc = document.getElementById('toc');
  let content = document.getElementById('content');
  const TOC_SCROLL_PREFIX = 'reader:tocScroll:';
  const statusEl = document.getElementById('overlay-status');
  const overlayTitle = document.getElementById('overlay-title');
  const srStatus = document.getElementById('sr-status');

  // ——索引区间：DOM中实际存在的章节是 [headIdx ... nextIdx-1]
  let headIdx = 0;           // 顶端那章的索引
  let nextIdx = 0;           // 尾端之后的索引（下一章将被 append 到此）
  let progScrolling = false; // 程序化滚动保护（裁剪已删除，但上补/定位仍需）
  let loading = false;
  let tocScrollBound = false;      // 防止重复绑定 scroll 监听
  let restoringTOCScroll = false;  // 正在恢复滚动位置时，暂不自动滚动
  let __pendingBook = null;

  // ——阅读/存档状态
  let book = { title: '', chapters: [] };
  let activeIdx = -1;
  let userHasScrolled = false;
  let currentBookPath = null;
  let _saveTO = null;


  // ——导航期（防止中线法“抢章”）
  let navigating = false;
  let pendingIdx = -1;
  let _navTO = null;

  // ——向上批量插入控制
  let mutatingUp = false;
  let lastUpAt = 0;
  let hydratedFromCache = false;

  // =========================
  // 1) 纯工具：转义/净化
  // =========================
  const esc = (s) => String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
  const sanitizeAgain = (html) =>
    String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+=(?:"[^"]*"|'[^']*')/gi, '');

  // =========================
  // 2) 本地存储：最近一本 + 进度
  // =========================
  const LAST_BOOK_KEY = 'reader:lastBook';
  // const readLastBook = () => { try { const r = localStorage.getItem(LAST_BOOK_KEY); return r ? JSON.parse(r) : null; } catch { return null; } };
  // const writeLastBook = (obj) => { try { localStorage.setItem(LAST_BOOK_KEY, JSON.stringify(obj)); } catch { } };
  // const rememberLastBookPath = (path) => { if (!path) return; const old = readLastBook() || {}; writeLastBook({ ...old, path, v: 2, ts: Date.now() }); };
  // 读
  const readLastBook = () => {
    try {
      const raw = localStorage.getItem(LAST_BOOK_KEY);
      console.log('🔎[readLastBook] raw =', raw);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      console.log('🔎[readLastBook] parsed =', obj);
      return obj;
    } catch (e) {
      console.warn('⚠️[readLastBook] JSON parse error:', e);
      return null;
    }
  };
  // 写
  const writeLastBook = (obj) => {
    try {
      localStorage.setItem(LAST_BOOK_KEY, JSON.stringify(obj));
      console.log('💾[writeLastBook] wrote =', obj);
    } catch (e) {
      console.error('❌[writeLastBook] failed:', e);
    }
  };

  // 仅更新 path（不要默认把进度写成0）
  const rememberLastBookPath = (path) => {
    if (!path) return;
    const old = readLastBook() || {};
    console.log('🧭[rememberLastBookPath] prev =', old, '→ new path =', path);
    writeLastBook({ ...old, path, v: 2, ts: Date.now() });
  };

  // const saveProgress = (patch) => { const old = readLastBook() || {}; writeLastBook({ ...old, ...patch, v: 2, ts: Date.now() }); };

  // 合并进度（滚动/激活章节时会调这个）
  const saveProgress = (patch) => {
    const old = readLastBook() || {};
    const next = { ...old, ...patch, v: 2, ts: Date.now() };

    // 规则：当 patch 里带了 chapterIdx，且与旧值不同，
    // 并且 patch 没显式给 offset/offsetRatio ——> 把偏移清零
    const hasIdxInPatch = Object.prototype.hasOwnProperty.call(patch, 'chapterIdx');
    const idxChanged = hasIdxInPatch && patch.chapterIdx !== old.chapterIdx;
    const offsetGiven = Object.prototype.hasOwnProperty.call(patch, 'offset')
      || Object.prototype.hasOwnProperty.call(patch, 'offsetRatio');

    if (idxChanged && !offsetGiven) {
      next.offset = 0;
      next.offsetRatio = 0;
    }

    writeLastBook(next);
    console.log('📌[saveProgress] old=', old, 'patch=', patch, '→ next=', next);
  };

  // =========================
  // 3) TOC 渲染 & 目录高亮
  // =========================
  function renderTOC() {
    toc.innerHTML = '';
    book.chapters.forEach((c, i) => {
      const div = document.createElement('div');
      div.className = 'chap';
      div.dataset.idx = String(i);
      div.textContent = c.title || c.href;
      div.addEventListener('click', () => {
        // 开启“导航窗口”：只承认我点的那一章
        navigating = true;
        pendingIdx = i;
        if (_navTO) clearTimeout(_navTO);
        _navTO = setTimeout(() => { navigating = false; pendingIdx = -1; _navTO = null; }, 500);

        // 目录先行高亮（不落书签）
        markActive(i);

        // 软跳转：不清空DOM，只保证目标章在DOM并定位过去
        jumpTo(i);
      });
      toc.appendChild(div);
      if (Number.isInteger(activeIdx)) {
        const cur = toc.querySelector(`.chap[data-idx="${activeIdx}"]`);
        if (cur && !cur.classList.contains('active')) cur.classList.add('active');
      }
    });
    // ☆ 恢复目录滚动位置（按书本路径分key）
    try {
      const key = TOC_SCROLL_PREFIX + (currentBookPath || 'default');
      const saved = localStorage.getItem(key);
      if (saved != null) {
        restoringTOCScroll = true;
        toc.scrollTop = parseInt(saved, 10) || 0;
        setTimeout(() => { restoringTOCScroll = false; }, 0);
      }
    } catch { }
    // ☆ 只绑定一次：目录滚动时保存 scrollTop
    if (!tocScrollBound) {
      toc.addEventListener('scroll', () => {
        try {
          const key = TOC_SCROLL_PREFIX + (currentBookPath || 'default');
          localStorage.setItem(key, String(toc.scrollTop));
        } catch { }
      });
      tocScrollBound = true;
    }
    console.log('TOC rendered');

  }

  function markActive(idx) {
    [...toc.children].forEach((el, i) => el.classList?.toggle('active', i === idx));
    // ☆ 仅当不在可视区时，把高亮项滚入视口；恢复阶段不动
    const el = toc.children[idx];
    if (el && !restoringTOCScroll) {
      const top = toc.scrollTop;
      const bottom = top + toc.clientHeight;
      const et = el.offsetTop;
      const eb = et + el.offsetHeight;
      if (et < top || eb > bottom) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  
  function setActive(idx) {
    if (idx === activeIdx) return;
    activeIdx = idx;
    markActive(idx);

    // 这里写完整标题：书名 + 正确章
    setWinTitle(composeWinTitle(activeIdx));

    if (window.__restoring) return;
    if (currentBookPath) saveProgress({ path: currentBookPath, chapterIdx: idx });
  }

  // —— 把书名搬到窗口标题，并隐藏头部里的书名 —— //
  function setWinTitle(text) {
    const t = (text || 'EPUB Reader').trim();
    document.title = t;                 // 原生标题栏
    if (overlayTitle) overlayTitle.textContent = t;   // ← 新增
    try { window.app?.setTitle?.(t); } catch { } // 可选兜底（见下方 preload/main）
  }

  function composeWinTitle(idx) {
    const bt = (book?.title || bookTitleEl?.textContent || '').trim();
    const ct = (typeof idx === 'number' && book?.chapters?.[idx]?.title) || '';
    return ct ? `${bt} - ${ct}` : (bt || 'EPUB Reader');
  }
  // 首次进场：把头部书名藏起来（保留节点避免布局跳动）
  if (bookTitleEl) { bookTitleEl.setAttribute('aria-hidden', 'true'); bookTitleEl.style.display = 'none'; }

  function showStatus(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    srStatus && (srStatus.textContent = msg || '');
    // 防止历史代码遗留的彩色类影响
    statusEl.classList.remove('loading', 'ok', 'error', 'status');
  }

  // =========================
  // 4) 正文渲染：懒加载 & 上补
  // =========================
  function appendNext() {
    if (loading || nextIdx >= book.chapters.length) return;
    loading = true;

    const ch = book.chapters[nextIdx];
    const sec = document.createElement('section');
    sec.className = 'chapter';
    sec.dataset.idx = String(nextIdx);
    sec.innerHTML = `<div class="chapter-marker"></div>` + (sanitizeAgain(ch.html || '') || '<div class="empty">本章无内容</div>');

    content.appendChild(sec);

    if (currentBookPath) {
      const bookKey = EpubCache.makeBookKey({ path: currentBookPath });
      // 只缓存“已经渲染过的章节”；想限量可加 if (nextIdx <= 30) …
      EpubCache.saveChapter({ bookKey, idx: nextIdx, html: sec.innerHTML }).catch(() => { });
    }

    if (nextIdx === 0) content.scrollTop = 0;
    nextIdx++;
    loading = false;

  }

  // 顶部插入上一章，且“锁住视口”
  function appendPrevKeepViewport() {
    recomputeBounds();
    if (loading || headIdx <= 0) return;
    loading = true;

    const idx = headIdx - 1;
    const ch = book.chapters[idx];
    if (!ch) { loading = false; return; }

    const sec = document.createElement('section');
    sec.className = 'chapter';
    sec.dataset.idx = String(idx);
    sec.innerHTML = `<div class="chapter-marker"></div>` + (sanitizeAgain(ch.html || '') || '<div class="empty">本章无内容</div>');

    const oldH = content.scrollHeight;
    content.insertBefore(sec, topChapterEl() || content.firstChild);
    void sec.offsetHeight; // 触发 reflow

    const delta = content.scrollHeight - oldH; // > 0
    progScrolling = true;
    content.scrollTop += delta; // 视口不动
    setTimeout(() => { progScrolling = false; }, 0);

    headIdx = idx;
    loading = false;
  }

  // 批量向上补齐到目标（用于“跳到更上面的章节”）
  function batchPrependUp(count = 1, anchorIdx = null) {
    if (mutatingUp || loading) return;
    if (headIdx <= 0 || count <= 0) return;

    mutatingUp = true;
    loading = true;

    const anchor = pickAnchor(anchorIdx); // 改：以“目标章”为锚（若有）
    const beforeTop = anchor.getBoundingClientRect().top;

    const start = Math.max(0, headIdx - count);
    const frag = document.createDocumentFragment();
    for (let k = start; k < headIdx; k++) {
      const ch = book.chapters[k];
      if (!ch) continue;
      const sec = document.createElement('section');
      sec.className = 'chapter';
      sec.dataset.idx = String(k);
      const marker = `<div class="chapter-marker"></div>`;
      sec.innerHTML = marker + (sanitizeAgain(ch.html || '') || '<div class="empty">本章无内容</div>');
      frag.appendChild(sec);
    }

    const firstChap = content.querySelector('.chapter');
    if (firstChap) content.insertBefore(frag, firstChap);
    headIdx = start;

    // 位移补偿 + 双帧微调（应对图片/字体解码回流）
    const afterTop = anchor.getBoundingClientRect().top;
    progScrolling = true;                           // ☆ 防止滚动监听介入
    content.scrollTop += (afterTop - beforeTop);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const afterTop2 = anchor.getBoundingClientRect().top;
        const delta2 = afterTop2 - beforeTop;
        if (Math.abs(delta2) > 2) content.scrollTop += delta2; // 第二次微调
        progScrolling = false;                      // ☆ 解锁
        mutatingUp = false;
        loading = false;
        lastUpAt = Date.now();
      });
    });
  }

  // 若内容不足一屏，主动补一章
  function maybeTopUp() {
    if (content.scrollHeight <= content.clientHeight + 100) appendNext();
  }

  // 从某章开始显示（首次载书/恢复用；允许偏移）
  function startFrom(idx, offset = 0) {
    headIdx = idx;
    nextIdx = idx;

    content.innerHTML = '';
    content.scrollTop = 0;
    userHasScrolled = false;

    appendNext();   // 先渲染起始章节
    maybeTopUp();   // 首屏不满再补一章

    if (offset > 0) {
      const sec = content.querySelector(`.chapter[data-idx="${idx}"]`);
      // if (sec) {
      //   progScrolling = true;
      //   content.scrollTop = sec.offsetTop + offset;
      //   setTimeout(() => { progScrolling = false; }, 0);
      // }
      if (sec) lockAndRestoreTo(sec, { offset, offsetRatio: 0 });
    }
  }

  // ——软跳转：不清空DOM，只保证目标在DOM，然后瞬时定位过去
  function jumpTo(idx) {
    if (!book?.chapters?.length) return;
    idx = Math.max(0, Math.min(idx, book.chapters.length - 1));

    // 导航防抖：只承认 pendingIdx
    navigating = true;
    pendingIdx = idx;
    if (_navTO) clearTimeout(_navTO);
    _navTO = setTimeout(() => { navigating = false; pendingIdx = -1; _navTO = null; }, 500);

    // 目录先行高亮（不落书签）
    markActive(idx);

    // 1) 确保目标已在 DOM 中
    if (idx < headIdx) {
      const need = headIdx - idx;
      batchPrependUp(need, idx);      // ☆ 新：以目标章为锚，不会回拉
    } else if (idx >= nextIdx) {
      while (nextIdx <= idx && !loading) appendNext(); // 顺序向下补齐
    }

    // 2) 瞬时定位（禁平滑）
    const sec = content.querySelector(`.chapter[data-idx="${idx}"]`);
    if (sec) {
      const prev = content.style.scrollBehavior;
      content.style.scrollBehavior = 'auto';
      progScrolling = true;                 // ☆ 加保护
      content.scrollTop = sec.offsetTop;
      setTimeout(() => { progScrolling = false; }, 0);
      content.style.scrollBehavior = prev;
    }
  }

  // =========================
  // 5) 进度：滚动监听 → 防抖写入
  // =========================
  function getActiveOffset() {
    const sec = content.querySelector(`.chapter[data-idx="${activeIdx}"]`);
    if (!sec) return 0;
    const off = content.scrollTop - sec.offsetTop;
    return off > 0 ? off : 0;
  }

  // 计算当前激活章的偏移 & 比例
  function getActiveProgress() {
    const sec = content.querySelector(`.chapter[data-idx="${activeIdx}"]`);
    if (!sec) return { chapterIdx: activeIdx, offset: 0, offsetRatio: 0 };
    const off = Math.max(0, content.scrollTop - sec.offsetTop);
    const ratio = sec.scrollHeight ? (off / sec.scrollHeight) : 0;
    return { chapterIdx: activeIdx, offset: off, offsetRatio: Number.isFinite(ratio) ? ratio : 0 };
  }

  function scheduleSaveOffset() {
    if (!currentBookPath) return;
    if (_saveTO) clearTimeout(_saveTO);
    _saveTO = setTimeout(() => {
      // saveProgress({ path: currentBookPath, chapterIdx: activeIdx, offset: getActiveOffset() });
      const p = getActiveProgress();
      saveProgress({ path: currentBookPath, chapterIdx: p.chapterIdx, offset: p.offset, offsetRatio: p.offsetRatio });
    }, 500);
  }

  // =========================
  // 6) 高亮器：中线法（短章优先）
  // =========================
  function setupChapterHighlighter({ containerSelector, chapterSelector, refRatio = 0.6 }) {
    const container = document.querySelector(containerSelector);
    if (!container) return;
    // if (window.__restoring) return; 
    function updateHighlight() {
      const rect = container.getBoundingClientRect();
      const refY = rect.top + rect.height * refRatio;
      const chapters = [...container.querySelectorAll(chapterSelector)];
      if (!chapters.length) return;

      // 短章近顶优先
      for (const el of chapters) {
        const r = el.getBoundingClientRect();
        const isShort = r.height < rect.height * 0.5;
        const hitsTopBand = (r.top - rect.top) <= 80 && r.bottom > rect.top;
        if (isShort && hitsTopBand) {
          const idx = Number(el.getAttribute('data-idx'));
          if (!Number.isNaN(idx)) {
            if (!navigating || idx === pendingIdx) {
              setActive(idx);
              if (navigating && idx === pendingIdx) {
                navigating = false; pendingIdx = -1;
                if (_navTO) { clearTimeout(_navTO); _navTO = null; }
              }
            }
          }
          return;
        }
      }

      // 中线命中
      for (const el of chapters) {
        const r = el.getBoundingClientRect();
        if (r.top <= refY && r.bottom >= refY) {
          const idx = Number(el.getAttribute('data-idx'));
          if (!Number.isNaN(idx)) {
            if (!navigating || idx === pendingIdx) {
              setActive(idx);
              if (navigating && idx === pendingIdx) {
                navigating = false; pendingIdx = -1;
                if (_navTO) { clearTimeout(_navTO); _navTO = null; }
              }
            }
          }
          return;
        }
      }
    }

    const rafScroll = () => requestAnimationFrame(updateHighlight);
    container.addEventListener('scroll', rafScroll);
    window.addEventListener('resize', updateHighlight);
    updateHighlight();
  }

  // =========================
  // 7) DOM 辅助
  // =========================
  function topChapterEl() {
    return content.querySelector('.chapter');
  }
  function bottomChapterEl() {
    const list = content.querySelectorAll('.chapter');
    return list.length ? list[list.length - 1] : null;
  }
  function parseIdx(el) {
    const n = Number(el?.dataset?.idx);
    return Number.isFinite(n) ? n : null;
  }
  function recomputeBounds() {
    const top = topChapterEl();
    const bot = bottomChapterEl();
    if (top) headIdx = parseIdx(top);
    if (bot) nextIdx = parseIdx(bot) + 1;
  }

  function pickAnchor(prefIdx = null) {
    // 导航期优先用 pendingIdx；否则用传入的优先值；再退到 activeIdx
    let anchorIdx = null;
    if (prefIdx != null) anchorIdx = prefIdx;
    else if (navigating && pendingIdx >= 0) anchorIdx = pendingIdx;
    else anchorIdx = activeIdx;
    return (
      content.querySelector(`.chapter[data-idx="${anchorIdx}"]`) ||
      content.querySelector('.chapter') || content
    );
  }

  // =========================
  // 8) 打开/恢复：对接 preload
  // =========================

  function onBookLoaded(res, restore = undefined) {

    // （1）绑定/校验 DOM 引用（防空，不改变行为）
    bookTitleEl = bookTitleEl || document.getElementById('bookTitle') || document.getElementById('book-title');
    toc = toc || document.getElementById('toc');
    content = content || document.getElementById('content');

    window.__restoring = !!restore;
    book = res;
    currentBookPath = res.path || res.filePath || res.fullPath || null;
    console.log('📗[onBookLoaded] currentBookPath =', currentBookPath, 'restore =', restore);
    // （3）标题（防空，保证不崩）
    if (bookTitleEl) bookTitleEl.textContent = book.title || '未命名';
    else document.title = book.title || 'EPUB Reader';

    if (!book.chapters?.length) {
      toc.innerHTML = '<div class="empty pad">未发现 (x)html 章节</div>';
      content.innerHTML = '<div class="empty">这本书没有可显示的正文</div>';
      console.warn('no chapters; early return');
      console.groupEnd();
      return;
    }

    renderTOC();

    const startIdx = restore?.chapterIdx ?? 0;
    const startOffset = restore?.offset ?? 0;
    startFrom(startIdx, startOffset);

    setupChapterHighlighter({
      containerSelector: "#content",
      chapterSelector: "#content .chapter",
      activeClass: "active",
      refRatio: 0.5
    });
    setTimeout(() => { window.__restoring = false; }, 0);
  }

  function getBookId(res) {
    // 1) 最稳的是 EPUB 元数据里的唯一标识（dc:identifier）
    if (res?.metadata?.identifier) return 'epub:' + res.metadata.identifier;
    // 2) 次选：文件绝对路径
    if (res?.filePath) return 'file:' + res.filePath;
    // 3) 兜底：标题（不推荐，但比没有强）
    return 'title:' + (res?.title || 'unknown');
  }
  function loadProgress(bookId) {
    try { return JSON.parse(localStorage.getItem('progress:' + bookId) || 'null'); }
    catch { return null; }
  }

  async function openBookFromPath(epubPath, restore) {
    const res = await window.EPUB.loadFromPath(epubPath);
    if (!res) throw new Error('加载失败');
    onBookLoaded(res, restore);
    rememberLastBookPath(epubPath);
  }

  async function restoreLastBookIfAny() {
    const last = readLastBook();
    const lastPath = last?.path;
    console.log('🛟[restoreLastBookIfAny] last =', last, 'lastPath =', lastPath);
    if (!lastPath || !window.EPUB?.loadFromPath) return false;
    try {
      await openBookFromPath(lastPath, {
        chapterIdx: last.chapterIdx ?? 0,
        offset: last.offset ?? 0
      });
      return true;
    } catch (e) {
      console.warn('恢复失败，清理记录：', e);
      writeLastBook({});
      return false;
    }
  }

  // =========================
  // 9) 事件绑定
  // =========================

  // 滚动补章
  content.addEventListener('scroll', () => {
    if (progScrolling || window.__restoring) return;
    if (content.scrollTop > 200) userHasScrolled = true;
    if (content.scrollTop > 150 && navigating) { navigating = false; pendingIdx = -1; }

    // 接近底部 → 向下补章
    const remaining = content.scrollHeight - content.clientHeight - content.scrollTop;
    const nearBottom = remaining < Math.max(600, content.clientHeight * 0.4);
    if (nearBottom && userHasScrolled && !loading) appendNext();

    scheduleSaveOffset();

  });


  async function openEPUB() {
    showStatus('解析中…');

    try {
      const res = await window.EPUB.pickAndLoad();
      console.log('📂[openEPUB] got res?', !!res);

      if (!res) {
        showStatus('已取消');
        setTimeout(() => showStatus(''), 1500);
        return;
      }
      const p = res.path || res.filePath || res.fullPath;

      if (p) rememberLastBookPath(p);

      onBookLoaded(res);
      showStatus('加载完成');
      setTimeout(() => showStatus(''), 1500);
    } catch (e) {
      console.error('📂[openEPUB] failed:', e);
      showStatus(`解析失败：${e?.message || e}`);
    }
  }

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') openEPUB();
  });

  function lockAndRestoreTo(sec, last) {
    if (!sec) return;
    const px = last?.offset ?? 0;
    const ratio = last?.offsetRatio ?? 0;
    const want = () => {
      // 有像素就用像素；像素为 0 时用比例（例如刚好章首）
      const byRatio = Math.round((ratio || 0) * sec.scrollHeight);
      return sec.offsetTop + (px > 0 ? px : byRatio);
    };

    window.__restoring = true;
    progScrolling = true;

    const recenter = () => {
      const target = want();
      const delta = target - content.scrollTop;
      if (Math.abs(delta) > 2) content.scrollTop += delta;
    };

    // 初次定位 + 双帧微调（应对图片/字体迟到）
    content.scrollTop = want();
    requestAnimationFrame(() => {
      recenter();
      requestAnimationFrame(() => recenter());
    });

    // 观察该章节尺寸变化，在短时间窗口内自动再校准一次
    const ro = new ResizeObserver(() => recenter());
    try { ro.observe(sec); } catch { }

    // 也等字体就绪后再校准一次（有些字体会迟到）
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => recenter()).catch(() => { });
    }

    // 800ms 后解绑 & 解锁（足够大部分资源完成布局）
    setTimeout(() => {
      try { ro.disconnect(); } catch { }
      progScrolling = false;
      window.__restoring = false;
    }, 800);
  }


  async function tryRestoreFromCache() {
    const last = readLastBook();
    console.log('🚀[tryRestoreFromCache] last =', last);

    const lastPath = last?.path;
    console.log('🚀[tryRestoreFromCache] lastPath =', lastPath);

    if (!lastPath) return false;

    const snap = await EpubCache.loadSnapshotByPath(lastPath);
    console.log('🗃️[cache] snapshot =', !!snap, snap?.meta);
    if (!snap) return false;

    // ——恢复期上锁
    window.__restoring = true;

    // 1) 用缓存目录先把 TOC 和标题画出来（此时还没有真实的 book）
    book = { title: snap.meta.title, chapters: (snap.meta.chaptersMeta || []) };
    currentBookPath = lastPath;
    bookTitleEl && (bookTitleEl.textContent = book.title || '');
    // setWinTitle(composeWinTitle(activeIdx)); 
    setWinTitle(book.title || ''); // 先只显示“书名”

    renderTOC();

    // 2) 把已缓存的章节按索引顺序塞入 DOM（作为“首屏”）
    content.innerHTML = '';
    const indices = [...snap.chapters.keys()].sort((a, b) => a - b);
    headIdx = indices.length ? indices[0] : 0;
    nextIdx = indices.length ? (indices[indices.length - 1] + 1) : 0;

    for (const i of indices) {
      const sec = document.createElement('section');
      sec.className = 'chapter';
      sec.dataset.idx = String(i);
      sec.innerHTML = snap.chapters.get(i);
      content.appendChild(sec);
    }

    // 3) 恢复阅读位置（如果有）
    const startIdx = last?.chapterIdx ?? headIdx;
    console.log('🎯[cache] restore to idx =', startIdx, 'offset =', last?.offset);
    const sec = content.querySelector(`.chapter[data-idx="${startIdx}"]`);
    // if (sec) {
    //   window.__restoring = true;
    //   progScrolling = true;
    //   content.scrollTop = sec.offsetTop + (last?.offset ?? 0);
    //   setTimeout(() => { progScrolling = false; }, 0);
    // }

    if (sec) lockAndRestoreTo(sec, last);

    // 4) 高亮器启动（让目录跟随）；解析稍后在后台进行
    setupChapterHighlighter({
      containerSelector: "#content",
      chapterSelector: "#content .chapter",
      refRatio: 0.5
    });

    // ——下一帧解锁（恢复期内不保存进度）
    setTimeout(() => { window.__restoring = false; }, 0);

    hydratedFromCache = true;     // ☆ 告诉后面：我们是“缓存首屏”启动
    return true;
  }

  // 启动流程：先尝试缓存 → 成功就后台解析，失败再走正常解析
  (async () => {
    const ok = await tryRestoreFromCache();
    const last = readLastBook();
    const lastPath = last?.path;
    // if (!last) return;
    console.log('🔁[startup] cacheOK =', ok, 'last =', last, 'lastPath =', lastPath);


    if (ok && lastPath && window.EPUB?.loadFromPath) {
      // 后台解析真正的 EPUB，以便继续加载后续章节
      window.EPUB.loadFromPath(lastPath).then(res => {
        if (hydratedFromCache) {
          // ☆ 仅刷新数据与目录，不动正文/滚动位置
          book = res;
          bookTitleEl && (bookTitleEl.textContent = book.title || '');
          setWinTitle(composeWinTitle(activeIdx)); // 初始窗口标题

          renderTOC();         // 目录名可能更完整，用真实的覆盖
          // 让后续 appendNext() 继续基于现有 headIdx/nextIdx 往后补章
        } else {
          console.log('🔧[startup] no hydrate, full onBookLoaded');
          onBookLoaded(res, { chapterIdx: activeIdx || 0, offset: 0 });
        }
      }).catch(console.warn);
    } else {
      // 没有缓存就走你原来的 restore 流程
      try { console.log('🛟[startup] fallback restoreLastBookIfAny()'); await restoreLastBookIfAny(); } catch { }
    }
  })();
});

