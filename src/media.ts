// ffmpeg 媒体管线：视频探针、视频缩略图、全格式色板提取。后台队列串行执行。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ItemMetadata, PaletteColor } from "./types.ts";
import { indexItem, srgbToLab } from "./indexer.ts";
import { probeWavDuration } from "./probe.ts";

let ffmpegPath = "";
let ffprobePath = "";
try {
  // 打包/开发均在 node_modules 内；失败则管线降级为无探针
  ffmpegPath = (await import("ffmpeg-static")).default as unknown as string;
  ffprobePath = (await import("ffprobe-static")).default.path as string;
} catch { /* 依赖缺失时静默降级 */ }

export function mediaPipelineAvailable(): boolean {
  return Boolean(ffmpegPath && ffprobePath && existsSync(ffmpegPath));
}

function run(bin: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    p.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr }); });
  });
}

export interface VideoProbe {
  width?: number;
  height?: number;
  duration?: number;
  codec?: string;
}

/** Chromium <video> 原生可解的编码；不在集合内的走代理副本 */
const PLAYABLE_CODECS = new Set(["h264", "vp8", "vp9", "av1", "mpeg4", "theora"]);

/** 该编码是否需要代理副本才能在 Chromium 播放（未知编码按需要处理） */
export function codecNeedsProxy(codec?: string): boolean {
  if (!codec) return true;
  return !PLAYABLE_CODECS.has(codec);
}

