const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true
});

// ------------ 路径/类型工具 ------------
const toPosix = (p) => p.replace(/\\/g, '/');
const pDir = (p) => path.posix.dirname(toPosix(p));
const pJoin = (...xs) => path.posix.join(...xs.map(toPosix));

const IMG_EXT_2_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.avif': 'image/avif'
}

const FONT_EXT_2_MIME = {
  '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml'
}

function guessMime(fp, dft = 'application/octet-stream') {
  const ext = path.posix.extname(fp).toLowerCase();
  return IMG_EXT_2_MIME[ext] || FONT_EXT_2_MIME[ext] || dft;
}

// ------------ 安全净化（保留样式） ------------
function sanitizeHtmlKeepStyle(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')        // 去脚本
    .replace(/\son[a-z]+=(?:"[^"]*"|'[^']*')/gi, '');          // 去内联事件属性
}

// ------------ 图片内联（HTML 中的 <img>） ------------
async function inlineImages(html, chapterPath, zip) {
  const dir = pDir(chapterPath);
  const re = /<img\b([^>]*?)\bsrc\s*=\s*(['"])([^"']+)\2([^>]*)>/gi;

  async function rep(match, pre, quote, src, post) {
    const url = src.trim();
    if (/^(data:|blob:|https?:)/i.test(url)) return match;
    const resolved = pJoin(dir, url.split('#')[0].split('?')[0]);
    const file = zip.file(resolved);
    if (!file) return match;
    const u8 = await file.async('uint8array');
    const mime = guessMime(resolved);
    const b64 = Buffer.from(u8).toString('base64');
    return `<img${pre}src=${quote}data:${mime};base64,${b64}${quote}${post}>`;
  }

  let out = '', last = 0, m;
  while ((m = re.exec(html)) !== null) {
    out += html.slice(last, m.index);
    // eslint-disable-next-line no-await-in-loop
    out += await rep(m[0], m[1] || '', m[2] || '"', m[3] || '', m[4] || '');
    last = m.index + m[0].length;
  }
  out += html.slice(last);
  return out;
}

// ------------ SVG <image>/<use> 内联 ------------
async function inlineSvgImages(html, chapterPath, zip) {
  const dir = pDir(chapterPath);

  async function inlineTag(tagStr) {
    const m = tagStr.match(/\b(xlink:href|href)\s*=\s*(['"])([^"']+)\2/i);
    if (!m) return tagStr;

    const url = (m[3] || '').trim();
    if (/^(data:|blob:|https?:)/i.test(url)) return tagStr; // 已经是绝对/内联，跳过

    const resolved = pJoin(dir, url.split('#')[0].split('?')[0]);
    const file = zip.file(resolved);
    if (!file) return tagStr;

    const u8 = await file.async('uint8array');
    const mime = guessMime(resolved);
    const b64 = Buffer.from(u8).toString('base64');
    const data = `data:${mime};base64,${b64}`;

    // 同时写 href 和 xlink:href，省得兼容性扯皮
    let out = tagStr;
    out = out.replace(/\bxlink:href\s*=\s*(['"])[^"']+\1/i, `xlink:href="${data}"`);
    out = out.replace(/\bhref\s*=\s*(['"])[^"']+\1/i, `href="${data}"`);
    return out;
  }

  // 先 <image>
  let out = '', last = 0, m;
  const reImg = /<image\b[^>]*>/gi;
  while ((m = reImg.exec(html)) !== null) {
    out += html.slice(last, m.index);
    // eslint-disable-next-line no-await-in-loop
    out += await inlineTag(m[0]);
    last = m.index + m[0].length;
  }
  out += html.slice(last);

  // 再 <use>（有些封面这么写）
  let out2 = '', last2 = 0, m2;
  const reUse = /<use\b[^>]*>/gi;
  while ((m2 = reUse.exec(out)) !== null) {
    out2 += out.slice(last2, m2.index);
    // eslint-disable-next-line no-await-in-loop
    out2 += await inlineTag(m2[0]);
    last2 = m2.index + m2[0].length;
  }
  out2 += out.slice(last2);
  return out2;
}


// ------------ CSS 内联与资源内联（@import + url()） ------------
async function inlineCssText(cssText, basePath, zip) {
  // 1) 处理 @import
  const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*;?/gi;
  let css = '';
  let last = 0, m;
  while ((m = importRe.exec(cssText)) !== null) {
    css += cssText.slice(last, m.index);
    const href = (m[2] || m[4] || '').trim();
    if (/^(data:|blob:|https?:)/i.test(href)) {
      // 外部的直接丢弃（CSP 也会拦）
    } else {
      const resolved = pJoin(basePath, href.split('#')[0].split('?')[0]);
      const file = zip.file(resolved);
      if (file) {
        // eslint-disable-next-line no-await-in-loop
        let child = await file.async('string');
        // eslint-disable-next-line no-await-in-loop
        child = await inlineCssText(child, pDir(resolved), zip);
        css += child;
      }
    }
    last = m.index + m[0].length;
  }
  css += cssText.slice(last);

  // 2) 处理 url()
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let out = '', last2 = 0, m2;
  while ((m2 = urlRe.exec(css)) !== null) {
    out += css.slice(last2, m2.index);
    // 这里是你的 while ((m2 = urlRe.exec(css)) !== null) { ... }
    const rawUrl = m2[2].trim();
    if (/^(data:|blob:|https?:)/i.test(rawUrl)) {
      out += m2[0]; // 原样保留
    } else if (/^file:/i.test(rawUrl)) {
      // ← 新增的分支：把 file:///D:/... 读出来，转成 data:
      const localPath = decodeURI(rawUrl).replace(/^file:\/\/\/?/i, '');
      try {
        const buf = fs.readFileSync(localPath);
        const mime = guessMime(localPath) || 'font/ttf';
        const b64 = Buffer.from(buf).toString('base64');
        out += `url(data:${mime};base64,${b64})`;
      } catch {
        // 读不到就保留原样，至少不崩
        out += m2[0];
      }
    } else {
      // 你原来的 zip 相对路径处理不变
      const resolved = pJoin(basePath, rawUrl.split('#')[0].split('?')[0]);
      const file = zip.file(resolved);
      if (file) {
        const u8 = await file.async('uint8array');
        const mime = guessMime(resolved);
        const b64 = Buffer.from(u8).toString('base64');
        out += `url(data:${mime};base64,${b64})`;
      } else {
        out += m2[0];
      }
    }
    last2 = m2.index + m2[0].length;
  }
  out += css.slice(last2);
  out = inlineLocalFontsInCss(out);
  return out;
}

// 把 <link rel="stylesheet" href="..."> → <style>...内联...</style>
// 同时把已有 <style>...</style> 里的 url()/@import 也处理掉
async function inlineLinksAndStyles(html, chapterPath, zip) {
  const dir = pDir(chapterPath);

  // link → style
  const linkRe = /<link\b[^>]*rel=["']?[^"']*stylesheet[^"']*["'][^>]*>/gi;
  let out = '', last = 0, m;
  while ((m = linkRe.exec(html)) !== null) {
    out += html.slice(last, m.index);
    const tag = m[0];
    const mHref = tag.match(/\bhref\s*=\s*(['"])([^"']+)\1/i);
    if (!mHref) {
      // drop
    } else {
      const href = mHref[2].trim();
      if (!/^(data:|blob:|https?:)/i.test(href)) {
        const resolved = pJoin(dir, href.split('#')[0].split('?')[0]);
        const file = zip.file(resolved);
        if (file) {
          // eslint-disable-next-line no-await-in-loop
          let css = await file.async('string');
          // eslint-disable-next-line no-await-in-loop
          css = await inlineCssText(css, pDir(resolved), zip);
          out += `<style>${css}</style>`;
        }
      }
    }
    last = m.index + m[0].length;
  }
  out += html.slice(last);
  html = out;

  // 处理现有 <style>
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  out = ''; last = 0;
  let m2;
  while ((m2 = styleRe.exec(html)) !== null) {
    out += html.slice(last, m2.index);
    const cssRaw = m2[1] || '';
    // eslint-disable-next-line no-await-in-loop
    const css = await inlineCssText(cssRaw, dir, zip);
    out += `<style>${css}</style>`;
    last = m2.index + m2[0].length;
  }
  out += html.slice(last);

  // 兜底：移除残余 stylesheet link（避免尝试网络加载）
  out = out.replace(/<link\b[^>]*rel=["']?[^"']*stylesheet[^"']*["'][^>]*>/gi, '');

  return out;
}


// 允许的本地字体路径（白名单，按需改）——避免把系统盘乱读一通
const FONT_WHITELIST = [
  /^d:\\shadowgraden\\fonts(\\|\/)?/i,   // D:\shadowGraden\Fonts\
  // 你还可追加其他目录
];

// 简单的扩展名 -> MIME
const FONT_MIME = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// 把 CSS 里的 url(...) 字符串还原出本地绝对路径
function cssUrlToLocalPath(raw) {
  if (!raw) return null;
  let u = raw.trim().replace(/^url\(\s*(['"]?)([^'")]+)\1\s*\)$/i, '$2');
  // 解码 %20 等
  try { u = decodeURI(u); } catch { }

  // Windows file:// URI -> 本地盘
  if (/^file:\/\//i.test(u)) {
    // file:///D:/shadowGraden/Fonts/h2.ttf -> D:\shadowGraden\Fonts\h2.ttf
    const m = u.match(/^file:\/\/\/?([A-Za-z]:\/.*)$/);
    if (m) return m[1].replace(/\//g, '\\');
    // 其他形态，不处理
    return null;
  }

  // 直接是绝对盘符路径 D:/... 或 D:\...
  if (/^[A-Za-z]:[\\/]/.test(u)) {
    return u.replace(/\//g, '\\');
  }

  // 以 / 开头的“根路径”就别碰了（多半不是你想要的本地盘）
  return null;
}

// 检查是否在白名单
function isWhitelisted(p) {
  if (!p) return false;
  const norm = p.toLowerCase();
  return FONT_WHITELIST.some(re => re.test(norm));
}

// 读取本地字体并返回 data:URL，失败则返回 null
function tryInlineLocalFont(localPath) {
  try {
    if (!isWhitelisted(localPath)) return null;
    if (!fs.existsSync(localPath)) return null;
    const buf = fs.readFileSync(localPath);
    const ext = path.extname(localPath).toLowerCase();
    const mime = FONT_MIME[ext] || 'application/octet-stream';
    const b64 = buf.toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

// ===== 在你处理 CSS 文本的函数里（比如 inlineCssText）增加这段逻辑 =====
// 举例：把 cssText 里所有 url(...) 都过一遍，遇到 file 本地字体就替换为 data:
function inlineLocalFontsInCss(cssText) {
  return cssText.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (m, q, url) => {
      // 只处理可能是本地的字体/资源
      const localPath = cssUrlToLocalPath(m);
      if (!localPath) return m;  // 交回给原有逻辑（zip 内联等）

      const ext = path.extname(localPath).toLowerCase();
      if (!['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) {
        // 不是字体就不内联，原样返回
        return m;
      }
      const dataUrl = tryInlineLocalFont(localPath);
      return dataUrl ? `url(${dataUrl})` : m; // 失败就保留原样（但你也可以改成删除）
    }
  );
}


// ------------ 标题提取与占位过滤 ------------
function extractTitle(html, fallback) {
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t && t[1]) return t[1].trim();
  const h = html.match(/<(h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/i);
  if (h && h[2]) return h[2].replace(/<[^>]+>/g, '').trim();
  return fallback;
}
function isImageOnly(html) {
  const imgCount = (html.match(/<img\b/gi) || []).length;
  const textLen = html.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, '').trim().length;
  return imgCount > 0 && textLen < 20;
}
function filenameHintTitle(fileName) {
  const fn = fileName.toLowerCase();
  if (fn.includes('cover') || fn.includes('封面')) return '封面';
  if (fn.includes('back') || fn.includes('封底')) return '封底';
  if (fn.includes('toc') || fn.includes('目录') || fn.includes('nav')) return '目录';
  return null;
}
const prettyTitleFrom = (s) => s.replace(/\.x?html?$/i, '');

// ------------ 主解析 ------------
async function parseEpub(epubPath) {

  const buf = fs.readFileSync(epubPath);
  const zip = await JSZip.loadAsync(buf);

  // container.xml → OPF
  const containerEntry = zip.file('META-INF/container.xml');
  if (!containerEntry) throw new Error('找不到 META-INF/container.xml');
  const containerXml = await containerEntry.async('string');
  const container = xmlParser.parse(containerXml);
  const rf = container.container?.rootfiles?.rootfile;
  const opfPath = toPosix(Array.isArray(rf) ? rf[0]['@_full-path'] : rf['@_full-path']);

  // OPF
  const opfEntry = zip.file(opfPath);
  if (!opfEntry) throw new Error(`找不到 OPF: ${opfPath}`);
  const opfXml = await opfEntry.async('string');
  const opf = xmlParser.parse(opfXml);

  // 书名
  let bookTitle = 'Untitled';
  const meta = opf.package?.metadata || {};
  if (typeof meta.title === 'string') bookTitle = meta.title.trim();
  else if (Array.isArray(meta.title)) bookTitle = String(meta.title[0] ?? bookTitle);
  else if (meta['dc:title']) bookTitle = Array.isArray(meta['dc:title']) ? meta['dc:title'][0] : meta['dc:title'];

  // manifest / spine
  const items = [].concat(opf.package?.manifest?.item || []);
  const spine = [].concat(opf.package?.spine?.itemref || []);
  if (!items.length || !spine.length) throw new Error('OPF 缺少 manifest 或 spine');

  const byId = new Map(items.map(it => [it['@_id'], it]));
  const baseDir = pDir(opfPath);

  const chapters = [];
  for (let i = 0; i < spine.length; i++) {
    const idref = spine[i]['@_idref'];
    const m = byId.get(idref);
    if (!m) continue;
    const href = m['@_href'];
    const media = (m['@_media-type'] || m['@_media'] || '').toLowerCase();
    if (!href) continue;

    const looksHtml = media.includes('html') || /\.x?html?$/i.test(href);
    if (!looksHtml) continue;

    const entryPath = pJoin(baseDir, href);
    const fileName = path.posix.basename(entryPath).toLowerCase();
    if (fileName === 'chapter.xhtml') continue; // 跳过常见占位

    const file = zip.file(entryPath);
    if (!file) continue;

    // 0) ★ 先读出章节内容
    let html = await file.async('string');

    // 1) 去脚本/事件
    html = sanitizeHtmlKeepStyle(html);
    // 2) link/style 内联并处理 url()/@import
    html = await inlineLinksAndStyles(html, entryPath, zip);
    // 3) <img src> 内联
    html = await inlineImages(html, entryPath, zip);
    // 4) ★ SVG 封面等：<image>/<use> 内联
    html = await inlineSvgImages(html, entryPath, zip);

    // 标题
    let title = filenameHintTitle(fileName) || extractTitle(html, null);
    if (!title && isImageOnly(html)) title = '图片页';
    if (!title) title = prettyTitleFrom(fileName);

    chapters.push({ id: idref, href: entryPath, title, html });
  }

  return { filePath: epubPath, title: bookTitle, chapters };
}

// contextBridge.exposeInMainWorld('EPUB', {
//   pickAndLoad: async () => {
//     const fsPath = await ipcRenderer.invoke('pick-epub');
//     if (!fsPath) return null;
//     console.time('[PRELOAD] parseEpub');
//     const payload = await parseEpub(fsPath);
//     console.timeEnd('[PRELOAD] parseEpub');
//     console.log('[PRELOAD] payload =', !!payload, payload?.title, payload?.chapters?.length);
//     return payload;              // ★ 关键：把结果“返回”给 renderer
//   },
//   loadFromPath: async (fsPath) => {
//     if (!fsPath) return null;
//     const payload = await parseEpub(fsPath);
//     return payload;              // ★ 同理：返回
//   }
// });

contextBridge.exposeInMainWorld('EPUB', {
  pickAndLoad: async () => {
    const p = await ipcRenderer.invoke('pick-epub');
    if (!p) return null;
    return await parseEpub(p);
  },
  loadFromPath: async (epubPath) => {
    if (!epubPath) return null;
    return await parseEpub(epubPath);
  }
});

// 暴露 ipcRenderer 和其他方法
// contextBridge.exposeInMainWorld('app', {
//   setTitle: (t) => ipcRenderer.send('app:set-title', String(t ?? '')),
//   ipcRenderer: ipcRenderer  // 这是暴露的 ipcRenderer
// });

contextBridge.exposeInMainWorld('app', {
  ipc: {
    send: (ch, ...args) => ipcRenderer.send(ch, ...args),
    invoke: (ch, ...args) => ipcRenderer.invoke(ch, ...args),
    on: (ch, handler) => {
      const wrapped = (_e, ...a) => { try { handler(...a); } catch (err) { console.error(err); } };
      ipcRenderer.on(ch, wrapped);
      return () => ipcRenderer.removeListener(ch, wrapped);
    },
  },
  setTitle: (t) => ipcRenderer.send('app:set-title', String(t ?? '')),
  // ipcRenderer: ipcRenderer
});