// 数据模型：与 .library 开放格式对齐（见 ../LIBRARY-FORMAT.md）。
// 原则：JSON 是权威源，索引只是缓存；未知字段必须保留。

export interface PaletteColor {
  color: [number, number, number];
  ratio: number;
}

/** 条目 metadata.json（字段为实证观察，可扩展） */
export interface ItemMetadata {
  id: string;
  name: string;
  size: number;
  btime: number;
  mtime: number;
  ext: string;
  tags: string[];
  folders: string[];
  isDeleted: boolean;
  url: string;
  annotation: string;
  modificationTime: number;
  lastModified: number;
  width?: number;
  height?: number;
  duration?: number;
  resolutionWidth?: number;
  resolutionHeight?: number;
  palettes?: PaletteColor[];
  /** 视频编码（ffprobe）；决定是否需要代理副本 */
  codec?: string;
  /** 存在 Web 可播的代理副本 <name>_preview.mp4 */
  preview?: boolean;
  /** 探针失败（源文件损坏/不完整），不再重复尝试 */
  probeFailed?: boolean;
  [key: string]: unknown;
}

export interface SmartFolderRule {
  property: string;
  method: string;
  value: unknown;
}

export interface SmartFolderCondition {
  rules: SmartFolderRule[];
  match: string; // "OR" | "AND"
  boolean: string;
}

export interface SmartFolder {
  id: string;
  name: string;
  description: string;
  modificationTime: number;
  conditions: SmartFolderCondition[];
  children: SmartFolder[];
}

export interface LibraryFolder {
  id: string;
  name: string;
  description?: string;
  children?: LibraryFolder[];
  [key: string]: unknown;
}

/** 库级 metadata.json */
export interface LibraryMeta {
  folders: LibraryFolder[];
  smartFolders: SmartFolder[];
  quickAccess: unknown[];
  tagsGroups: unknown[];
  modificationTime: number;
  applicationVersion: string;
  [key: string]: unknown;
}

/** 索引条目行（DB schema 即契约） */
export interface ItemRow {
  id: string;
  name: string;
  ext: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  is_deleted: number;
}

/** 一次导入的统计 */
export interface ImportStats {
  library: string;
  imported: number;
  malformed: number;
  deleted: number;
  tagCount: number;
  folders: number;
  smartFolders: number;
  elapsedMs: number;
}

/** 解析失败的条目（保留原因，不静默丢弃） */
export interface ParseFailure {
  dir: string;
  reason: string;
}
