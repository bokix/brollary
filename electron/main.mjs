// Brollary（空镜库）— Electron 主进程。
// 多库管理：配置注册表（userData/config.json）+ 每库独立索引（<库>/brollary.db，可重建缓存）。
import { app, BrowserWindow, ipcMain, shell, Menu, dialog, nativeImage } from "electron";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import {
  openAndHeal,
  stats,
  listItems,
  listByIds,
  getItem,
  smartFolderIds,
  searchByColor,
  restoreItem,
  trashItem,
  setItemTags,
  allTags,
  importLibrary,
} from "../dist/indexer.js";
import { scanDuplicates } from "../dist/dedup.js";
import { startApiServer } from "../dist/api.js";
import { parseExifJpeg } from "../dist/probe.js";
import { loadConfig, saveConfig, libraryDbPath } from "../dist/config.js";
import { createLibrary, validateLibrary } from "../dist/libraries.js";
import { addFromPath, addFromUrl, genId } from "../dist/ingest.js";
import { enqueueMedia, setMediaUpdateListener, mediaPipelineAvailable, codecNeedsProxy } from "../dist/media.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// 悬停播放需要带声 autoplay；Electron 放开策略（仅本应用生效）
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setName("Brollary");
app.setAboutPanelOptions({
  applicationName: "Brollary",
  applicationVersion: "0.1.1",
  credits: "空镜库 · 本地素材管理",
});

// 应用菜单（macOS 菜单栏第一项标题来自壳的 CFBundleName，见 scripts/brand-dev-shell.sh）
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: "Brollary", submenu: [
    { role: "about", label: "关于 Brollary" },
    { type: "separator" },
    { role: "hide", label: "隐藏 Brollary" },
    { role: "hideOthers", label: "隐藏其他" },
    { role: "unhide", label: "全部显示" },
    { type: "separator" },
    { role: "quit", label: "退出 Brollary" },
  ]},
  { label: "编辑", submenu: [
    { role: "undo", label: "撤销" }, { role: "redo", label: "重做" },
    { type: "separator" },
    { role: "cut", label: "剪切" }, { role: "copy", label: "拷贝" },
    { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" },
  ]},
  { label: "视图", submenu: [
    { role: "reload" }, { role: "toggleDevTools" },
    { type: "separator" },
    { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen", label: "进入全屏" },
  ]},
  { label: "窗口", submenu: [
    { role: "minimize", label: "最小化" }, { role: "zoom" }, { role: "close", label: "关闭" },
  ]},
]));

const MEDIA_KIND = {
  video: new Set(["mov", "mp4", "wmv", "m4v", "webm", "avi", "mkv"]),
  audio: new Set(["wav", "mp3", "aif", "aiff", "flac", "m4a"]),
  image: new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "svg"]),
};

let db = null;                 // 当前活动库的索引
let activeLibrary = null;      // 当前活动库的注册表条目
let config = null;
let win = null;
let stashApiPort = null;
let dedupScanInFlight = null;

function userDataDir() {
  return app.getPath("userData");
}

function saveCfg() {
  saveConfig(userDataDir(), config);
}

/** 打开某个已注册库（切换活动库）；空索引自动全量导入 */
function openLibrary(entry) {
  if (db) { try { db.close(); } catch {} db = null; }
  const p = libraryDbPath(entry.path);
  db = openAndHeal(p);
  const storedPath = db.prepare("SELECT value FROM meta WHERE key='libraryPath'").get()?.value;
  if (storedPath !== entry.path) {
    importLibrary(db, entry.path);
  } else if (db.prepare("SELECT count(*) n FROM items").get().n === 0) {
    importLibrary(db, entry.path);
  }
  entry.lastOpened = Date.now();
  activeLibrary = entry;
  saveCfg();
  requeuePendingMedia(entry.path);
}

