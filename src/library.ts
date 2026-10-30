// .library 读取层：只做格式解析，不做索引。容忍损坏数据并显式上报。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ItemMetadata,
  LibraryMeta,
  ParseFailure,
} from "./types.ts";

export interface LibraryPaths {
  root: string;
  images: string;
  metadataJson: string;
}

export function resolveLibrary(libraryPath: string): LibraryPaths {
  const images = join(libraryPath, "images");
  if (!existsSync(images)) {
    throw new Error(`不是有效的 .library（缺少 images/ 目录）: ${libraryPath}`);
  }
  return {
    root: libraryPath,
    images,
    metadataJson: join(libraryPath, "metadata.json"),
  };
}

/** 解析库级元数据；缺失时返回空骨架而不是报错（新库合法状态） */
export function readLibraryMeta(paths: LibraryPaths): LibraryMeta {
  const empty: LibraryMeta = {
    folders: [],
    smartFolders: [],
    quickAccess: [],
    tagsGroups: [],
    modificationTime: 0,
    applicationVersion: "",
  };
  if (!existsSync(paths.metadataJson)) return empty;
  return { ...empty, ...JSON.parse(readFileSync(paths.metadataJson, "utf8")) };
}

export interface ItemEntry {
  item: ItemMetadata;
  dir: string;
  /** 原始 JSON 文本（权威源，索引用） */
  raw: string;
}

export interface ScanResult {
  entries: ItemEntry[];
  failures: ParseFailure[];
}

/** 扫描 images/ 下所有 <ID>.info/metadata.json */
export function scanItems(paths: LibraryPaths): ScanResult {
  const entries: ItemEntry[] = [];
  const failures: ParseFailure[] = [];

  for (const dirName of readdirSync(paths.images)) {
    if (!dirName.endsWith(".info")) continue;
    const dir = join(paths.images, dirName);
    const metaPath = join(dir, "metadata.json");
    try {
      const raw = readFileSync(metaPath, "utf8");
      const item = JSON.parse(raw) as ItemMetadata;
      if (typeof item.id !== "string" || item.id.length === 0) {
        failures.push({ dir, reason: "metadata 缺少 id 字段" });
        continue;
      }
      entries.push({ item, dir, raw });
    } catch (err) {
      failures.push({
        dir,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { entries, failures };
}

/** 文件夹树扁平化 */
export interface FlatFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export function flattenFolders(
  folders: LibraryMeta["folders"],
  parentId: string | null = null,
  out: FlatFolder[] = [],
): FlatFolder[] {
  for (const f of folders) {
    out.push({ id: f.id, name: f.name, parentId });
    if (f.children?.length) flattenFolders(f.children, f.id, out);
  }
  return out;
}

/** 智能文件夹树扁平化（含嵌套 children） */
export function flattenSmartFolders(
  smartFolders: LibraryMeta["smartFolders"],
  out: LibraryMeta["smartFolders"] = [],
): LibraryMeta["smartFolders"] {
  for (const sf of smartFolders) {
    out.push(sf);
    if (sf.children?.length) flattenSmartFolders(sf.children, out);
  }
  return out;
}
