// 库生命周期：创建空库 / 校验现有库。遵循 .library 开放格式。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LibraryMeta } from "./types.ts";

const EMPTY_META: LibraryMeta = {
  folders: [],
  smartFolders: [],
  quickAccess: [],
  tagsGroups: [],
  modificationTime: 0,
  applicationVersion: "brollary-0.1.1",
};

/** 新建一个空 .library（同名目录已存在时拒绝，避免误覆盖） */
export function createLibrary(parentDir: string, name: string): { ok: boolean; path?: string; message?: string } {
  const safeName = name.trim().replace(/[/\\:]/g, "_") || "未命名库";
  const dir = join(parentDir, `${safeName}.library`);
  if (existsSync(dir)) return { ok: false, message: `目录已存在：${dir}` };
  try {
    mkdirSync(join(dir, "images"), { recursive: true });
    mkdirSync(join(dir, "backup"), { recursive: true });
    writeFileSync(join(dir, "metadata.json"), JSON.stringify({ ...EMPTY_META, modificationTime: Date.now() }));
    writeFileSync(join(dir, "tags.json"), JSON.stringify({ historyTags: [], starredTags: [] }));
    writeFileSync(join(dir, "saved-filters.json"), "[]");
    writeFileSync(join(dir, "actions.json"), "[]");
    writeFileSync(join(dir, "mtime.json"), "{}");
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, message: `创建失败：${err instanceof Error ? err.message : err}` };
  }
}

/** 校验一个 .library 路径是否可被 Brollary 打开 */
export function validateLibrary(libraryPath: string): { ok: boolean; message?: string; itemCount?: number } {
  if (!existsSync(libraryPath)) return { ok: false, message: "路径不存在" };
  if (!libraryPath.endsWith(".library")) return { ok: false, message: "不是 .library 文件夹" };
  const images = join(libraryPath, "images");
  if (!existsSync(images)) return { ok: false, message: "缺少 images/ 目录，不是有效的 .library" };
  let itemCount = 0;
  try {
    itemCount = readdirSync(images).filter((d) => d.endsWith(".info")).length;
  } catch {
    itemCount = -1; // 读取失败但结构存在，仍可打开
  }
  return { ok: true, itemCount };
}
