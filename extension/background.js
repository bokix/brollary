// stash 扩展后台：右键菜单采集 + 角标反馈。
const DEFAULTS = { port: 41596, tags: "" };

async function cfg() {
  return { ...DEFAULTS, ...await chrome.storage.sync.get(DEFAULTS) };
}

function flash(text) {
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
}

function parseTags(s) {
  return (s || "").split(",").map((t) => t.trim()).filter(Boolean);
}

async function addItem({ url, website, tags, name, annotation }) {
  const { port } = await cfg();
  const res = await fetch(`http://127.0.0.1:${port}/api/item/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, website, tags, name, annotation }),
  });
  return res.json();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "stash-save-image",
    title: "收藏到 Brollary",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "stash-save-image" || !info.srcUrl) return;
  const { tags } = await cfg();
  try {
    const j = await addItem({
      url: info.srcUrl,
      website: info.pageUrl,
      tags: parseTags(tags),
    });
    flash(j.status === "success" ? "✓" : "✗");
  } catch {
    flash("✗");
  }
});

// popup 与 background 共用的采集函数（挂在全局供 popup import? MV3 不方便，popup 自行实现）