/** 补跑媒体管线：视频缺编码信息、音/图缺缩略图的重新入队 */
function requeuePendingMedia(libraryPath) {
  if (!db || !mediaPipelineAvailable()) return;
  try {
    const rows = db.prepare("SELECT id, raw FROM items WHERE is_deleted = 0").all();
    const pending = [];
    for (const { id, raw } of rows) {
      const item = JSON.parse(raw);
      const ext = String(item.ext ?? "").toLowerCase();
      const kind = MEDIA_KIND.video.has(ext) ? "video"
        : MEDIA_KIND.audio.has(ext) ? "audio"
        : MEDIA_KIND.image.has(ext) ? "image" : null;
      if (!kind) continue;
      const itemDir = join(libraryPath, "images", `${id}.info`);
      const thumb = join(itemDir, `${item.name}_thumbnail.png`);
      if (kind === "video") {
        if (item.probeFailed) continue; // 确认无法读取，不再尝试
        if (item.codec && item.preview) continue; // 代理已就绪
        if (item.codec && !codecNeedsProxy(item.codec)) continue; // 可直接播放，无需代理
      } else if (existsSync(thumb)) {
        continue; // 音/图已有缩略图
      }
      const path = join(itemDir, `${item.name}.${ext}`);
      if (!existsSync(path)) continue;
      pending.push({ id, path, ext, kind });
    }
    // 便宜的先做（波形/图片缩略图），昂贵的代理转码垫后，避免队头阻塞
    pending.sort((a, b) => (a.kind === "video" ? 1 : 0) - (b.kind === "video" ? 1 : 0));
    for (const job of pending) enqueueMedia(db, job);
  } catch (err) {
    console.error("[media] 补跑失败:", err);
  }
}

/** 首次运行迁移：老版本把库路径存在根目录 stash.db 的 meta 里 */
function migrateLegacy() {
  if (config.libraries.length > 0) return;
  const legacy = join(ROOT, "stash.db");
  if (!existsSync(legacy)) return;
  try {
    const old = openAndHeal(legacy);
    const p = old.prepare("SELECT value FROM meta WHERE key='libraryPath'").get()?.value;
    if (p && existsSync(p)) {
      config.libraries.push({
        id: genId(), name: basename(p).replace(/\.library$/, ""),
        path: p, createdAt: Date.now(), lastOpened: 0,
      });
      config.activeLibraryId = config.libraries[0].id;
      saveCfg();
      console.log("[config] 已从旧索引迁移库:", p);
    }
  } catch (err) {
    console.error("[config] 迁移失败:", err);
  }
}

function locateFiles(itemDir) {
  let thumbPath = null;
  let originalPath = null;
  if (existsSync(itemDir)) {
    for (const f of readdirSync(itemDir)) {
      if (f === "metadata.json") continue;
      if (/_thumbnail\.(png|jpe?g|webp|gif)$/i.test(f)) thumbPath = join(itemDir, f);
      else originalPath ??= join(itemDir, f);
    }
  }
  return { thumbPath, originalPath };
}

function requireDb() {
  if (!db) throw new Error("没有打开的库");
  return db;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    title: "Brollary · 空镜库",
    icon: join(ROOT, "assets", "icon_512.png"),
    backgroundColor: "#141417",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  return win;
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    const dockIcon = nativeImage.createFromPath(join(ROOT, "assets", "icon_512.png"));
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
  }

  config = loadConfig(userDataDir());
  migrateLegacy();

  // 打开上次活动库（或第一个）
  const active =
    config.libraries.find((l) => l.id === config.activeLibraryId) ?? config.libraries[0] ?? null;
  if (active) openLibrary(active);

  registerIpc();

  const apiPort = Number(process.env.STASH_API_PORT ?? 41596); // 41595 是同类常见端口，避开同机冲突
  try {
    const api = await startApiServer({
      port: apiPort,
      getContext: () => ({ db, libraryPath: activeLibrary?.path }),
      onIngested: (id) => activeLibrary && enqueueForItem(id, activeLibrary.path),
      onLog: (m) => console.log(`[api] ${m}`),
    });
    stashApiPort = api.port;
  } catch (err) {
    console.error("[api] 启动失败:", err);
  }

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

