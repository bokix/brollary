// 重复文件扫描：先按文件大小分组缩小范围，只对同大小的候选计算 SHA-256，增量缓存。
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ItemRow } from "./types.ts";
import {
  duplicateGroups,
  getKnownHashes,
  listItems,
  saveHash,
} from "./indexer.ts";

const CONCURRENCY = 4;

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export interface DupScanResult {
  groups: { sha256: string; items: ItemRow[] }[];
  scanned: number;   // 本次实际哈希的文件数
  candidates: number; // 同大小候选总数
  cached: number;     // 复用已有哈希数
  wastedBytes: number;
}

/** 只对「同大小」的未删除条目做内容哈希（大小不同不可能内容相同） */
export async function scanDuplicates(
  db: DatabaseSync,
  libraryPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<DupScanResult> {
  const all = listItems(db, { deleted: false, limit: 1000000 });
  const bySize = new Map<number, ItemRow[]>();
  for (const row of all) {
    const list = bySize.get(row.size) ?? [];
    list.push(row);
    bySize.set(row.size, list);
  }
  const candidates = [...bySize.values()].filter((l) => l.length > 1).flat();
  const known = getKnownHashes(db);

  let done = 0;
  let cached = 0;
  const queue = [...candidates];
  const worker = async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const memo = known.get(row.id);
      if (memo && memo.size === row.size) {
        cached++;
      } else {
        const path = join(libraryPath, "images", `${row.id}.info`, `${row.name}.${row.ext}`);
        if (existsSync(path)) {
          const sha = await sha256File(path);
          saveHash(db, row.id, sha, row.size);
          known.set(row.id, { sha256: sha, size: row.size });
        }
      }
      done++;
      onProgress?.(done, candidates.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const groups = duplicateGroups(db);
  const wastedBytes = groups.reduce(
    (sum, g) => sum + g.items[0].size * (g.items.length - 1),
    0,
  );
  return { groups, scanned: done - cached, candidates: candidates.length, cached, wastedBytes };
}
