// 沙盒 preload：只暴露白名单 IPC，不透传 ipcRenderer。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stash", {
  list: (filter) => ipcRenderer.invoke("api:list", filter),
  listSmart: (id) => ipcRenderer.invoke("api:listSmart", id),
  stats: () => ipcRenderer.invoke("api:stats"),
  detail: (id) => ipcRenderer.invoke("api:detail", id),
  openOriginal: (id) => ipcRenderer.invoke("api:openOriginal", id),
  showInFinder: (id) => ipcRenderer.invoke("api:showInFinder", id),
  restore: (id) => ipcRenderer.invoke("api:restore", id),
  setTags: (id, tags) => ipcRenderer.invoke("api:setTags", { id, tags }),
  allTags: () => ipcRenderer.invoke("api:allTags"),
  dedupTrash: (ids) => ipcRenderer.invoke("api:dedupTrash", ids),
  colors: (q) => ipcRenderer.invoke("api:colors", q),
  dedupScan: () => ipcRenderer.invoke("api:dedupScan"),
  onDedupProgress: (cb) => ipcRenderer.on("dedup:progress", (_e, p) => cb(p)),
  // 库生命周期
  libList: () => ipcRenderer.invoke("lib:list"),
  libCreate: (name, dir) => ipcRenderer.invoke("lib:create", { name, dir }),
  libAddExisting: (path, name) => ipcRenderer.invoke("lib:addExisting", { path, name }),
  libOpen: (id) => ipcRenderer.invoke("lib:open", { id }),
  libRemove: (id) => ipcRenderer.invoke("lib:remove", { id }),
  pickDirectory: () => ipcRenderer.invoke("lib:pickDirectory"),
  pickLibrary: () => ipcRenderer.invoke("lib:pickLibrary"),
  importFolder: (dir) => ipcRenderer.invoke("lib:importFolder", { dir }),
  pickFiles: () => ipcRenderer.invoke("lib:pickFiles"),
  importFiles: (paths) => ipcRenderer.invoke("lib:importFiles", { paths }),
  onImportProgress: (cb) => ipcRenderer.on("import:progress", (_e, p) => cb(p)),
  onMediaUpdated: (cb) => ipcRenderer.on("media:updated", (_e, id) => cb(id)),
  onLibraryChanged: (cb) => ipcRenderer.on("library:changed", () => cb()),
});