/** ffprobe JSON：视频/音频的尺寸、时长与编码 */
export async function probeVideo(path: string): Promise<VideoProbe> {
  if (!ffprobePath) return {};
  const { code, stdout } = await run(ffprobePath,
    ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", path]);
  if (code !== 0) return {};
  try {
    const j = JSON.parse(stdout) as {
      streams?: { width?: number; height?: number; duration?: string; codec_type?: string; codec_name?: string }[];
      format?: { duration?: string };
    };
    const v = (j.streams ?? []).find((s) => s.codec_type === "video");
    const a = (j.streams ?? []).find((s) => s.codec_type === "audio");
    const dur = Number(v?.duration ?? a?.duration ?? j.format?.duration ?? NaN);
    const out: VideoProbe = {};
    if (v?.width && v?.height) { out.width = v.width; out.height = v.height; }
    if (Number.isFinite(dur) && dur > 0) out.duration = Math.round(dur * 1000) / 1000;
    if (v?.codec_name) out.codec = v.codec_name;
    return out;
  } catch {
    return {};
  }
}

/** 视频缩略图：取 25% 处一帧，等比缩到宽 512 的 PNG */
export async function makeVideoThumbnail(path: string, outPath: string, duration?: number): Promise<boolean> {
  if (!ffmpegPath) return false;
  mkdirSync(dirname(outPath), { recursive: true });
  const seek = duration && Number.isFinite(duration) ? Math.min(duration * 0.25, duration - 0.1) : 1;
  const { code } = await run(ffmpegPath,
    ["-y", "-v", "error", "-ss", String(Math.max(0, seek)), "-i", path,
     "-frames:v", "1", "-vf", "scale='min(512,iw)':-2", outPath]);
  return code === 0 && existsSync(outPath);
}

/**
 * 代理副本（达芬奇式）：非 Web 可解编码（prores/hevc 等）转 1080p H.264 + AAC。
 * 原文件不动；播放/搓擦用副本。返回是否成功。
 */
export async function makeProxy(path: string, outPath: string, duration?: number): Promise<boolean> {
  if (!ffmpegPath) return false;
  mkdirSync(dirname(outPath), { recursive: true });
  const args = ["-y", "-v", "error", "-i", path,
    "-vf", "scale='min(1920,iw)':-2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart"];
  if (duration && Number.isFinite(duration)) args.push("-t", String(duration + 0.5));
  args.push(outPath);
  const { code } = await run(ffmpegPath, args, 600_000);
  return code === 0 && existsSync(outPath);
}

/** 图片缩略图：等比缩到宽 512 的 PNG（gif/svg 交给渲染层回退原图，不动） */
export async function makeImageThumbnail(path: string, outPath: string): Promise<boolean> {
  if (!ffmpegPath) return false;
  mkdirSync(dirname(outPath), { recursive: true });
  const { code } = await run(ffmpegPath,
    ["-y", "-v", "error", "-i", path, "-frames:v", "1",
     "-vf", "scale='min(512,iw)':-2", outPath], 60_000);
  return code === 0 && existsSync(outPath);
}

/** 音频波形图：showwavespic 512×150 透明底 PNG */
export async function makeWaveform(path: string, outPath: string): Promise<boolean> {
  if (!ffmpegPath) return false;
  mkdirSync(dirname(outPath), { recursive: true });
  const { code } = await run(ffmpegPath,
    ["-y", "-v", "error", "-i", path,
     "-filter_complex", "showwavespic=s=512x150:colors=0x4f8cff",
     "-frames:v", "1", outPath], 60_000);
  return code === 0 && existsSync(outPath);
}

/** 色板提取：缩到 64×36 的 rawvideo RGB24，k-means(k=5) 出主色板（与 .library palettes 格式一致） */
export async function extractPalettes(path: string): Promise<PaletteColor[] | null> {
  if (!ffmpegPath) return null;
  const W = 64, H = 36;
  const raw = join("/tmp", `brollary-palette-${process.pid}-${Date.now()}.raw`);
  const { code } = await run(ffmpegPath,
    ["-y", "-v", "error", "-i", path, "-frames:v", "1", "-vf", `scale=${W}:${H}`, "-pix_fmt", "rgb24", "-f", "rawvideo", raw],
    60_000);
  if (code !== 0 || !existsSync(raw)) return null;
  try {
    const size = statSync(raw).size;
    if (size < W * H * 3) return null;
    const data = readFileSync(raw);
    // 采样步进，控制点数
    const pixels: [number, number, number][] = [];
    for (let i = 0; i < W * H; i += 2) {
      pixels.push([data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]);
    }
    const palettes = kmeansPalette(pixels, 5);
    return palettes;
  } finally {
    try { unlinkSync(raw); } catch { /* 尽力清理 */ }
  }
}

/** 简单 k-means：以 Lab 空间聚类（感知更均匀），输出 [r,g,b] + 占比% */
function kmeansPalette(pixels: [number, number, number][], k: number, iters = 8): PaletteColor[] {
  const lab = pixels.map(([r, g, b]) => srgbToLab(r, g, b));
  // 初始中心：按像素排序均匀取
  let centers = Array.from({ length: k }, (_, i) =>
    lab[Math.min(lab.length - 1, Math.floor((i + 0.5) * lab.length / k))]);
  let assign = new Array(lab.length).fill(0);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < lab.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (lab[i][0] - centers[c][0]) ** 2 + (lab[i][1] - centers[c][1]) ** 2 + (lab[i][2] - centers[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < lab.length; i++) {
      const a = assign[i];
      sums[a][0] += lab[i][0]; sums[a][1] += lab[i][1]; sums[a][2] += lab[i][2]; sums[a][3]++;
    }
    centers = centers.map((c, ci) => sums[ci][3]
      ? ([sums[ci][0] / sums[ci][3], sums[ci][1] / sums[ci][3], sums[ci][2] / sums[ci][3]] as [number, number, number])
      : c);
  }
  // Lab 中心转回 RGB：近似用逆变换
  const out: PaletteColor[] = centers.map((c, ci) => {
    const count = assign.filter((a) => a === ci).length;
    return { color: labToRgb(c), ratio: Math.round((count / lab.length) * 1000) / 10 };
  });
  return out.filter((p) => p.ratio > 0.5).sort((a, b) => b.ratio - a.ratio);
}

function labToRgb([L, A, B]: [number, number, number]): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
  const inv = (t: number) => {
    const t3 = t ** 3;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const Rl = 3.2404542 * X + -1.5371385 * Y + -0.4985314 * Z;
  const Gl = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const Bl = 0.0556434 * X + -0.2040259 * Y + 1.0572252 * Z;
  const gamma = (v: number) => {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(s * 255)));
  };
  return [gamma(Rl), gamma(Gl), gamma(Bl)];
}

