// 最小プリロード（contextIsolation 有効・renderer からは Node API を露出しない）。
// Web UI は ws://127.0.0.1:<port>/ws と /api で通信するため、追加 API は不要。
"use strict";
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true
});
