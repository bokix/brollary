// stash 弹窗：枚举当前页大图 → 多选 → 批量入库。
const DEFAULTS = { port: 41596, tags: "" };
let items = [];

function parseTags(s) {
  return (s || "").split(",").map((t) => t.trim()).filter(Boolean);
}

async function cfg() {
  return { ...DEFAULTS, ...await chrome.storage.sync.get(DEFAULTS) };
}

// 注入页面执行的采集脚本：只取显示尺寸 ≥100px 的 http(s) 图片，按 URL 去重
function collectImages() {
  const seen = new Set();
  const out = [];
  for (const img of document.images) {
    const r = img.getBoundingClientRect();
    if (r.width < 100 || r.height < 100) continue;
    const src = img.currentSrc || img.src;
    if (!src || !/^https?:/i.test(src) || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, w: img.naturalWidth, h: img.naturalHeight });
  }
  return out;
}

async function addItem(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/item/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function nameFromSrc(src) {
  try {
    const base = decodeURIComponent(new URL(src).pathname.split("/").pop() || "");
    const m = base.replace(/\.[a-z0-9]{1,8}$/i, "");
    return m.slice(0, 80) || undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const { port, tags } = await cfg();
  document.getElementById("tags").value = tags || "";
  const list = document.getElementById("list");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectImages,
    });
    items = res.result ?? [];
  } catch {
    list.innerHTML = `<div class="empty">无法读取此页面（浏览器内置页/权限不足）</div>`;
    return;
  }

  if (!items.length) {
    list.innerHTML = `<div class="empty">本页没有找到 ≥100px 的图片</div>`;
    return;
  }

  list.innerHTML = items
    .map((it, i) =>
      `<label class="item"><input type="checkbox" checked data-i="${i}">
       <img src="${it.src}" referrerpolicy="no-referrer">
       <span class="meta">${it.w}×${it.h}<br>${new URL(it.src).hostname}</span></label>`)
    .join("");
}

document.getElementById("save").addEventListener("click", async () => {
  const { port } = await cfg();
  const tags = parseTags(document.getElementById("tags").value);
  const status = document.getElementById("status");
  const btn = document.getElementById("save");
  const checked = [...document.querySelectorAll("#list input:checked")]
    .map((el) => items[+el.dataset.i]);
  if (!checked.length) { status.textContent = "没有勾选任何图片"; return; }

  chrome.storage.sync.set({ tags: document.getElementById("tags").value });
  btn.disabled = true;
  let ok = 0;
  for (let i = 0; i < checked.length; i++) {
    status.textContent = `收集中 ${i + 1}/${checked.length}…`;
    try {
      const j = await addItem(port, {
        url: checked[i].src,
        website: (await chrome.tabs.query({ active: true, currentWindow: true }))[0].url,
        tags,
        name: nameFromSrc(checked[i].src),
      });
      if (j.status === "success") ok++;
    } catch { /* 单张失败继续下一张 */ }
  }
  status.textContent = `完成：成功 ${ok}/${checked.length}（应用窗口内可见）`;
  btn.disabled = false;
});

main();