// ── 后台队列 ────────────────────────────────────────────

interface MediaJob { id: string; path: string; ext: string; kind: "video" | "audio" | "image" }
const queue: MediaJob[] = [];
let draining = false;
let onUpdate: ((id: string) => void) | null = null;

/** 注册刷新回调（条目管线完成后通知 UI/主进程刷新索引） */
export function setMediaUpdateListener(fn: (id: string) => void): void {
  onUpdate = fn;
}

export function enqueueMedia(db: DatabaseSync, job: MediaJob): void {
  queue.push(job);
  if (!draining) void drain(db);
}

async function drain(db: DatabaseSync): Promise<void> {
  draining = true;
  try {
    for (;;) {
      const job = queue.shift();
      if (!job) break;
      try {
        await processJob(db, job);
        onUpdate?.(job.id);
      } catch (err) {
        console.error("[media] 管线失败", job.id, err);
      }
    }
  } finally {
    draining = false;
  }
}

async function processJob(db: DatabaseSync, job: MediaJob): Promise<void> {
  const row = db.prepare("SELECT raw FROM items WHERE id = ?").get(job.id) as { raw: string } | undefined;
  if (!row) return;
  const item = JSON.parse(row.raw) as ItemMetadata;
  let changed = false;

  if (job.kind === "video") {
    const probe = await probeVideo(job.path);
    if (probe.codec) { item.codec = probe.codec; changed = true; }
    if (probe.width && !item.width) { item.width = probe.width; item.height = probe.height; changed = true; }
    if (probe.duration && item.duration == null) { item.duration = probe.duration; changed = true; }
    if (!probe.codec && !probe.duration) {
      // 探针完全读不出：源文件损坏/不完整，标记后不再重复尝试
      item.probeFailed = true;
      changed = true;
    }
    const thumb = join(dirname(job.path), `${item.name}_thumbnail.png`);
    if (!existsSync(thumb)) {
      if (await makeVideoThumbnail(job.path, thumb, item.duration ?? probe.duration)) changed = true;
    }
    const needProxy = codecNeedsProxy(probe.codec);
    const proxyPath = join(dirname(job.path), `${item.name}_preview.mp4`);
    if (needProxy) {
      if (existsSync(proxyPath)) {
        // 历史轮次已生成代理但标志缺失：直接补标志，不重转
        if (!item.preview) { item.preview = true; changed = true; }
      } else if (await makeProxy(job.path, proxyPath, item.duration ?? probe.duration)) {
        item.preview = true;
        changed = true;
      }
    }
    if (!item.palettes?.length) {
      const src = item.preview && existsSync(proxyPath) ? proxyPath : job.path;
      const pal = await extractPalettes(src);
      if (pal?.length) { item.palettes = pal; changed = true; }
    }
  } else if (job.kind === "image") {
    const thumb = join(dirname(job.path), `${item.name}_thumbnail.png`);
    if (!["gif", "svg"].includes(job.ext) && !existsSync(thumb)) {
      if (await makeImageThumbnail(job.path, thumb)) changed = true;
    }
    if (!item.palettes?.length) {
      const pal = await extractPalettes(job.path);
      if (pal?.length) { item.palettes = pal; changed = true; }
    }
  } else if (job.kind === "audio") {
    const wave = join(dirname(job.path), `${item.name}_thumbnail.png`);
    if (!existsSync(wave)) {
      if (await makeWaveform(job.path, wave)) changed = true;
    }
    if (job.ext === "wav" && item.duration == null) {
      const d = probeWavDuration(job.path);
      if (d != null) { item.duration = d; changed = true; }
    }
  }

  if (changed) {
    const now = Date.now();
    item.modificationTime = now;
    item.lastModified = now;
    writeFileSync(join(dirname(job.path), "metadata.json"), JSON.stringify(item));
    indexItem(db, item, JSON.stringify(item));
  }
}
