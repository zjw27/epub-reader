// renderer.js — EPUB 阅读器（软跳转精简版）
window.addEventListener('DOMContentLoaded', () => {
  // =========================
  // 0) DOM 引用 & 运行时状态
  // =========================
  const openBtn = document.getElementById('openBtn');
  const bookTitleEl = document.getElementById('bookTitle');
  const toc = document.getElementById('toc');
  const content = document.getElementById('content');

  // ——索引区间：DOM中实际存在的章节是 [headIdx ... nextIdx-1]
  let headIdx = 0;           // 顶端那章的索引
  let nextIdx = 0;           // 尾端之后的索引（下一章将被 append 到此）
  let progScrolling = false; // 程序化滚动保护（裁剪已删除，但上补/定位仍需）
  let loading = false;

  // ——阅读/存档状态
  let book = { title: '', chapters: [] };
  let activeIdx = 0;
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
  const readLastBook = () => { try { const r = localStorage.getItem(LAST_BOOK_KEY); return r ? JSON.parse(r) : null; } catch { return null; } };
  const writeLastBook = (obj) => { try { localStorage.setItem(LAST_BOOK_KEY, JSON.stringify(obj)); } catch {} };
  const rememberLastBookPath = (path) => { if (!path) return; const old = readLastBook() || {}; writeLastBook({ ...old, path, v:2, ts: Date.now() }); };
  const saveProgress = (patch) => { const old = readLastBook() || {}; writeLastBook({ ...old, ...patch, v:2, ts: Date.now() }); };

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
    });
  }
  function markActive(idx) {
    [...toc.children].forEach((el, i) => el.classList?.toggle('active', i === idx));
  }
  function setActive(idx) {
    if (idx === activeIdx) return;
    activeIdx = idx;
    markActive(idx);
    if (currentBookPath) saveProgress({ path: currentBookPath, chapterIdx: idx });
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
    sec.innerHTML =
      `<div class="chapter-marker">${esc(ch.title || ch.href)}</div>` +
      (sanitizeAgain(ch.html || '') || '<div class="empty">本章无内容</div>');

    content.appendChild(sec);
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
    const ch  = book.chapters[idx];
    if (!ch) { loading = false; return; }

    const sec = document.createElement('section');
    sec.className = 'chapter';
    sec.dataset.idx = String(idx);
    sec.innerHTML =
      `<div class="chapter-marker">${esc(ch.title || ch.href)}</div>` +
      (sanitizeAgain(ch.html || '') || '<div class="empty">本章无内容</div>');

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
  function batchPrependUp(count = 1) {
    if (mutatingUp || loading) return;
    if (headIdx <= 0 || count <= 0) return;

    mutatingUp = true;
    loading = true;

    const anchor = pickAnchor(); // 以当前激活章为锚（退化到第一章/容器）
    const beforeTop = anchor.getBoundingClientRect().top;

    const start = Math.max(0, headIdx - count);
    const frag = document.createDocumentFragment();
    for (let k = start; k < headIdx; k++) {
      const ch = book.chapters[k];
      if (!ch) continue;
      const sec = document.createElement('section');
      sec.className = 'chapter';
      sec.dataset.idx = String(k);
      const marker = `<div class="chapter-marker">${esc(ch.title || ch.href)}</div>`;
      sec.innerHTML = marker + (sanitizeAgain(ch.html || '') || '<div class="empty">本章无内容</div>');
      frag.appendChild(sec);
    }

    const firstChap = content.querySelector('.chapter');
    if (firstChap) content.insertBefore(frag, firstChap);
    headIdx = start;

    // 位移补偿 + 双帧微调（应对图片/字体解码回流）
    const afterTop = anchor.getBoundingClientRect().top;
    content.scrollTop += (afterTop - beforeTop);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const afterTop2 = anchor.getBoundingClientRect().top;
        const delta2 = afterTop2 - beforeTop;
        if (Math.abs(delta2) > 2) content.scrollTop += delta2;
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
      if (sec) content.scrollTop = sec.offsetTop + offset;
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
      batchPrependUp(need); // 向上一次性补齐（锚点锁视口）
    } else if (idx >= nextIdx) {
      while (nextIdx <= idx && !loading) appendNext(); // 顺序向下补齐
    }

    // 2) 瞬时定位（禁平滑）
    const sec = content.querySelector(`.chapter[data-idx="${idx}"]`);
    if (sec) {
      const prev = content.style.scrollBehavior;
      content.style.scrollBehavior = 'auto';
      content.scrollTop = sec.offsetTop;
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
  function scheduleSaveOffset() {
    if (!currentBookPath) return;
    if (_saveTO) clearTimeout(_saveTO);
    _saveTO = setTimeout(() => {
      saveProgress({ path: currentBookPath, chapterIdx: activeIdx, offset: getActiveOffset() });
    }, 500);
  }

  // =========================
  // 6) 高亮器：中线法（短章优先）
  // =========================
  function setupChapterHighlighter({ containerSelector, chapterSelector, refRatio = 0.6 }) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

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
  function pickAnchor() {
    return (
      content.querySelector(`.chapter[data-idx="${activeIdx}"]`) ||
      content.querySelector('.chapter') || content
    );
  }
  // 调试用
  window.__dump = () => {
    const top = topChapterEl(), bot = bottomChapterEl();
    console.log('[dump]',
      'top=', parseIdx(top),
      'bot=', parseIdx(bot),
      'headIdx=', headIdx,
      'nextIdx=', nextIdx,
      'count=', content.querySelectorAll('.chapter').length
    );
  };

  // =========================
  // 8) 打开/恢复：对接 preload
  // =========================
  function onBookLoaded(res, restore) {
    book = res;
    currentBookPath = res.path || res.filePath || res.fullPath || null;
    bookTitleEl.textContent = book.title || '未命名';
    if (!book.chapters?.length) {
      toc.innerHTML = '<div class="empty pad">未发现 (x)html 章节</div>';
      content.innerHTML = '<div class="empty">这本书没有可显示的正文</div>';
      return;
    }
    renderTOC();
    const startIdx = restore?.chapterIdx ?? 0;
    const startOffset = restore?.offset ?? 0;
    startFrom(startIdx, startOffset);
    setupChapterHighlighter({
      containerSelector: "#content",
      chapterSelector: "#content .chapter",
      refRatio: 0.5
    });
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
  openBtn.addEventListener('click', async () => {
    content.innerHTML = '<div class="empty">解析中…</div>';
    try {
      const res = await window.EPUB.pickAndLoad();
      if (!res) { content.innerHTML = '<div class="empty">已取消</div>'; return; }
      const p = res.path || res.filePath || res.fullPath;
      if (p) rememberLastBookPath(p);
      onBookLoaded(res);
    } catch (e) {
      console.error(e);
      content.innerHTML = `<div class="empty">解析失败：${e?.message || e}</div>`;
    }
  });

  content.addEventListener('scroll', () => {
    if (progScrolling) { scheduleSaveOffset?.(); return; } // 程序化滚动早退
    if (content.scrollTop > 200) userHasScrolled = true;
    if (content.scrollTop > 150 && navigating) { navigating = false; pendingIdx = -1; }

    // 接近底部 → 向下补章
    const remaining = content.scrollHeight - content.clientHeight - content.scrollTop;
    const nearBottom = remaining < Math.max(600, content.clientHeight * 0.4);
    if (nearBottom && userHasScrolled && !loading) appendNext();

    scheduleSaveOffset();
  });

  // 启动即尝试恢复（失败静默）
  (async () => { try { await restoreLastBookIfAny(); } catch {} })();
});
