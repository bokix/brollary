// 采集落盘：把外部内容写成 .library 的 .info 条目，并保持权威 JSON 与索引一致。
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, copyFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import type { ItemMetadata } from "./types.ts";
import { indexItem } from "./indexer.ts";
import { probeImageFile, parseExifJpeg, probeWavDuration } from "./probe.ts";

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB 上限

/** 13 位大写 ID，符合 .library 格式规范（时间戳基36 + 随机） */
export function genId(): string {
  const t = Date.now().toString(36).toUpperCase().padStart(8, "0").slice(-8);
  const rnd = randomBytes(5)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .toUpperCase()
    .padEnd(5, "0")
    .slice(0, 5);
  return (t + rnd).slice(0, 13);
}

/** 文件名净化：去掉路径分隔符与控制字符，限制长度 */
export function sanitizeName(input: string, fallback = "未命名"): string {
  const name = (input || fallback)
    .replace(/[/\\]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .slice(0, 120);
  return name || fallback;
}

function extFromUrlOrName(url: string): string {
  const base = basename(new URL(url).pathname);
  const m = /\.([a-z0-9]{1,8})$/i.exec(base);
  return m ? m[1].toLowerCase() : "";
}

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "application/pdf": "pdf",
  "application/zip": "zip",
};

interface AddOptions {
  name?: string;
  tags?: string[];
  folders?: string[];
  url?: string;      // 来源页/来源 URL（provenance）
  annotation?: string;
}

export interface AddResult {
  ok: boolean;
  id?: string;
  message: string;
}

/** 从本地路径采集（复制进库，不动源文件） */
export function addFromPath(
  db: DatabaseSync,
  libraryPath: string,
  srcPath: string,
  opts: AddOptions = {},
): AddResult {
  const abs = srcPath.startsWith("/") ? srcPath : join(libraryPath, srcPath);
  if (!existsSync(abs)) return { ok: false, message: `文件不存在：${abs}` };
  const st = statSync(abs);
  if (!st.isFile()) return { ok: false, message: "不是常规文件" };

  const originalName = basename(abs);
  const dot = originalName.lastIndexOf(".");
  const name = sanitizeName(opts.name ?? (dot > 0 ? originalName.slice(0, dot) : originalName));
  const ext = (dot > 0 ? originalName.slice(dot + 1) : "").toLowerCase();

  return writeItem(db, libraryPath, abs, { name, ext, ...opts });
}

/** 从 URL 采集（下载到库；记录来源 URL；失败不留半成品） */
export async function addFromUrl(
  db: DatabaseSync,
  libraryPath: string,
  url: string,
  opts: AddOptions = {},
): Promise<AddResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
      headers: { "user-agent": "stash-ingest/0.1" },
    });
  } catch (err) {
    return { ok: false, message: `下载失败：${err instanceof Error ? err.message : err}` };
  }
  if (!res.ok || !res.body) {
    return { ok: false, message: `下载失败：HTTP ${res.status}` };
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    return { ok: false, message: `文件超过大小上限（${(MAX_DOWNLOAD_BYTES / 1e9).toFixed(1)}GB）` };
  }

  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const ext = extFromUrlOrName(url) || CONTENT_TYPE_EXT[type] || "bin";
  const base = decodeURIComponent(basename(new URL(url).pathname)) || "未命名";
  const dot = base.lastIndexOf(".");
  const name = sanitizeName(opts.name ?? (dot > 0 ? base.slice(0, dot) : base));

  const id = genId();
  const dir = join(libraryPath, "images", `${id}.info`);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.downloading-${id}`);

  try {
    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    let received = 0;
    nodeStream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) nodeStream.destroy(new Error("超过大小上限"));
    });
    await pipeline(nodeStream, createWriteStream(tmpPath));

    const finalPath = join(dir, `${name}.${ext}`);
    renameSync(tmpPath, finalPath);
    return writeItem(db, libraryPath, finalPath, { name, ext, ...opts }, id);
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* 尽力清理 */ }
    return { ok: false, message: `下载中断：${err instanceof Error ? err.message : err}` };
  }
}

/** 共享落盘：把已就位的原始文件登记为条目（metadata.json 权威 + 索引同步） */
function writeItem(
  db: DatabaseSync,
  libraryPath: string,
  filePath: string,
  opts: { name: string; ext: string } & AddOptions,
  forcedId?: string,
): AddResult {
  const id = forcedId ?? genId();
  const dir = join(libraryPath, "images", `${id}.info`);
  mkdirSync(dir, { recursive: true });

  // URL 采集时文件已在目标目录；路径采集时复制进来（保留原件）
  const finalPath = join(dir, `${opts.name}.${opts.ext}`);
  if (filePath !== finalPath) copyFileSync(filePath, finalPath);

  const st = statSync(finalPath);
  const now = Date.now();
  // 尺寸探针（图片）/ 时长探针（wav）：瀑布流与搓擦需要；探针失败则留空，不猜
  let probe: { width?: number; height?: number } = {};
  if (["png", "gif", "jpg", "jpeg", "webp", "bmp"].includes(opts.ext)) {
    probe = probeImageFile(finalPath);
  }
  let wavDuration: number | undefined;
  if (opts.ext === "wav") {
    const d = probeWavDuration(finalPath);
    if (d != null) wavDuration = d;
  }
  const item: ItemMetadata = {
    id,
    name: opts.name,
    size: st.size,
    btime: st.birthtimeMs || now,
    mtime: st.mtimeMs,
    ext: opts.ext,
    tags: opts.tags ?? [],
    folders: opts.folders ?? [],
    isDeleted: false,
    url: opts.url ?? "",
    annotation: opts.annotation ?? "",
    modificationTime: now,
    lastModified: now,
    ...(probe.width ? { width: probe.width, height: probe.height } : {}),
    ...(wavDuration != null ? { duration: wavDuration } : {}),
  };
  const metaPath = join(dir, "metadata.json");
  writeJson(metaPath, item);

  indexItem(db, item, JSON.stringify(item));
  return { ok: true, id, message: "已入库" };
}

function writeJson(path: string, data: unknown): void {
  // 与 .library 格式规范一致的单行 JSON
  writeFileSync(path, JSON.stringify(data));
}
