#!/usr/bin/env node
// stash CLI — M1 验证工具：导入 .library、统计、检索。
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import {
  openAndHeal,
  importLibrary,
  stats,
  search,
  searchByColor,
  byTag,
  getItem,
  restoreItem,
} from "./indexer.ts";
import { scanDuplicates } from "./dedup.ts";

const DB_PATH =
  process.env.STASH_DB ?? join(homedir(), ".brollary", "index.db");

const [, , command, ...rest] = process.argv;

function fail(msg: string): never {
  console.error(`错误: ${msg}`);
  console.error("用法: stash import|stats|search|tag|show");
  process.exit(1);
}

function open() {
  mkdirSync(dirname(DB_PATH), { recursive: true }); // DatabaseSync 不会自建父目录
  return openAndHeal(DB_PATH);
}

function getLibraryPath(db: ReturnType<typeof openAndHeal>): string {
  const p = db.prepare("SELECT value FROM meta WHERE key='libraryPath'").get()?.value;
  if (!p) fail("索引为空，请先 import");
  return p as string;
}

switch (command) {
  case "import": {
    const lib = rest[0];
    if (!lib) fail("缺少库路径");
    const db = open();
    const s = importLibrary(db, lib);
    console.log(`库:        ${s.library}`);
    console.log(`条目导入:  ${s.imported}（损坏/跳过 ${s.malformed}）`);
    console.log(`回收站:    ${s.deleted}`);
    console.log(`标签引用:  ${s.tagCount}`);
    console.log(`文件夹:    ${s.folders}  智能文件夹: ${s.smartFolders}`);
    console.log(`耗时:      ${s.elapsedMs}ms  索引: ${DB_PATH}`);
    break;
  }
  case "stats": {
    const s = stats(open());
    console.log(`条目: ${s.items}（回收站 ${s.deleted}）`);
    console.log(
      `类型分布: ${s.byExt.map((e) => `${e.ext}×${e.n}`).join("  ")}`,
    );
    if (s.topTags.length)
      console.log(
        `常用标签: ${s.topTags.map((t) => `${t.tag}×${t.n}`).join("  ")}`,
      );
    if (s.smartFolders.length) {
      console.log("智能文件夹:");
      for (const sf of s.smartFolders)
        console.log(
          `  - ${sf.name}: ${sf.matchCount >= 0 ? sf.matchCount + " 条" : "含未支持的规则"}`,
        );
    }
    break;
  }
  case "search": {
    const q = rest[0];
    if (!q) fail("缺少搜索词");
    const rows = search(open(), q, 30);
    console.log(`“${q}” → ${rows.length} 条`);
    for (const r of rows)
      console.log(
        `  [${r.ext}] ${r.name}  (${r.width ?? "?"}×${r.height ?? "?"}${r.duration ? ` ${r.duration}s` : ""}) ${r.id}`,
      );
    break;
  }
  case "tag": {
    const t = rest[0];
    if (!t) fail("缺少标签名");
    const rows = byTag(open(), t, 30);
    console.log(`标签“${t}” → ${rows.length} 条`);
    for (const r of rows) console.log(`  [${r.ext}] ${r.name}  ${r.id}`);
    break;
  }
  case "show": {
    const id = rest[0];
    if (!id) fail("缺少条目 ID");
    const item = getItem(open(), id);
    if (!item) fail(`找不到条目 ${id}`);
    console.log(JSON.stringify(item, null, 2));
    break;
  }
  case "color": {
    // 用法: stash color <r>,<g>,<b>
    const [r, g, b] = (rest[0] ?? "").split(",").map(Number);
    if (![r, g, b].every((v) => Number.isFinite(v))) fail("用法: color <r>,<g>,<b>");
    const hits = searchByColor(open(), { r, g, b });
    console.log(`颜色 rgb(${r},${g},${b}) → ${hits.length} 条（按相似度）`);
    for (const h of hits.slice(0, 15))
      console.log(`  ${String(h.sim).padStart(3)}%  [${h.ext}] ${h.name}  ${h.id}`);
    break;
  }
  case "dedup": {
    const db = open();
    const lib = getLibraryPath(db);
    console.log("扫描重复文件…");
    scanDuplicates(db, lib, (done, total) => {
      if (done % 50 === 0 || done === total)
        process.stdout.write(`\r哈希 ${done}/${total}   `);
    }).then((res) => {
      process.stdout.write("\n");
      console.log(
        `候选 ${res.candidates}（新哈希 ${res.scanned}，缓存 ${res.cached}），重复组 ${res.groups.length}，浪费 ${fmtBytes(res.wastedBytes)}`,
      );
      for (const g of res.groups.slice(0, 10)) {
        console.log(`组 ${g.sha256.slice(0, 12)}… (${g.items.length} 份)`);
        for (const it of g.items) console.log(`  [${it.ext}] ${it.name}  ${it.id}`);
      }
    }).catch((e) => fail(String(e)));
    break;
  }
  case "restore": {
    const id = rest[0];
    if (!id) fail("缺少条目 ID");
    const r = restoreItem(open(), id);
    console.log(`${r.ok ? "✓" : "✕"} ${r.message}`);
    break;
  }
  default:
    fail(`未知命令 ${command ?? "(空)"}`);
}

function fmtBytes(n: number): string {
  return n > 1e9 ? (n / 1e9).toFixed(2) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : (n / 1e3).toFixed(0) + " KB";
}