// ── IPC ───────────────────────────────────────────────
function registerIpc() {
  // ── 库生命周期 ──
  ipcMain.handle("lib:list", () => ({
    libraries: config.libraries,
    activeId: activeLibrary?.id ?? null,
    mediaPipeline: mediaPipelineAvailable(),
  }));

  ipcMain.handle("lib:create", (_e, { name, dir }) => {
    const r = createLibrary(dir, name);
    if (!r.ok) return r;
    const entry = { id: genId(), name: name.trim() || basename(r.path), path: r.path, createdAt: Date.now(), lastOpened: Date.now() };
    config.libraries.push(entry);
    openLibrary(entry);
    broadcast("library:changed", null);
    return { ok: true, id: entry.id };
  });

  ipcMain.handle("lib:addExisting", (_e, { path, name }) => {
    const v = validateLibrary(path);
    if (!v.ok) return { ok: false, message: v.message };
    if (config.libraries.some((l) => l.path === path)) return { ok: false, message: "该库已在列表中" };
    const entry = {
      id: genId(), name: (name ?? "").trim() || basename(path).replace(/\.library$/, ""),
      path, createdAt: Date.now(), lastOpened: Date.now(),
    };
    config.libraries.push(entry);
    openLibrary(entry);
    broadcast("library:changed", null);
    return { ok: true, id: entry.id, itemCount: v.itemCount };
  });

  ipcMain.handle("lib:open", (_e, { id }) => {
    const entry = config.libraries.find((l) => l.id === id);
    if (!entry) return { ok: false, message: "找不到该库" };
    openLibrary(entry);
    return { ok: true };
  });

  /** 仅从列表移除；磁盘文件原样保留 */
  ipcMain.handle("lib:remove", (_e, { id }) => {
    const i = config.libraries.findIndex((l) => l.id === id);
    if (i < 0) return { ok: false, message: "找不到该库" };
    config.libraries.splice(i, 1);
    if (activeLibrary?.id === id) {
      db = null;
      activeLibrary = null;
      config.activeLibraryId = null;
    } else {
      config.activeLibraryId = activeLibrary?.id ?? null;
    }
    saveCfg();
    broadcast("library:changed", null);
    return { ok: true };
  });

  ipcMain.handle("lib:pickDirectory", async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("lib:pickFiles", async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
    });
    return r.canceled ? [] : r.filePaths;
  });

  /** 导入选中的若干文件（复制进当前库，不动源文件） */
  ipcMain.handle("lib:importFiles", async (_e, { paths }) => {
    const libraryPath = activeLibrary?.path;
    if (!libraryPath || !db) return { ok: false, message: "请先打开一个库" };
    if (!Array.isArray(paths) || paths.length === 0) return { ok: false, message: "没有选择文件" };
    let okCount = 0;
    const failed = [];
    for (const f of paths) {
      const r = addFromPath(requireDb(), libraryPath, String(f), { tags: ["导入"] });
      if (r.ok) {
        okCount++;
        enqueueForItem(r.id, libraryPath);
      } else {
        failed.push(`${f}: ${r.message}`);
      }
    }
    return { ok: failed.length === 0, imported: okCount, total: paths.length, failed };
  });

  ipcMain.handle("lib:pickLibrary", async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      filters: [{ name: "Brollary 素材库", extensions: ["library"] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  /** 导入文件夹：递归扫媒体文件 → 逐个采集入库（复制，不动源文件），带进度事件 */
  ipcMain.handle("lib:importFolder", async (_e, { dir }) => {
    const libraryPath = activeLibrary?.path;
    if (!libraryPath || !db) return { ok: false, message: "请先打开一个库" };
    if (!existsSync(dir)) return { ok: false, message: "目录不存在" };
    const files = [];
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        if (f.startsWith(".")) continue;
        const p = join(d, f);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) {
          const ext = f.split(".").pop().toLowerCase();
          if (MEDIA_KIND.video.has(ext) || MEDIA_KIND.audio.has(ext) || MEDIA_KIND.image.has(ext)
              || ["ttf", "otf", "woff", "woff2", "pdf", "cube", "zip"].includes(ext)) files.push(p);
        }
      }
    };
    walk(dir);
    let done = 0;
    let okCount = 0;
    for (const f of files) {
      const r = addFromPath(db, libraryPath, f, { tags: ["导入"] });
      if (r.ok) {
        okCount++;
        enqueueForItem(r.id, libraryPath);
      }
      done++;
      if (done % 5 === 0 || done === files.length) broadcast("import:progress", { done, total: files.length });
    }
    broadcast("import:progress", { done: files.length, total: files.length });
    return { ok: true, total: files.length, imported: okCount };
  });

  // ── 查询类 ──
  ipcMain.handle("api:list", (_e, filter) => ({
    libraryPath: activeLibrary?.path ?? "",
    libraryName: activeLibrary?.name ?? "",
    rows: listItems(requireDb(), filter ?? {}),
  }));
  ipcMain.handle("api:stats", () => stats(requireDb()));
  ipcMain.handle("api:listSmart", (_e, id) => {
    const row = requireDb().prepare("SELECT name, conditions_json FROM smart_folders WHERE id = ?").get(id);
    if (!row) return { error: "找不到智能文件夹" };
    const ids = smartFolderIds(requireDb(), JSON.parse(row.conditions_json));
    if (ids === null) return { error: "含未支持的规则（如尺寸/大小比较）" };
    return { name: row.name, rows: listByIds(requireDb(), [...ids], false) };
  });
  ipcMain.handle("api:detail", (_e, id) => {
    const item = getItem(requireDb(), id);
    if (!item) return null;
    const libraryPath = activeLibrary?.path ?? "";
    const itemDir = join(libraryPath, "images", `${id}.info`);
    const { thumbPath, originalPath } = locateFiles(itemDir);
    let exif;
    if (item.ext === "jpg" || item.ext === "jpeg") {
      if (originalPath && existsSync(originalPath)) {
        const head = readFileSync(originalPath).subarray(0, 512 * 1024);
        const e = parseExifJpeg(head);
        if (Object.keys(e).length) exif = e;
      }
    }
    return { item, itemDir, thumbPath, originalPath, exif };
  });
  ipcMain.handle("api:openOriginal", (_e, id) => {
    const d = locateFiles(join(activeLibrary?.path ?? "", "images", `${id}.info`));
    return d.originalPath ? shell.openPath(d.originalPath) : "找不到原始文件";
  });
  ipcMain.handle("api:showInFinder", (_e, id) => {
    const d = locateFiles(join(activeLibrary?.path ?? "", "images", `${id}.info`));
    if (d.originalPath) shell.showItemInFolder(d.originalPath);
  });
  ipcMain.handle("api:restore", (_e, id) => restoreItem(requireDb(), id));
  ipcMain.handle("api:setTags", (_e, { id, tags }) => setItemTags(requireDb(), id, tags ?? []));
  ipcMain.handle("api:allTags", () => allTags(requireDb()));
  ipcMain.handle("api:colors", (_e, { r, g, b, deleted }) =>
    searchByColor(requireDb(), { r, g, b }, Boolean(deleted)));
  ipcMain.handle("api:dedupScan", async (e) => {
    if (!activeLibrary) return { error: "请先打开一个库" };
    const scanning = dedupScanInFlight ?? scanDuplicates(requireDb(), activeLibrary.path, (done, total) =>
      e.sender.send("dedup:progress", { done, total }));
    dedupScanInFlight = scanning;
    try {
      return await scanning;
    } finally {
      dedupScanInFlight = null;
    }
  });

}

// 采集入队：按扩展名分类交给 ffmpeg 管线
function enqueueForItem(id, libraryPath) {
  const row = requireDb().prepare("SELECT raw FROM items WHERE id = ?").get(id);
  if (!row) return;
  const item = JSON.parse(row.raw);
  const path = join(libraryPath, "images", `${id}.info`, `${item.name}.${item.ext}`);
  if (!existsSync(path)) return;
  const kind = MEDIA_KIND.video.has(item.ext) ? "video"
    : MEDIA_KIND.audio.has(item.ext) ? "audio"
    : MEDIA_KIND.image.has(item.ext) ? "image" : null;
  if (!kind) return;
  enqueueMedia(requireDb(), { id, path, ext: item.ext, kind });
}

setMediaUpdateListener((id) => broadcast("media:updated", id));
