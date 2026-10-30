const DEFAULTS = { port: 41596, tags: "" };

(async () => {
  const cfg = { ...DEFAULTS, ...await chrome.storage.sync.get(DEFAULTS) };
  document.getElementById("port").value = cfg.port;
  document.getElementById("tags").value = cfg.tags;
})();

document.getElementById("save").addEventListener("click", async () => {
  const port = Number(document.getElementById("port").value) || DEFAULTS.port;
  const tags = document.getElementById("tags").value.trim();
  await chrome.storage.sync.set({ port, tags });
  const s = document.getElementById("status");
  s.textContent = "✓ 已保存";
  setTimeout(() => (s.textContent = ""), 1500);
});
