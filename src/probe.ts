// 媒体探针：纯实现（零依赖）读取图片尺寸与 JPEG EXIF 子集。
// 只解析头部结构，不完整解码——探针失败返回空对象，绝不猜测。
import { openSync, readSync, closeSync, fstatSync } from "node:fs";

export interface ImageProbe {
  width?: number;
  height?: number;
}

/** 从缓冲区前缀探测图片尺寸；无法识别返回 {} */
export function probeImage(buf: Buffer): ImageProbe {
  try {
    if (buf.length >= 24 && buf.subarray(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n") {
      // IHDR 固定在 8..24：长度(4) + 'IHDR' + 宽(4 BE) + 高(4 BE)
      if (buf.subarray(12, 16).toString("latin1") === "IHDR") {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      return {};
    }
    if (buf.length >= 10 && buf.subarray(0, 3).toString("latin1") === "GIF") {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      const w = buf.readInt32LE(18);
      const h = Math.abs(buf.readInt32LE(22));
      if (w > 0 && h > 0) return { width: w, height: h };
      return {};
    }
    if (buf.length >= 30 && buf.subarray(0, 4).toString("latin1") === "RIFF"
        && buf.subarray(8, 12).toString("latin1") === "WEBP") {
      return probeWebP(buf);
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      return probeJpegSize(buf);
    }
  } catch {
    // 结构异常 → 未知
  }
  return {};
}

function probeWebP(buf: Buffer): ImageProbe {
  const fourcc = buf.subarray(12, 16).toString("latin1");
  if (fourcc === "VP8X") {
    // 画布尺寸：24..29 三个 24bit（值-1），LE
    const w = 1 + buf.readUIntLE(24, 3);
    const h = 1 + buf.readUIntLE(27, 3);
    return { width: w, height: h };
  }
  if (fourcc === "VP8 ") {
    // 有损帧：26..27 宽、28..29 高（14bit，LE），从 0x9d012a 同步字后取
    if (buf.readUInt32LE(23) >>> 8 === 0x9d012a) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  if (fourcc === "VP8L") {
    // 无损：21 起的位流：14bit 宽-1、14bit 高-1
    const b = buf.readUInt32LE(21);
    const w = (b & 0x3fff) + 1;
    const h = ((b >> 14) & 0x3fff) + 1;
    return { width: w, height: h };
  }
  return {};
}

function probeJpegSize(buf: Buffer): ImageProbe {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    // SOF0..SOF15（除 DHT=0xC4、JPG=0xC8、DAC=0xCC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return {};
}

/** 读取文件头部前 maxBytes 用于探针 */
export function probeImageFile(path: string, maxBytes = 512 * 1024): ImageProbe {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = Math.min(fstatSync(fd).size, maxBytes);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return probeImage(buf);
  } catch {
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** WAV 时长（秒）：fmt 块 byteRate + data 块大小。非 WAV/结构异常返回 null */
export function probeWavDuration(path: string, maxBytes = 64 * 1024): number | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = Math.min(fstatSync(fd).size, maxBytes);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    if (buf.subarray(0, 4).toString("latin1") !== "RIFF"
        || buf.subarray(8, 12).toString("latin1") !== "WAVE") return null;
    let off = 12;
    let byteRate = 0;
    let dataLen = 0;
    while (off + 8 <= size) {
      const id = buf.subarray(off, off + 4).toString("latin1");
      const sz = buf.readUInt32LE(off + 4);
      if (id === "fmt ") byteRate = buf.readUInt32LE(off + 16); // fmt 数据第 9..12 字节
      if (id === "data") { dataLen = sz; break; }
      off += 8 + sz + (sz % 2);
    }
    if (byteRate > 0 && dataLen > 0) return Math.round((dataLen / byteRate) * 100) / 100;
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── JPEG EXIF 子集 ──────────────────────────────────────

export interface ExifData {
  make?: string;
  model?: string;
  dateTimeOriginal?: string;
  exposureTime?: string;   // "1/250"
  fNumber?: number;
  iso?: number;
  focalLength?: number;    // mm
  orientation?: number;
}

const IFD0_TAGS = {
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  exifIfd: 0x8769,
} as const;

const EXIF_IFD_TAGS = {
  exposureTime: 0x829a,
  fNumber: 0x829d,
  iso: 0x8827,
  dateTimeOriginal: 0x9003,
  focalLength: 0x920a,
} as const;

/** 解析 JPEG 的 EXIF（APP1/TIFF）常用字段；非 JPEG 或无 EXIF 返回 {} */
export function parseExifJpeg(buf: Buffer): ExifData {
  try {
    if (!(buf[0] === 0xff && buf[1] === 0xd8)) return {};
    // 找 APP1 段且以 "Exif\0\0" 开头
    let off = 2;
    let tiff = -1;
    while (off + 4 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xda) break; // SOS：后面是压缩数据
      if (marker === 0xe1) {
        if (buf.subarray(off + 4, off + 10).toString("latin1") === "Exif\x00\x00") {
          tiff = off + 10;
        }
        break;
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
    if (tiff < 0) return {};

    const le = buf.readUInt16LE(tiff) === 0x4949; // "II" 小端 / "MM" 大端
    const u16 = (p: number) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
    const u32 = (p: number) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));

    const out: ExifData = {};
    const ifd0 = u16(tiff + 4);
    const readIfdEntry = (base: number, i: number) => {
      const entry = base + 2 + i * 12;
      return {
        tag: u16(entry),
        type: u16(entry + 2),
        count: u32(entry + 4),
        valueOff: entry + 8,
      };
    };

    const readString = (e: ReturnType<typeof readIfdEntry>, base: number): string => {
      const size = ({ 2: 1, 7: 1 } as Record<number, number>)[e.type] * e.count;
      if (!size || size > 256) return "";
      const p = size <= 4 ? e.valueOff : base + u32(e.valueOff);
      return buf.subarray(p, p + size).toString("latin1").replace(/\0.*$/s, "").trim();
    };

    let exifIfdBase = 0;
    for (let i = 0; i < ifd0; i++) {
      const e = readIfdEntry(tiff + 8, i);
      if (e.tag === IFD0_TAGS.make) out.make = readString(e, tiff);
      else if (e.tag === IFD0_TAGS.model) out.model = readString(e, tiff);
      else if (e.tag === IFD0_TAGS.orientation) out.orientation = u16(e.valueOff);
      else if (e.tag === IFD0_TAGS.exifIfd) exifIfdBase = tiff + u32(e.valueOff);
    }

    if (exifIfdBase) {
      const n = u16(exifIfdBase);
      const readRational = (e: ReturnType<typeof readIfdEntry>): [number, number] => {
        const p = tiff + u32(e.valueOff);
        const num = u32(p);
        const den = u32(p + 4);
        return den ? [num, den] : [0, 1];
      };
      for (let i = 0; i < n; i++) {
        const e = readIfdEntry(exifIfdBase, i);
        if (e.tag === EXIF_IFD_TAGS.exposureTime) {
          const [num, den] = readRational(e);
          if (num > 0) {
            out.exposureTime = num >= den
              ? String(Math.round(num / den))
              : `1/${Math.round(den / num)}`;
          }
        } else if (e.tag === EXIF_IFD_TAGS.fNumber) {
          const [num, den] = readRational(e);
          if (den) out.fNumber = Math.round((num / den) * 10) / 10;
        } else if (e.tag === EXIF_IFD_TAGS.iso) {
          out.iso = u16(e.valueOff);
        } else if (e.tag === EXIF_IFD_TAGS.dateTimeOriginal) {
          out.dateTimeOriginal = readString(e, exifIfdBase).replace(/^(\d{4}):(\d\d):/, "$1-$2-");
        } else if (e.tag === EXIF_IFD_TAGS.focalLength) {
          const [num, den] = readRational(e);
          if (den) out.focalLength = Math.round(num / den);
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}
