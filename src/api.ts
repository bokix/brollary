// 本地 HTTP API：任何本机程序的采集入口（浏览器扩展是它的第一个客户端）。
// 安全姿态：只绑 127.0.0.1；拒绝带网页 Origin 的请求（防浏览器 drive-by POST，
// 且不影响 curl/脚本/扩展——它们没有 http(s) Origin）。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { addFromPath, addFromUrl } from "./ingest.ts";
import { stats, listItems } from "./indexer.ts";

export interface ApiOptions {
  port: number;
  /** 每次请求时解析当前库（支持多库切换） */
  getContext: () => { db: DatabaseSync; libraryPath?: string };
  /** 采集成功后回调（媒体管线入队） */
  onIngested?: (id: string) => void;
  onLog?: (msg: string) => void;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "null", // 不开放浏览器跨域读取
  });
  res.end(json);
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function startApiServer(dbOrCtx: DatabaseSync | ApiOptions, opts?: ApiOptions) {
  const options: ApiOptions = typeof dbOrCtx === "object" && "getContext" in dbOrCtx
    ? dbOrCtx
    : { port: opts!.port, getContext: () => ({ db: dbOrCtx }), ...(opts ?? {}) };
  const log = options.onLog ?? (() => {});

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && /^https?:/i.test(origin)) {
      // 浏览器网页发起的跨源 POST：一律拒绝（防 drive-by 塞垃圾进库）
      send(res, 403, { status: "error", message: "拒绝网页来源的请求" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      // GET /api/ping —— 存活与握手
      if (req.method === "GET" && url.pathname === "/api/ping") {
        send(res, 200, { status: "success", name: "brollary", displayName: "Brollary 空镜库", version: "0.1.0" });
        return;
      }

      // GET /api/stats
      if (req.method === "GET" && url.pathname === "/api/stats") {
        send(res, 200, { status: "success", data: stats(options.getContext().db) });
        return;
      }

      // POST /api/item/add —— 兼容 .library 格式字段：url / name / tags / folder / annotation / path / website
      if (req.method === "POST" && url.pathname === "/api/item/add") {
        const ctx = options.getContext();
        if (!ctx.db || !ctx.libraryPath) {
          send(res, 409, { status: "error", message: "没有打开的库" });
          return;
        }
        const body = JSON.parse(await readBody(req)) as {
          url?: string; path?: string; website?: string; name?: string;
          tags?: string[] | string; folder?: string; annotation?: string;
        };
        const tags = Array.isArray(body.tags)
          ? body.tags
          : typeof body.tags === "string" && body.tags.length
            ? body.tags.split(",").map((t) => t.trim()).filter(Boolean)
            : [];
        const opts = {
          name: body.name,
          tags,
          folders: body.folder ? [body.folder] : undefined,
          url: body.website, // 来源页（provenance）；与下载地址 url 是两回事
          annotation: body.annotation,
        };

        let result;
        if (body.url) {
          result = await addFromUrl(ctx.db, ctx.libraryPath, body.url, opts);
        } else if (body.path) {
          result = addFromPath(ctx.db, ctx.libraryPath, body.path, opts);
        } else {
          send(res, 400, { status: "error", message: "需要 url 或 path 字段" });
          return;
        }
        if (result.ok && result.id) options.onIngested?.(result.id);
        send(res, result.ok ? 200 : 422, {
          status: result.ok ? "success" : "error",
          id: result.id,
          message: result.message,
        });
        return;
      }

      // GET /api/item/list —— 轻量列表（供第三方浏览）
      if (req.method === "GET" && url.pathname === "/api/item/list") {
        const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 50));
        const rows = listItems(options.getContext().db, {
          query: url.searchParams.get("q") ?? "",
          deleted: false,
          limit,
        });
        send(res, 200, { status: "success", data: rows });
        return;
      }

      send(res, 404, { status: "error", message: `未知路由 ${req.method} ${url.pathname}` });
    } catch (err) {
      log(`API 错误 ${req.method} ${url.pathname}: ${err instanceof Error ? err.message : err}`);
      send(res, 500, { status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  });

  return (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const port = options.port + attempt;
      try {
        await listenOnce(server, port);
        log(`API 就绪: http://127.0.0.1:${port}/api/ping`);
        return { port, close: () => server.close() };
      } catch (err) {
        lastError = err;
        log(`端口 ${port} 被占用，尝试下一个…`);
      }
    }
    throw lastError ?? new Error("API 端口监听失败");
  })();
}

function listenOnce(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}
