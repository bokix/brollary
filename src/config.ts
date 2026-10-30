// 库注册表：Brollary 管理的所有库的持久化配置。
// 配置存在 Electron userData 目录（多库唯一事实源）；库本体是自包含的 .library 文件夹。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LibraryEntry {
  id: string;
  name: string;
  path: string;      // .library 文件夹绝对路径
  createdAt: number;
  lastOpened: number;
}

export interface BrollaryConfig {
  version: 1;
  libraries: LibraryEntry[];
  activeLibraryId: string | null;
}

const DEFAULTS: BrollaryConfig = { version: 1, libraries: [], activeLibraryId: null };

export function configPath(userDataDir: string): string {
  return join(userDataDir, "config.json");
}

export function loadConfig(userDataDir: string): BrollaryConfig {
  const p = configPath(userDataDir);
  try {
    if (!existsSync(p)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return { ...DEFAULTS }; // 配置损坏时从空开始；库本体不受影响
  }
}

export function saveConfig(userDataDir: string, cfg: BrollaryConfig): void {
  const p = configPath(userDataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}

/** 每个库自己的索引缓存：放在 .library 文件夹内，随库迁移 */
export function libraryDbPath(libraryPath: string): string {
  return join(libraryPath, "brollary.db");
}
