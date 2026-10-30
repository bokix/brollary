// SQLite 索引层：可随时删除重建的缓存。权威数据 = .library 里的 JSON + 原始文件。
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ImportStats,
  ItemMetadata,
  ItemRow,
  LibraryMeta,
  SmartFolder,
} from "./types.ts";

export type { ItemRow };

import {
  flattenFolders,
  flattenSmartFolders,
  readLibraryMeta,
  resolveLibrary,
  scanItems,
} from "./library.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT
);
CREATE TABLE IF NOT EXISTS smart_folders(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  conditions_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration REAL,
  btime INTEGER,
  mtime INTEGER,
  annotation TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  folders_json TEXT NOT NULL DEFAULT '[]',
  meta_mtime INTEGER NOT NULL DEFAULT 0,
  preview INTEGER NOT NULL DEFAULT 0,
  codec TEXT,
  raw TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_ext ON items(ext);
CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(is_deleted);
CREATE TABLE IF NOT EXISTS tags(
  item_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE TABLE IF NOT EXISTS palettes(
  item_id TEXT NOT NULL,
  r INTEGER NOT NULL,
  g INTEGER NOT NULL,
  b INTEGER NOT NULL,
  ratio REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_palettes_item ON palettes(item_id);
CREATE TABLE IF NOT EXISTS hashes(
  item_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  hashed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hashes_sha ON hashes(sha256);
-- trigram 分词：中文等 CJK 子串检索的可行方案（查询词 >= 3 字符）
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  name, tags, annotation, url,
  tokenize='trigram'
);
`;

/** 索引结构版本：变更时自动清空重建（缓存可抛弃，权威源不受影响） */
const SCHEMA_VERSION = 3;

export function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

/** 打开并自愈：结构版本不匹配时 DROP 旧表按新版重建（索引是缓存，数据可弃）。
 *  库路径不在这里导入——调用方（openLibrary / CLI import）显式触发。 */
export function openAndHeal(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  let stored = 0;
  try {
    stored = Number(
      db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value ?? 0,
    );
  } catch {
    stored = 0;
  }

  if (stored !== SCHEMA_VERSION) {
    // CREATE TABLE IF NOT EXISTS 不会修改已存在的旧表结构，必须 DROP 重建
    db.exec(`
      DROP TABLE IF EXISTS items;
      DROP TABLE IF EXISTS tags;
      DROP TABLE IF EXISTS folders;
      DROP TABLE IF EXISTS smart_folders;
      DROP TABLE IF EXISTS palettes;
      DROP TABLE IF EXISTS hashes;
      DROP TABLE IF EXISTS items_fts;
      DROP TABLE IF EXISTS meta;
    `);
    db.exec(SCHEMA);
    setMetaValue(db, "schemaVersion", String(SCHEMA_VERSION));
  }
  return db;
}

function setMetaValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
}

export function importLibrary(
  db: DatabaseSync,
  libraryPath: string,
): ImportStats {
  const started = performance.now();
  const paths = resolveLibrary(libraryPath);
  const meta = readLibraryMeta(paths);
  const { entries, failures } = scanItems(paths);

  const insertFolder = db.prepare(
    "INSERT OR REPLACE INTO folders(id, name, parent_id) VALUES (?, ?, ?)",
  );
  const insertSmart = db.prepare(
    "INSERT OR REPLACE INTO smart_folders(id, name, conditions_json) VALUES (?, ?, ?)",
  );
  const setMeta = db.prepare(
    "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
  );

  db.exec("BEGIN");
  try {
    const flat = flattenFolders(meta.folders);
    for (const f of flat) insertFolder.run(f.id, f.name, f.parentId);
    for (const sf of flattenSmartFolders(meta.smartFolders)) {
      insertSmart.run(sf.id, sf.name, JSON.stringify(sf.conditions));
    }
    setMeta.run("libraryPath", paths.root);
    setMeta.run("applicationVersion", meta.applicationVersion);
    setMeta.run("importedAt", String(Date.now()));

    let tagCount = 0;
    let deleted = 0;
    for (const { item, raw } of entries) {
      tagCount += indexItem(db, item, raw);
      if (item.isDeleted) deleted++;
    }
    rebuildFts(db);
    db.exec("COMMIT");

    return {
      library: paths.root,
      imported: entries.length,
      malformed: failures.length,
      deleted,
      tagCount,
      folders: flat.length,
      smartFolders: meta.smartFolders.length,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 全量重建 FTS（条目量级 ≤ 数万时足够快；增量优化留到需要时做） */
function rebuildFts(db: DatabaseSync): void {
  db.exec(`
    DELETE FROM items_fts;
    INSERT INTO items_fts(rowid, name, tags, annotation, url)
    SELECT rowid, name,
           (SELECT group_concat(tag, ' ') FROM tags WHERE tags.item_id = items.id),
           annotation, url
    FROM items;
  `);
}

/**
 * 单条目索引写入：upsert + 标签/色板重建 + 定向 FTS 更新。
 * 返回该条目的标签引用数。采集（API）与全量导入共用。
 */
export function indexItem(
  db: DatabaseSync,
  item: ItemMetadata,
  raw: string,
): number {
  db.prepare(`
    INSERT INTO items(id, name, ext, size, width, height, duration,
                      btime, mtime, annotation, url, is_deleted,
                      folders_json, meta_mtime, preview, codec, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, ext=excluded.ext, size=excluded.size,
      width=excluded.width, height=excluded.height, duration=excluded.duration,
      btime=excluded.btime, mtime=excluded.mtime,
      annotation=excluded.annotation, url=excluded.url,
      is_deleted=excluded.is_deleted, folders_json=excluded.folders_json,
      meta_mtime=excluded.meta_mtime, preview=excluded.preview,
      codec=excluded.codec, raw=excluded.raw
  `).run(
    item.id,
    item.name ?? "",
    String(item.ext ?? "").toLowerCase(),
    item.size ?? 0,
    item.width ?? null,
    item.height ?? null,
    item.duration ?? null,
    item.btime ?? null,
    item.mtime ?? null,
    item.annotation ?? "",
    item.url ?? "",
    item.isDeleted ? 1 : 0,
    JSON.stringify(item.folders ?? []),
    item.modificationTime ?? 0,
    item.preview ? 1 : 0,
    item.codec ?? null,
    raw,
  );

  db.prepare("DELETE FROM tags WHERE item_id = ?").run(item.id);
  db.prepare("DELETE FROM palettes WHERE item_id = ?").run(item.id);
  let tagCount = 0;
  for (const p of item.palettes ?? []) {
    const [r, g, b] = p.color ?? [];
    if ([r, g, b].every((v) => Number.isFinite(v))) {
      db.prepare(
        "INSERT INTO palettes(item_id, r, g, b, ratio) VALUES (?, ?, ?, ?, ?)",
      ).run(item.id, r, g, b, p.ratio ?? 0);
    }
  }
  for (const tag of item.tags ?? []) {
    db.prepare("INSERT OR IGNORE INTO tags(item_id, tag) VALUES (?, ?)").run(item.id, tag);
    tagCount++;
  }

  const row = db.prepare("SELECT rowid FROM items WHERE id = ?").get(item.id) as
    | { rowid: number }
    | undefined;
  if (row) {
    const tags =
      (db
        .prepare("SELECT group_concat(tag, ' ') AS t FROM tags WHERE item_id = ?")
        .get(item.id) as { t: string | null } | undefined)?.t ?? "";
    db.prepare("DELETE FROM items_fts WHERE rowid = ?").run(row.rowid);
    db.prepare(
      "INSERT INTO items_fts(rowid, name, tags, annotation, url) VALUES (?, ?, ?, ?, ?)",
    ).run(row.rowid, item.name ?? "", tags, item.annotation ?? "", item.url ?? "");
  }
  return tagCount;
}

// ── 查询 ──────────────────────────────────────────────

const ITEM_COLS =
  "id, name, ext, size, width, height, duration, is_deleted, preview";

/** 搜索：< 3 字符走 LIKE（trigram 下限），>= 3 走 FTS 子串匹配 */
export function search(
  db: DatabaseSync,
  query: string,
  limit = 20,
): ItemRow[] {
  const q = query.trim();
  if (q.length === 0) return [];
  if (q.length < 3) {
    const like = `%${q}%`;
    return db
      .prepare(
        `SELECT ${ITEM_COLS} FROM items
         WHERE name LIKE ? OR id IN (SELECT item_id FROM tags WHERE tag LIKE ?)
         ORDER BY name LIMIT ?`,
      )
      .all(like, like, limit) as unknown as ItemRow[];
  }
  // 用户输入必须转义并包成 phrase，否则 `-`、`:` 等会被当成 FTS5 查询语法
  return db
    .prepare(
      `SELECT i.${ITEM_COLS.replace(/,/g, ", i.")} FROM items_fts f
       JOIN items i ON i.rowid = f.rowid
       WHERE items_fts MATCH ?
       ORDER BY i.name LIMIT ?`,
    )
    .all(phrase(q), limit) as unknown as ItemRow[];
}

export function byTag(db: DatabaseSync, tag: string, limit = 20): ItemRow[] {
  return db
    .prepare(
      `SELECT ${ITEM_COLS} FROM items
       WHERE id IN (SELECT item_id FROM tags WHERE tag = ?)
       ORDER BY name LIMIT ?`,
    )
    .all(tag, limit) as unknown as ItemRow[];
}

/** FTS5 用户输入安全短语 */
function phrase(q: string): string {
  return `"${q.replaceAll('"', '""')}"`;
}

export interface ListFilter {
  query?: string;
  ext?: string | null;
  deleted?: boolean;
  tag?: string | null;
  limit?: number;
}

/** 组合筛选：回收站 × 类型 × 标签 × 关键词（UI 主列表查询） */
export function listItems(
  db: DatabaseSync,
  { query = "", ext = null, deleted = false, tag = null, limit = 5000 }: ListFilter = {},
): ItemRow[] {
  const where: string[] = ["i.is_deleted = ?"];
  const params: (string | number)[] = [deleted ? 1 : 0];
  if (ext) {
    where.push("i.ext = ?");
    params.push(ext);
  }
  if (tag) {
    where.push("i.id IN (SELECT item_id FROM tags WHERE tag = ?)");
    params.push(tag);
  }
  const q = query.trim();
  if (q.length > 0 && q.length < 3) {
    const like = `%${q}%`;
    where.push(
      "(i.name LIKE ? OR i.id IN (SELECT item_id FROM tags WHERE tag LIKE ?))",
    );
    params.push(like, like);
  } else if (q.length >= 3) {
    where.push("i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)");
    params.push(phrase(q));
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT i.${ITEM_COLS.replace(/,/g, ", i.")} FROM items i
       WHERE ${where.join(" AND ")}
       ORDER BY i.name LIMIT ?`,
    )
    .all(...params) as unknown as ItemRow[];
}

/** 按 ID 集合取条目（智能文件夹结果；分块 IN 避免 SQLite 变量上限） */
export function listByIds(
  db: DatabaseSync,
  ids: string[],
  deleted = false,
): ItemRow[] {
  const out: ItemRow[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const ph = chunk.map(() => "?").join(",");
    out.push(
      ...(db
        .prepare(
          `SELECT i.${ITEM_COLS.replace(/,/g, ", i.")} FROM items i
           WHERE i.id IN (${ph}) AND i.is_deleted = ?
           ORDER BY i.name`,
        )
        .all(...chunk, deleted ? 1 : 0) as unknown as ItemRow[]),
    );
  }
  return out;
}

export interface DbStats {
  items: number;
  deleted: number;
  byExt: { ext: string; n: number }[];
  topTags: { tag: string; n: number }[];
  smartFolders: { id: string; name: string; matchCount: number }[];
}

export function stats(db: DatabaseSync): DbStats {
  const total = db.prepare("SELECT count(*) n FROM items").get()!.n as number;
  const deleted = db
    .prepare("SELECT count(*) n FROM items WHERE is_deleted = 1")
    .get()!.n as number;
  const byExt = db
    .prepare(
      "SELECT ext, count(*) n FROM items GROUP BY ext ORDER BY n DESC LIMIT 15",
    )
    .all() as unknown as { ext: string; n: number }[];
  const topTags = db
    .prepare(
      "SELECT tag, count(*) n FROM tags GROUP BY tag ORDER BY n DESC LIMIT 10",
    )
    .all() as unknown as { tag: string; n: number }[];
  const smartFolders = (
    db
      .prepare("SELECT id, name, conditions_json FROM smart_folders")
      .all() as unknown as { id: string; name: string; conditions_json: string }[]
  ).map((sf) => ({
    id: sf.id,
    name: sf.name,
    matchCount: evaluateSmartFolder(
      db,
      JSON.parse(sf.conditions_json) as SmartFolder["conditions"],
    ),
  }));
  return { items: total, deleted, byExt, topTags, smartFolders };
}

/**
 * 智能文件夹条件求值（M1）——基于条目 ID 集合：
 *  - 条件组之间取 AND（交集）；组内规则按 match 字段 OR(并集)/AND(交集) 组合；
 *  - 支持 property ∈ {type(→ext), ext, tags}，
 *    method ∈ {equal, notEqual, contains, notContains}（tags 仅 equal/contains）；
 *  - 遇到未支持的规则整体返回 -1（显式未知），不用部分结果冒充。
 */
export function evaluateSmartFolder(
  db: DatabaseSync,
  conditions: SmartFolder["conditions"],
): number {
  const ids = smartFolderIds(db, conditions);
  return ids === null ? -1 : ids.size;
}

/** 同上，但返回匹配集合；含未支持规则时返回 null（调用方显式处理未知） */
export function smartFolderIds(
  db: DatabaseSync,
  conditions: SmartFolder["conditions"],
): Set<string> | null {
  let combined: Set<string> | null = null; // 各条件组的交集

  for (const cond of conditions) {
    let group: Set<string> | null = null; // 组内规则按 match 组合
    for (const rule of cond.rules) {
      const ids = evalRule(db, rule);
      if (ids === null) return null; // 未支持的规则
      group =
        group === null
          ? ids
          : cond.match === "AND"
            ? group.intersection(ids)
            : group.union(ids);
    }
    if (group === null) continue;
    combined = combined === null ? group : combined.intersection(group);
  }
  return combined;
}

/** 单条规则 → 匹配的条目 ID 集合；不支持返回 null */
function evalRule(
  db: DatabaseSync,
  rule: { property: string; method: string; value: unknown },
): Set<string> | null {
  const prop = rule.property === "type" ? "ext" : rule.property;
  const value = String(rule.value ?? "").toLowerCase();
  const ids = (rows: unknown[]) =>
    new Set((rows as unknown as { id: string }[]).map((r) => r.id));

  if (prop === "ext") {
    switch (rule.method) {
      case "equal":
        return ids(db.prepare("SELECT id FROM items WHERE ext = ?").all(value));
      case "notEqual":
        return ids(
          db.prepare("SELECT id FROM items WHERE ext != ?").all(value),
        );
      case "contains":
        return ids(
          db.prepare("SELECT id FROM items WHERE ext LIKE ?").all(`%${value}%`),
        );
      case "notContains":
        return ids(
          db
            .prepare("SELECT id FROM items WHERE ext NOT LIKE ?")
            .all(`%${value}%`),
        );
      default:
        return null;
    }
  }
  if (prop === "tags") {
    switch (rule.method) {
      case "equal":
      case "contains":
        return ids(
          db.prepare("SELECT item_id id FROM tags WHERE tag = ?").all(value),
        );
      default:
        return null;
    }
  }
  return null;
}

export function getItem(db: DatabaseSync, id: string): ItemMetadata | null {
  const row = db
    .prepare("SELECT raw FROM items WHERE id = ?")
    .get(id) as unknown as { raw: string } | undefined;
  return row ? (JSON.parse(row.raw) as ItemMetadata) : null;
}

// ── 颜色搜索 ──────────────────────────────────────────

/** sRGB → CIELAB（D65）；ΔE 比加权 RGB 距离更接近感知差异 */
export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export interface ColorHit extends ItemRow {
  /** 0-100 相似度（启发式：加权 RGB 距离 × 色板占比） */
  sim: number;
}

/**
 * 按颜色找条目：对每个条目取其色板中与目标最接近的颜色打分。
 * 距离用加权欧氏 d = √(2Δr² + 4Δg² + 3Δb²)（近似感知差异），
 * 相似度 = e^(−d/120) × (0.3 + 0.7·ratio/100)。经验参数，可再调。
 */
export function searchByColor(
  db: DatabaseSync,
  target: { r: number; g: number; b: number },
  deleted = false,
  limit = 60,
): ColorHit[] {
  const [tL, tA, tB] = srgbToLab(target.r, target.g, target.b);
  const rows = db
    .prepare(
      `SELECT p.r AS pr, p.g AS pg, p.b AS pb, p.ratio AS ratio,
              i.${ITEM_COLS.replace(/,/g, ", i.")}
       FROM palettes p JOIN items i ON i.id = p.item_id
       WHERE i.is_deleted = ?`,
    )
    .all(deleted ? 1 : 0) as unknown as ({
    pr: number; pg: number; pb: number; ratio: number;
  } & ItemRow)[];

  const best = new Map<string, ColorHit>();
  for (const row of rows) {
    const d = Math.sqrt(
      2 * (row.pr - target.r) ** 2
      + 4 * (row.pg - target.g) ** 2
      + 3 * (row.pb - target.b) ** 2,
    );
    const sim = Math.round(
      100 * Math.exp(-d / 120) * (0.3 + (0.7 * row.ratio) / 100),
    );
    const prev = best.get(row.id);
    if (!prev || sim > prev.sim) {
      best.set(row.id, { ...row, sim });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
}

// ── 重复文件 ──────────────────────────────────────────

export function getKnownHashes(db: DatabaseSync): Map<string, { sha256: string; size: number }> {
  const rows = db.prepare("SELECT item_id, sha256, size FROM hashes").all() as unknown as {
    item_id: string; sha256: string; size: number;
  }[];
  return new Map(rows.map((r) => [r.item_id, { sha256: r.sha256, size: r.size }]));
}

export function saveHash(
  db: DatabaseSync,
  itemId: string,
  sha256: string,
  size: number,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO hashes(item_id, sha256, size, hashed_at) VALUES (?, ?, ?, ?)",
  ).run(itemId, sha256, size, Date.now());
}

/** 已哈希条目按内容分组（仅未删除、大小相同才可能重复） */
export function duplicateGroups(db: DatabaseSync): { sha256: string; items: ItemRow[] }[] {
  const rows = db
    .prepare(
      `SELECT h.sha256 AS sha, i.${ITEM_COLS.replace(/,/g, ", i.")}
       FROM hashes h JOIN items i ON i.id = h.item_id
       WHERE i.is_deleted = 0`,
    )
    .all() as unknown as ({ sha: string } & ItemRow)[];

  const bySha = new Map<string, ItemRow[]>();
  for (const { sha, ...item } of rows) {
    const list = bySha.get(sha) ?? [];
    list.push(item);
    bySha.set(sha, list);
  }
  return [...bySha.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([sha256, items]) => ({
      sha256,
      items: items.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort(
      (a, b) =>
        b.items[0].size * b.items.length - a.items[0].size * a.items.length,
    );
}

// ── 回收站恢复 ────────────────────────────────────────

/**
 * 回收站标记翻转（恢复/移入共用）：权威源是条目自己的 metadata.json，
 * 必须改文件而不是只改索引。顺便同步 mtime.json（.library 格式的变更检测协议）。
 */
function setDeletedFlag(
  db: DatabaseSync,
  id: string,
  deleted: boolean,
): { ok: boolean; message: string } {
  const libPath = db
    .prepare("SELECT value FROM meta WHERE key='libraryPath'")
    .get()?.value as string | undefined;
  if (!libPath) return { ok: false, message: "索引缺少库路径" };

  const metaPath = join(libPath, "images", `${id}.info`, "metadata.json");
  let item: ItemMetadata;
  try {
    item = JSON.parse(readFileSync(metaPath, "utf8")) as ItemMetadata;
  } catch (err) {
    return { ok: false, message: `读取条目失败：${err instanceof Error ? err.message : err}` };
  }
  if (item.isDeleted === deleted) {
    return { ok: false, message: deleted ? "条目已在回收站" : "条目不在回收站" };
  }

  const now = Date.now();
  item.isDeleted = deleted;
  item.modificationTime = now;
  item.lastModified = now;
  try {
    // 与 .library 格式规范一致的单行 JSON
    writeFileSync(metaPath, JSON.stringify(item));
  } catch (err) {
    return { ok: false, message: `写入失败：${err instanceof Error ? err.message : err}` };
  }

  const mtimePath = join(libPath, "mtime.json");
  try {
    if (existsSync(mtimePath)) {
      const m = JSON.parse(readFileSync(mtimePath, "utf8")) as Record<string, number>;
      m[id] = now;
      writeFileSync(mtimePath, JSON.stringify(m));
    }
  } catch {
    // mtime.json 损坏不影响恢复本体；显式跳过
  }

  db.prepare("UPDATE items SET is_deleted = ?, meta_mtime = ? WHERE id = ?")
    .run(deleted ? 1 : 0, now, id);
  return { ok: true, message: deleted ? "已移入回收站" : "已恢复" };
}

export function restoreItem(db: DatabaseSync, id: string): { ok: boolean; message: string } {
  return setDeletedFlag(db, id, false);
}

/** 移入回收站（可恢复；不删文件）。重复组清理用 */
export function trashItem(db: DatabaseSync, id: string): { ok: boolean; message: string } {
  return setDeletedFlag(db, id, true);
}

/**
 * 设置条目标签：权威源是条目 metadata.json，写入后同步索引（含 FTS）。
 * 去重、去空白、保序。
 */
export function setItemTags(
  db: DatabaseSync,
  id: string,
  tags: string[],
): { ok: boolean; tags?: string[]; message?: string } {
  const libPath = db
    .prepare("SELECT value FROM meta WHERE key='libraryPath'")
    .get()?.value as string | undefined;
  if (!libPath) return { ok: false, message: "索引缺少库路径" };

  const metaPath = join(libPath, "images", `${id}.info`, "metadata.json");
  let item: ItemMetadata;
  try {
    item = JSON.parse(readFileSync(metaPath, "utf8")) as ItemMetadata;
  } catch (err) {
    return { ok: false, message: `读取条目失败：${err instanceof Error ? err.message : err}` };
  }

  const clean = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];
  const now = Date.now();
  item.tags = clean;
  item.modificationTime = now;
  item.lastModified = now;
  try {
    writeFileSync(metaPath, JSON.stringify(item));
  } catch (err) {
    return { ok: false, message: `写入失败：${err instanceof Error ? err.message : err}` };
  }
  const mtimePath = join(libPath, "mtime.json");
  try {
    if (existsSync(mtimePath)) {
      const m = JSON.parse(readFileSync(mtimePath, "utf8")) as Record<string, number>;
      m[id] = now;
      writeFileSync(mtimePath, JSON.stringify(m));
    }
  } catch { /* 同上，非关键路径 */ }

  indexItem(db, item, JSON.stringify(item));
  return { ok: true, tags: clean };
}

/** 全部标签及引用数（侧栏标签列表用） */
export function allTags(db: DatabaseSync): { tag: string; n: number }[] {
  return db
    .prepare(
      "SELECT tag, count(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag",
    )
    .all() as unknown as { tag: string; n: number }[];
}
