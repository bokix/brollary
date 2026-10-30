// Brollary 渲染进程。
// 状态模型：
//  - 视图 view（互斥）：all | trash | smart | color | dup —— 切换即重置筛选
//  - 组合筛选（仅 all/trash 生效）：query × ext × tag
const api = window.stash;

const AUDIO = new Set(["wav", "mp3", "aif", "aiff", "flac", "m4a"]);
const VIDEO = new Set(["mov", "mp4", "wmv", "m4v", "webm", "avi", "mkv"]);
const FONT = new Set(["ttf", "otf", "woff", "woff2"]);
const IMG = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "svg"]);
const HOVER_DELAY = 350;

const state = {
  view: "all",        // all | trash | smart | color | dup
  smartId: null,
  smartName: "",
  query: "", ext: null, tag: null, color: null,
  libraryPath: "", rows: [], selectedId: null, metaId: null,
  ovIndex: -1, zoom: 1, rot: 0,
};

// ── 工具 ────────────────────────────────────────────────
const itemDir = (id) => `${state.libraryPath}/images/${id}.info`;
const fileUrl = (p) => "file://" + encodeURI(p).replace(/#/g, "%23");
const originalUrl = (row) => fileUrl(`${itemDir(row.id)}/${row.name}.${row.ext}`);
const previewUrl = (row) => fileUrl(`${itemDir(row.id)}/${row.name}_preview.mp4`);
/** 播放源：有代理副本用代理（prores/hevc 等），否则原件 */
const mediaSrc = (row) => (row.preview ? previewUrl(row) : originalUrl(row));
const thumbUrl = (row) => fileUrl(`${itemDir(row.id)}/${row.name}_thumbnail.png`);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function phColor(ext) {
  let h = 0;
  for (const c of ext) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360} 40% 32%)`;
}

const fmtSize = (n) =>
  n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : n > 1e3 ? (n / 1e3).toFixed(0) + " KB" : n + " B";

function showError(msg) {
  document.getElementById("count").textContent = `⚠ ${msg}`;
  console.error(msg);
}
window.addEventListener("error", (e) => showError(e.message));
window.addEventListener("unhandledrejection", (e) => showError(String(e.reason)));

// ── 视图与筛选状态机 ─────────────────────────────────────
const searchEl = document.getElementById("search");

/** 切换到某个视图（互斥），清空全部组合筛选——干净状态，杜绝隐藏条件 */
function setView(view, { smartId = null, smartName = "", color = null } = {}) {
  state.view = view;
  state.smartId = smartId;
  state.smartName = smartName;
  state.color = color;
  state.query = "";
  state.ext = null;
  state.tag = null;
  searchEl.value = "";
  document.getElementById("trash").checked = view === "trash";
}

/** 筛选条件变化后的统一出口：重绘条件栏 + 刷新列表 */
function afterFilterChange() {
  buildNav();
  refresh();
}

// ── 瀑布流布局 ───────────────────────────────────────────
const scroller = document.getElementById("scroller");
const sizer = document.getElementById("sizer");
const grid = document.getElementById("grid");
const GAP = 10, TARGET_W = 200, MIN_H = 70, MAX_H = 420;

let layout = [];

function computeLayout() {
  const w = scroller.clientWidth - 28;
  const cols = Math.max(1, Math.floor((w + GAP) / (TARGET_W + GAP)));
  const colW = Math.floor((w - GAP * (cols - 1)) / cols);
  const heights = new Array(cols).fill(0);
  layout = state.rows.map((row) => {
    let ci = 0;
    for (let c = 1; c < cols; c++) if (heights[c] < heights[ci]) ci = c;
    const ar = row.width && row.height ? row.height / row.width : 0.75;
    const imgH = Math.round(Math.min(MAX_H, Math.max(MIN_H, colW * ar)));
    const x = ci * (colW + GAP);
    const y = heights[ci];
    heights[ci] += imgH + GAP + 28;
    return { row, x, y, w: colW, imgH, sim: row.sim };
  });
  sizer.style.height = (Math.max(0, ...heights) + 14) + "px";
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(render);
}

// DOM 差量渲染：只增删“进入/离开视口”的节点，保留已渲染的 img，根治滚动闪烁
const rendered = new Map(); // row.id → cell 元素

function render() {
  renderScheduled = false;
  const top = scroller.scrollTop - 300;
  const bottom = scroller.scrollTop + scroller.clientHeight + 300;
  const desired = new Map();
  for (const it of layout) {
    if (it.y > bottom || it.y + it.imgH + 28 < top) continue;
    desired.set(it.row.id, it);
  }
  for (const [id, el] of [...rendered]) {
    if (!desired.has(id)) { el.remove(); rendered.delete(id); }
  }
  for (const [id, it] of desired) {
    let el = rendered.get(id);
    if (!el) {
      const t = document.createElement("template");
      t.innerHTML = cellHtml(it);
      el = t.content.firstElementChild;
      grid.appendChild(el);
      rendered.set(id, el);
      attachImgFallback(el);
    } else {
      el.className = "cell" + (id === state.selectedId ? " sel" : "");
      el.style.left = it.x + "px";
      el.style.top = it.y + "px";
      el.style.width = it.w + "px";
      const media = el.querySelector(".img, .ph");
      if (media && media.style.height !== it.imgH + "px") media.style.height = it.imgH + "px";
    }
  }
  // 悬停的卡片被滚出虚拟区：立刻停播，避免泄漏
  if (hover?.cellEl && !grid.contains(hover.cellEl)) cancelHover();
}

function cellHtml(it) {
  const { row, x, y, w, imgH } = it;
  const sel = row.id === state.selectedId ? " sel" : "";
  const url = thumbUrl(row);
  const media = url
    ? `<div class="img" style="height:${imgH}px"><img loading="lazy" src="${url}"></div>`
    : `<div class="ph" style="height:${imgH}px;background:${phColor(row.ext)}">${row.ext.toUpperCase()}</div>`;
  const idx = state.rows.indexOf(row);
  const simTag = it.sim != null ? `<b class="sim">${it.sim}%</b>` : "";
  return `<div class="cell${sel}" data-i="${idx}" style="left:${x}px;top:${y}px;width:${w}px">
    ${media}
    <div class="label"><span class="ext-tag">${row.ext}</span>${simTag}${escapeHtml(row.name)}</div>
  </div>`;
}

/** 缩略图缺失：图片类型回退原图，其余换占位块 */
function attachImgFallback(root) {
  root.querySelectorAll("img").forEach((img) =>
    img.addEventListener("error", () => {
      const cell = img.closest(".cell");
      if (!cell) return;
      const row = state.rows[+cell.dataset.i];
      if (!row) return;
      if (!img.dataset.fb && IMG.has(row.ext)) {
        img.dataset.fb = "1";
        img.src = originalUrl(row);
        return;
      }
      const h = img.parentNode.style.height || "150px";
      img.parentNode.innerHTML =
        `<div class="ph" style="height:${h};background:${phColor(row.ext)}">${row.ext.toUpperCase()}</div>`;
    }, { once: true }));
}

scroller.addEventListener("scroll", scheduleRender);
window.addEventListener("resize", () => { computeLayout(); scheduleRender(); });

// ── 悬停播放 + 达芬奇式搓擦 ─────────────────────────────
const hoverAudio = document.createElement("audio");
const hoverVideo = document.createElement("video");
hoverVideo.muted = true;
hoverVideo.playsInline = true;
let hover = null;

grid.addEventListener("mouseover", (e) => {
  const cell = e.target.closest(".cell");
  if (!cell || cell === hover?.cellEl) return;
  cancelHover();
  const row = state.rows[+cell.dataset.i];
  if (!row) return;
  const kind = AUDIO.has(row.ext) ? "audio"
    : VIDEO.has(row.ext) ? "video"
    : row.ext === "gif" ? "gif" : null;
  if (!kind) return;
  hover = {
    cellEl: cell, row, kind,
    x: e.clientX, y: e.clientY,
    duration: row.duration ?? null,
    zone: null, segStart: 0,
    seeking: false, pendingT: null,
    timer: setTimeout(() => activateHover(), HOVER_DELAY),
  };
});

grid.addEventListener("mousemove", (e) => {
  if (!hover || !hover.el || e.target.closest(".cell") !== hover.cellEl) return;
  hover.x = e.clientX;
  hover.y = e.clientY;
  applyZone();
});

grid.addEventListener("mouseout", (e) => {
  const cell = e.target.closest(".cell");
  if (cell && hover?.cellEl === cell && !cell.contains(e.relatedTarget)) cancelHover();
});

function activateHover() {
  if (!hover) return;
  const host = hover.cellEl.querySelector(".img, .ph");
  if (!host) return;
  hover.saved = host.innerHTML;

  if (hover.kind === "gif") {
    host.innerHTML = `<img src="${originalUrl(hover.row)}">`;
    return;
  }

  const el = hover.kind === "audio" ? hoverAudio : hoverVideo;
  hover.el = el;
  el.src = mediaSrc(hover.row);
  host.appendChild(el);
  el.classList.add("hover-media");

  hover.playhead = document.createElement("div");
  hover.playhead.className = "playhead";
  hover.bar = document.createElement("div");
  hover.bar.className = "pbar-fill";
  host.appendChild(hover.playhead);
  host.appendChild(hover.bar);

  el.addEventListener("loadedmetadata", () => {
    if (hover && Number.isFinite(el.duration)) hover.duration = el.duration;
  });
  el.addEventListener("timeupdate", onHoverTimeUpdate);
  el.addEventListener("ended", onHoverEnded);

  applyZone(true);
  el.play().catch(() => {});
  const loop = () => {
    if (!hover || hover.el !== el) return;
    drawPlayhead();
    hover.raf = requestAnimationFrame(loop);
  };
  hover.raf = requestAnimationFrame(loop);
}

function zoneOf() {
  const r = hover.cellEl.getBoundingClientRect();
  const top = hover.y < r.top + r.height / 2;
  const frac = Math.min(1, Math.max(0, (hover.x - r.left) / r.width));
  return { top, t: top ? 0 : frac * (hover.duration ?? 0) };
}

function applyZone(force = false) {
  if (!hover?.el) return;
  const { top, t } = zoneOf();
  const zone = top ? "top" : "bottom";
  if (hover.zone !== zone || force) {
    hover.zone = zone;
    hover.segStart = t;
    hover.el.currentTime = t;
    ensurePlaying();
  } else if (zone === "bottom") {
    queueSeek(t);
  }
}

function queueSeek(t) {
  const el = hover?.el;
  if (!el) return;
  hover.pendingT = t;
  pumpSeek();
}

function pumpSeek() {
  const el = hover?.el;
  if (!el || hover.seeking || hover.pendingT == null) return;
  const t = hover.pendingT;
  hover.pendingT = null;
  hover.segStart = t;
  hover.seeking = true;
  const onSeeked = () => {
    el.removeEventListener("seeked", onSeeked);
    if (!hover || hover.el !== el) return;
    hover.seeking = false;
    ensurePlaying();
    pumpSeek();
  };
  el.addEventListener("seeked", onSeeked);
  el.currentTime = t;
}

function onHoverTimeUpdate() {
  const el = hover?.el;
  if (!el) return;
  const d = hover.duration ?? el.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  if (d - el.currentTime < 0.06 && !el.seeking || el.currentTime < hover.segStart - 0.5) {
    el.currentTime = hover.segStart;
  }
}

function onHoverEnded() {
  const el = hover?.el;
  if (!el) return;
  el.currentTime = hover.segStart;
  el.play().catch(() => {});
}

function ensurePlaying() {
  const el = hover?.el;
  if (el && el.paused) el.play().catch(() => {});
}

function drawPlayhead() {
  const el = hover?.el;
  if (!el || !hover.playhead) return;
  const d = Number.isFinite(el.duration) ? el.duration : hover.duration;
  if (!d) return;
  const pct = Math.min(100, Math.max(0, (el.currentTime / d) * 100));
  hover.playhead.style.left = pct + "%";
  hover.bar.style.width = pct + "%";
}

function cancelHover() {
  if (!hover) return;
  clearTimeout(hover.timer);
  cancelAnimationFrame(hover.raf);
  const el = hover.el;
  if (el) {
    el.pause();
    el.removeEventListener("timeupdate", onHoverTimeUpdate);
    el.removeEventListener("ended", onHoverEnded);
    el.removeAttribute("src");
    try { el.load(); } catch {}
    el.classList.remove("hover-media");
    el.remove();
  }
  const host = hover.cellEl?.querySelector(".img, .ph");
  if (host && hover.saved != null) host.innerHTML = hover.saved;
  hover = null;
}

// ── 灯箱预览 ────────────────────────────────────────────
const overlay = document.getElementById("overlay");
const ovMedia = document.getElementById("ov-media");

async function openOverlay(i) {
  if (i < 0 || i >= state.rows.length) return;
  state.ovIndex = i;
  state.zoom = 1; state.rot = 0;
  const row = state.rows[i];
  state.selectedId = row.id;
  document.getElementById("ov-restore").classList.toggle("hidden", !row.is_deleted);
  overlay.classList.remove("hidden");
  document.getElementById("ov-pos").textContent = `${i + 1} / ${state.rows.length}`;
  document.getElementById("ov-info").innerHTML =
    `<span>${escapeHtml(row.name)}</span><span>${row.ext} · ${row.width ?? "?"}×${row.height ?? "?"} · ${fmtSize(row.size)}</span>`;

  if (AUDIO.has(row.ext)) {
    ovMedia.innerHTML =
      `<div class="audio-box"><div class="big-ph" style="background:${phColor(row.ext)}">${row.ext.toUpperCase()}</div>
       <audio controls src="${originalUrl(row)}"></audio></div>`;
  } else if (VIDEO.has(row.ext)) {
    ovMedia.innerHTML = `<video controls autoplay loop src="${mediaSrc(row)}"></video>`;
  } else if (FONT.has(row.ext)) {
    ovMedia.innerHTML =
      `<div class="big-ph" style="background:#232329"><div class="font-sample" id="font-sample">鹰 Aa Bb Cc<br>字体预览 123</div></div>`;
    try {
      const face = new FontFace("pv-font", `url("${originalUrl(row)}")`);
      await face.load();
      document.fonts.add(face);
      document.getElementById("font-sample").style.fontFamily = "pv-font";
    } catch { /* 保持默认字体 */ }
  } else {
    ovMedia.innerHTML = `<img id="ov-img" src="${thumbUrl(row) ?? originalUrl(row)}">`;
    if (thumbUrl(row)) {
      const hi = new Image();
      hi.onload = () => { const el = document.getElementById("ov-img"); if (el) el.src = hi.src; };
      hi.src = originalUrl(row);
    }
  }
  applyTransform();
  scheduleRender();

  if (row.ext === "jpg" || row.ext === "jpeg") {
    api.detail(row.id).then((d) => {
      const ex = d?.exif;
      if (!ex) return;
      const cam = [ex.make, ex.model].filter(Boolean).join(" ");
      const params = [
        ex.exposureTime,
        ex.fNumber ? `f/${ex.fNumber}` : "",
        ex.iso ? `ISO${ex.iso}` : "",
        ex.focalLength ? `${ex.focalLength}mm` : "",
      ].filter(Boolean).join(" ");
      const line = [cam, params, ex.dateTimeOriginal].filter(Boolean).join(" · ");
      document.getElementById("ov-info").innerHTML =
        `<span>${escapeHtml(row.name)}</span><span>${escapeHtml(line)} · ${row.ext} · ${row.width ?? "?"}×${row.height ?? "?"} · ${fmtSize(row.size)}</span>`;
    }).catch(() => {});
  }
}

function applyTransform() {
  const el = ovMedia.querySelector("img");
  if (el) el.style.transform = `scale(${state.zoom}) rotate(${state.rot}deg)`;
}

function closeOverlay() {
  overlay.classList.add("hidden");
  ovMedia.querySelectorAll("video, audio").forEach((m) => m.pause?.());
  state.ovIndex = -1;
  state.selectedId = null;
  scheduleRender();
}

document.getElementById("ov-close").addEventListener("click", closeOverlay);
document.getElementById("ov-prev").addEventListener("click", () => openOverlay(state.ovIndex - 1));
document.getElementById("ov-next").addEventListener("click", () => openOverlay(state.ovIndex + 1));
document.getElementById("ov-zoom-in").addEventListener("click", () => { state.zoom = Math.min(8, state.zoom * 1.25); applyTransform(); });
document.getElementById("ov-zoom-out").addEventListener("click", () => { state.zoom = Math.max(.2, state.zoom / 1.25); applyTransform(); });
document.getElementById("ov-rotate").addEventListener("click", () => { state.rot = (state.rot + 90) % 360; applyTransform(); });
document.getElementById("ov-fit").addEventListener("click", () => { state.zoom = 1; state.rot = 0; applyTransform(); });
ovMedia.addEventListener("wheel", (e) => {
  if (!ovMedia.querySelector("img")) return;
  e.preventDefault();
  state.zoom = Math.min(8, Math.max(.2, state.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
  applyTransform();
}, { passive: false });
document.getElementById("ov-open").addEventListener("click", () => {
  if (state.ovIndex >= 0) api.openOriginal(state.rows[state.ovIndex].id);
});
document.getElementById("ov-reveal").addEventListener("click", () => {
  if (state.ovIndex >= 0) api.showInFinder(state.rows[state.ovIndex].id);
});
document.getElementById("ov-restore").addEventListener("click", async () => {
  if (state.ovIndex < 0) return;
  const r = await api.restore(state.rows[state.ovIndex].id);
  document.getElementById("count").textContent = `${r.ok ? "✓" : "✕"} ${r.message}`;
  if (r.ok) {
    closeOverlay();
    refresh();
  }
});
window.addEventListener("keydown", (e) => {
  if (overlay.classList.contains("hidden")) return;
  if (e.key === "Escape") closeOverlay();
  else if (e.key === "ArrowLeft") openOverlay(state.ovIndex - 1);
  else if (e.key === "ArrowRight") openOverlay(state.ovIndex + 1);
});

grid.addEventListener("click", (e) => {
  const cell = e.target.closest(".cell");
  if (!cell) return;
  const row = state.rows[+cell.dataset.i];
  if (row) selectItem(row.id);
});
grid.addEventListener("dblclick", (e) => {
  const cell = e.target.closest(".cell");
  if (!cell) return;
  openOverlay(+cell.dataset.i);
});

// ── 右侧元信息面板 + 标签 ───────────────────────────────
const metaPanel = document.getElementById("meta-panel");
let metaPanelOpen = localStorage.getItem("brollary.metaPanel") !== "0";

function setPanelVisible(on) {
  metaPanelOpen = on;
  metaPanel.classList.toggle("hidden", !on);
  document.getElementById("meta-toggle").classList.toggle("on", on);
  localStorage.setItem("brollary.metaPanel", on ? "1" : "0");
}
document.getElementById("meta-toggle").addEventListener("click", () => setPanelVisible(!metaPanelOpen));
document.getElementById("mp-close").addEventListener("click", () => setPanelVisible(false));
setPanelVisible(metaPanelOpen);

async function selectItem(id) {
  state.selectedId = id;
  state.metaId = id;
  scheduleRender();
  if (!metaPanelOpen) return;
  const d = await api.detail(id);
  if (!d || state.metaId !== id) return;
  renderMeta(d);
}

function renderMeta(d) {
  const { item, thumbPath, originalPath } = d;
  metaPanel.dataset.id = item.id;
  document.getElementById("mp-thumb").innerHTML = thumbPath
    ? `<img src="${fileUrl(thumbPath)}">`
    : `<div class="ph" style="width:120px;height:120px;display:flex;align-items:center;justify-content:center;background:${phColor(item.ext)};font-size:26px">${item.ext.toUpperCase()}</div>`;
  const rows = [
    ["名称", item.name],
    ["类型", item.ext],
    ["大小", fmtSize(item.size)],
    ["尺寸", item.width ? `${item.width}×${item.height}` : null],
    ["时长", item.duration ? item.duration + "s" : null],
    ["来源", item.url || null],
    ["注释", item.annotation || null],
    ["创建", new Date(item.btime).toLocaleString()],
    ["ID", item.id],
  ].filter(([, v]) => v != null && v !== "");
  document.getElementById("mp-fields").innerHTML = rows
    .map(([k, v]) => `<div class="mp-row"><span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span></div>`).join("");
  renderTagChips(item.tags ?? []);
  document.getElementById("mp-open").onclick = () => originalPath && api.openOriginal(item.id);
  document.getElementById("mp-reveal").onclick = () => originalPath && api.showInFinder(item.id);
}

function currentPanelTags() {
  return [...document.querySelectorAll("#mp-tags .tag-chip")].map((c) => c.firstChild.textContent);
}

function renderTagChips(tags) {
  const host = document.getElementById("mp-tags");
  host.innerHTML = tags.length
    ? tags.map((t) =>
        `<span class="tag-chip">${escapeHtml(t)}<button data-t="${escapeHtml(t)}" title="移除">×</button></span>`).join("")
    : `<span style="color:var(--fg-dim);font-size:11px">暂无标签</span>`;
  host.querySelectorAll(".tag-chip button").forEach((btn) =>
    btn.addEventListener("click", () => {
      saveTags(currentPanelTags().filter((t) => t !== btn.dataset.t));
    }));
}

async function saveTags(tags) {
  if (!state.metaId) return;
  const r = await api.setTags(state.metaId, tags);
  if (!r.ok) { showError(r.message ?? "保存失败"); return; }
  renderTagChips(r.tags);
  buildNav();
  if (state.tag && (state.view === "all" || state.view === "trash") && !r.tags.includes(state.tag)) {
    state.rows = state.rows.filter((row) => row.id !== state.metaId);
    computeLayout();
    render();
  }
}

const tagInput = document.getElementById("mp-tag-input");
tagInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== ",") return;
  e.preventDefault();
  const added = tagInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  if (!added.length) return;
  const cur = currentPanelTags();
  tagInput.value = "";
  saveTags([...cur, ...added]);
});
document.getElementById("mp-open").addEventListener("click", () => {
  if (state.metaId) api.openOriginal(state.metaId);
});
document.getElementById("mp-reveal").addEventListener("click", () => {
  if (state.metaId) api.showInFinder(state.metaId);
});

// ── 重复文件视图 ────────────────────────────────────────
const dupview = document.getElementById("dupview");
let currentDupGroups = null;

async function refreshDup() {
  document.getElementById("count").textContent = "扫描重复文件…";
  const res = await api.dedupScan();
  if (res.error) { showError(res.error); return; }
  currentDupGroups = res.groups;
  state.rows = res.groups.flatMap((g) => g.items);
  document.getElementById("count").textContent = res.groups.length
    ? `${res.groups.length} 组重复，浪费 ${fmtSize(res.wastedBytes)}`
    : "没有发现重复文件";
  showDupView(true);
  let html = "";
  let flat = 0;
  res.groups.forEach((g, gi) => {
    html += `<div class="dup-head"><span>内容相同 ×${g.items.length} · ${fmtSize(g.items[0].size)}/份 · 可省 ${fmtSize(g.items[0].size * (g.items.length - 1))}</span>
      <button class="dup-keep" data-g="${gi}" title="其余副本移入回收站（可恢复）">保留 1 份，其余入回收站</button></div>`;
    html += `<div class="dup-grid">${g.items.map((it) => {
      const i = flat++;
      const url = thumbUrl(it);
      return `<div class="dup-cell" data-i="${i}">
        ${url ? `<img loading="lazy" src="${url}">` : `<div class="ph" style="height:140px;display:flex;align-items:center;justify-content:center;background:${phColor(it.ext)}">${it.ext.toUpperCase()}</div>`}
        <div class="label"><span class="ext-tag">${it.ext}</span>${escapeHtml(it.name)}</div>
      </div>`;
    }).join("")}</div>`;
  });
  dupview.innerHTML = html || `<div class="dup-head">没有发现重复文件（首次扫描可能较慢）</div>`;
  attachImgFallback(dupview);
}

function showDupView(on) {
  dupview.classList.toggle("hidden", !on);
  sizer.classList.toggle("hidden", on);
}

dupview.addEventListener("click", async (e) => {
  const keep = e.target.closest(".dup-keep");
  if (keep) {
    const g = currentDupGroups?.[+keep.dataset.g];
    if (!g) return;
    keep.disabled = true;
    keep.textContent = "处理中…";
    const r = await api.dedupTrash(g.items.slice(1).map((it) => it.id));
    document.getElementById("count").textContent = r.ok
      ? `✓ 已移入回收站 ${r.trashed} 份（可在回收站视图恢复）`
      : `⚠ 部分失败：${(r.failed ?? []).join("；")}`;
    refreshDup();
    return;
  }
  const cell = e.target.closest(".dup-cell");
  if (cell) {
    const row = state.rows[+cell.dataset.i];
    if (row) selectItem(row.id);
  }
});
dupview.addEventListener("dblclick", (e) => {
  const cell = e.target.closest(".dup-cell");
  if (cell) openOverlay(+cell.dataset.i);
});

// ── 刷新（按视图分发） ───────────────────────────────────
async function refresh(opts = {}) {
  const preserveScroll = opts.preserveScroll === true;
  try {
    if (state.view === "dup") {
      await refreshDup();
      return;
    }
    if (state.view === "smart") {
      const res = await api.listSmart(state.smartId);
      state.rows = res.error ? [] : res.rows;
      document.getElementById("count").textContent = res.error
        ? `⚠ ${res.error}` : `${state.rows.length} 条 · 智能文件夹「${state.smartName}」`;
    } else if (state.view === "color") {
      state.rows = await api.colors({ ...state.color, deleted: false });
      document.getElementById("count").textContent =
        `${state.rows.length} 条 · 颜色相似`;
    } else {
      const res = await api.list({
        query: state.query, ext: state.ext, deleted: state.view === "trash", tag: state.tag,
      });
      state.rows = res.rows;
      state.libraryPath = state.libraryPath || res.libraryPath;
      document.getElementById("count").textContent =
        `${state.rows.length} 条${state.view === "trash" ? "（回收站）" : ""}`;
    }
    showDupView(false);
    if (!preserveScroll) scroller.scrollTop = 0;
    computeLayout();
    render();
  } catch (err) {
    showError(`加载失败：${err?.message ?? err}`);
  }
}

// ── 侧栏 / 条件栏 / 筛选 ─────────────────────────────────
const SWATCHES = [
  "#e5484d", "#ff8d3a", "#ffc53d", "#46a758", "#00a2c7", "#3e63dd",
  "#6e56cf", "#c95dd8", "#e5658a", "#8a6145", "#000000", "#8d8d93", "#ffffff",
];
const hexToRgb = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});
const rgbToHex = ({ r, g, b }) =>
  "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

async function buildNav() {
  const s = await api.stats();
  const views = [
    { v: "all", label: "全部素材", n: s.items - s.deleted },
    { v: "trash", label: "回收站", n: s.deleted },
  ];
  const navViews = document.getElementById("nav-views");
  navViews.innerHTML = views.map((v) =>
    `<div class="nav-item${state.view === v.v ? " on" : ""}" data-v="${v.v}"><span>${v.label}</span><span class="n">${v.n}</span></div>`).join("");
  navViews.querySelectorAll(".nav-item").forEach((el) =>
    el.addEventListener("click", () => {
      setView(el.dataset.v);
      buildNav();
      refresh();
    }));

  document.getElementById("nav-smart").innerHTML = s.smartFolders.map((sf) =>
    `<div class="nav-item${state.view === "smart" && state.smartId === sf.id ? " on" : ""}" data-sf="${sf.id}"><span>${escapeHtml(sf.name)}</span><span class="n">${sf.matchCount >= 0 ? sf.matchCount : "?"}</span></div>`).join("");
  document.querySelectorAll("#nav-smart .nav-item").forEach((el) =>
    el.addEventListener("click", () => {
      const sf = s.smartFolders.find((x) => x.id === el.dataset.sf);
      setView("smart", { smartId: sf.id, smartName: sf.name });
      buildNav();
      refresh();
    }));

  const all = await api.allTags();
  const navTags = document.getElementById("nav-tags");
  navTags.innerHTML = all.length
    ? all.map((t) =>
        `<div class="nav-item${(state.view === "all" || state.view === "trash") && state.tag === t.tag ? " on" : ""}" data-tag="${escapeHtml(t.tag)}"><span>${escapeHtml(t.tag)}</span><span class="n">${t.n}</span></div>`).join("")
    : `<div class="nav-hint">暂无标签</div>`;
  navTags.querySelectorAll(".nav-item").forEach((el) =>
    el.addEventListener("click", () => {
      const t = el.dataset.tag;
      const keep = state.tag === t ? null : t;
      setView("all");
      state.tag = keep;
      buildNav();
      refresh();
    }));

  // 类型筛选条（仅列表模式有意义）
  const bar = document.getElementById("ext-bar");
  bar.classList.toggle("hidden", !(state.view === "all" || state.view === "trash"));
  const chips = [{ ext: null, n: s.items, label: "全部类型" },
    ...s.byExt.map((e) => ({ ext: e.ext, n: e.n, label: e.ext }))];
  bar.innerHTML = chips.map((c) =>
    `<span class="chip${c.ext === state.ext ? " on" : ""}" data-ext="${c.ext ?? ""}">${c.label} ×${c.n}</span>`).join("");
  bar.querySelectorAll(".chip").forEach((el) =>
    el.addEventListener("click", () => {
      if (state.view !== "all" && state.view !== "trash") return;
      state.ext = el.dataset.ext || null;
      buildNav();
      refresh();
    }));
}

// ── 颜色条 ──────────────────────────────────────────────
const colorBar = document.getElementById("color-bar");

function buildColorBar() {
  colorBar.innerHTML = SWATCHES.map((hex) =>
    `<span class="swatch${state.view === "color" && state.color && hex === rgbToHex(state.color) ? " on" : ""}" data-hex="${hex}" style="background:${hex}" title="${hex}"></span>`).join("")
    + `<input type="color" id="color-custom" value="#3e63dd" title="自定义颜色">
       <span class="chip" id="color-close">收起</span>`;
  colorBar.querySelectorAll(".swatch").forEach((el) =>
    el.addEventListener("click", () => {
      setView("color", { color: hexToRgb(el.dataset.hex) });
      buildNav();
      refresh();
    }));
  colorBar.querySelector("#color-custom").addEventListener("input", (e) => {
    setView("color", { color: hexToRgb(e.target.value) });
    buildColorBar();
    refresh();
  });
  colorBar.querySelector("#color-close").addEventListener("click", () => {
    colorBar.classList.add("hidden");
    if (state.view === "color") { setView("all"); buildNav(); refresh(); }
  });
}

document.getElementById("nav-color").addEventListener("click", () => {
  colorBar.classList.toggle("hidden");
});
document.getElementById("nav-dup").addEventListener("click", () => {
  setView("dup");
  buildNav();
  refresh();
});

let searchTimer;
searchEl.addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (state.view !== "all" && state.view !== "trash") setView("all");
    state.query = e.target.value;
    refresh();
  }, 200);
});
document.getElementById("trash").addEventListener("change", (e) => {
  setView(e.target.checked ? "trash" : "all");
  buildNav();
  refresh();
});

// ── 库生命周期 ────────────────────────────────────────
state.libraries = [];
state.activeId = null;

async function reloadLibraries() {
  const res = await api.libList();
  state.libraries = res.libraries;
  state.activeId = res.activeId;
  state.mediaPipeline = res.mediaPipeline;
  renderLibSelect();
}

/** 库切换/结构变化后的全量重载 */
async function fullReload() {
  await reloadLibraries();
  buildNav();
  refresh();
}

function renderLibSelect() {
  const sel = document.getElementById("lib-select");
  sel.innerHTML = state.libraries.length
    ? state.libraries.map((l) =>
        `<option value="${l.id}"${l.id === state.activeId ? " selected" : ""}>${escapeHtml(l.name)}</option>`).join("")
    : `<option>未打开库</option>`;
}

async function switchLibrary(id) {
  const r = await api.libOpen(id);
  if (!r.ok) { showError(r.message); return; }
  await reloadLibraries();
  buildNav();
  refresh();
}

// 库管理弹窗
const libModal = document.getElementById("lib-modal");
const libmStatus = document.getElementById("libm-status");
let libmDir = null;

function openLibModal() {
  libModal.classList.remove("hidden");
  document.getElementById("libm-form").classList.add("hidden");
  libmStatus.textContent = state.mediaPipeline ? "" : "⚠ 未检测到 ffmpeg，视频探针/缩略图/色板不可用";
  renderLibModalList();
}
function renderLibModalList() {
  const host = document.getElementById("lib-list");
  host.innerHTML = state.libraries.length
    ? state.libraries.map((l) => {
        const active = l.id === state.activeId;
        return `<div class="lib-row${active ? " active" : ""}">
          <div class="info">
            <div class="name">${escapeHtml(l.name)}${active ? '<span class="badge">当前</span>' : ""}</div>
            <div class="path" title="${escapeHtml(l.path)}">${escapeHtml(l.path)}</div>
          </div>
          ${active ? "" : `<button data-open="${l.id}">打开</button>`}
          <button data-remove="${l.id}" title="仅从列表移除，磁盘文件保留">移除</button>
        </div>`;
      }).join("")
    : `<div class="nav-hint" style="padding:12px 4px">还没有库——新建一个空库开始，或添加现有 .library</div>`;
  host.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      await switchLibrary(b.dataset.open);
      renderLibModalList();
    }));
  host.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("从列表移除该库？磁盘上的库文件不会被删除。")) return;
      await api.libRemove(b.dataset.remove);
      await reloadLibraries();
      renderLibModalList();
    }));
}
document.getElementById("lib-manage").addEventListener("click", openLibModal);
document.getElementById("libm-close").addEventListener("click", () => libModal.classList.add("hidden"));

document.getElementById("lib-select").addEventListener("change", (e) => switchLibrary(e.target.value));

document.getElementById("libm-new").addEventListener("click", () => {
  document.getElementById("libm-form").classList.remove("hidden");
  libmDir = null;
  document.getElementById("libm-name").value = "";
  document.getElementById("libm-dir-label").textContent = "未选择位置";
  document.getElementById("libm-create").disabled = true;
});
document.getElementById("libm-pickdir").addEventListener("click", async () => {
  const dir = await api.pickDirectory();
  if (dir) {
    libmDir = dir;
    document.getElementById("libm-dir-label").textContent = dir;
    document.getElementById("libm-dir-label").title = dir;
    document.getElementById("libm-create").disabled = false;
  }
});
document.getElementById("libm-create").addEventListener("click", async () => {
  const name = document.getElementById("libm-name").value.trim();
  if (!name || !libmDir) { libmStatus.textContent = "⚠ 请填写名称并选择位置"; return; }
  libmStatus.textContent = "创建中…";
  const r = await api.libCreate(name, libmDir);
  if (!r.ok) { libmStatus.textContent = `⚠ ${r.message}`; return; }
  libmStatus.textContent = "✓ 已创建并打开";
  await fullReload();
  renderLibModalList();
});
document.getElementById("libm-add").addEventListener("click", async () => {
  const path = await api.pickLibrary();
  if (!path) return;
  libmStatus.textContent = "导入索引中（大库可能需要几秒）…";
  const r = await api.libAddExisting(path);
  if (!r.ok) { libmStatus.textContent = `⚠ ${r.message}`; return; }
  libmStatus.textContent = `✓ 已添加（${r.itemCount ?? "?"} 个条目）`;
  await fullReload();
  renderLibModalList();
});
document.getElementById("libm-import-files").addEventListener("click", async () => {
  const paths = await api.pickFiles();
  if (!paths.length) return;
  libmStatus.textContent = "导入中…";
  const r = await api.importFiles(paths);
  if (!r.ok && !r.imported) { libmStatus.textContent = `⚠ ${r.message ?? "导入失败"}`; return; }
  libmStatus.textContent = r.failed?.length
    ? `✓ ${r.imported}/${r.total} 个成功，失败：${r.failed.join("；")}`
    : `✓ 已导入 ${r.imported} 个文件`;
  buildNav();
  refresh();
});

document.getElementById("libm-import").addEventListener("click", async () => {
  const dir = await api.pickDirectory();
  if (!dir) return;
  libmStatus.textContent = "导入中…";
  api.onImportProgress((p) => {
    libmStatus.textContent = `导入中 ${p.done}/${p.total}`;
  });
  const r = await api.importFolder(dir);
  if (!r.ok) { libmStatus.textContent = `⚠ ${r.message}`; return; }
  libmStatus.textContent = `✓ 导入完成：${r.imported}/${r.total} 个文件`;
  buildNav();
  refresh();
});

// ffmpeg 管线完成一个条目 → 定向重建该卡片 + 保留滚动位置的静默刷新
let mediaRefreshTimer;
const mediaPending = new Set();
api.onMediaUpdated((id) => {
  mediaPending.add(id);
  clearTimeout(mediaRefreshTimer);
  mediaRefreshTimer = setTimeout(async () => {
    for (const mid of mediaPending) {
      const el = rendered.get(mid);
      if (el) { el.remove(); rendered.delete(mid); } // 强制重建（拿到新缩略图/代理）
    }
    mediaPending.clear();
    await refresh({ preserveScroll: true });
  }, 300);
});
api.onLibraryChanged(() => reloadLibraries());

// ── 主题 ────────────────────────────────────────────────
const themeBtn = document.getElementById("theme-toggle");
function applyTheme() {
  const light = localStorage.getItem("brollary.theme") === "light";
  document.body.classList.toggle("light", light);
  themeBtn.textContent = light ? "🌙 暗色" : "☀️ 亮色";
}
themeBtn.addEventListener("click", () => {
  localStorage.setItem("brollary.theme",
    localStorage.getItem("brollary.theme") === "light" ? "dark" : "light");
  applyTheme();
});
applyTheme();

buildColorBar();
reloadLibraries().then(() => {
  buildNav();
  refresh();
  if (!state.libraries.length) openLibModal(); // 首次使用：引导建库
});
