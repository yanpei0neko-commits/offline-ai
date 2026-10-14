// 実験ページ：wllama（llama.cpp + WebGPU）をiPadで試す。ビルド不要。
const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const JSPI_FN = WebAssembly.Suspending;   // 元の値を保存（互換モード強制で一時的に隠すため）
const HAS_JSPI = typeof JSPI_FN === "function";
const CDN = (v) => "https://cdn.jsdelivr.net/npm/@wllama/wllama@" + v + "/esm/index.js";
const WASM = (v) => "https://cdn.jsdelivr.net/npm/@wllama/wllama@" + v + "/esm/wasm/wllama.wasm";
const HFQ = "https://huggingface.co/Qwen/";
const PRESETS = [
  { label: "Qwen2.5-0.5B q4_k_m（約0.4GB・最軽量）", url: HFQ + "Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf" },
  { label: "Qwen2.5-1.5B q4_k_m（約1.1GB）", url: HFQ + "Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf" },
  { label: "Qwen2.5-3B q4_k_m（約2.1GB・重い／非商用ライセンス）", url: HFQ + "Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" },
  { label: "自分で入力", url: "" },
];
const BENCH_PROMPT = "日本の四季について、それぞれ一文で説明してください。";

let mod = null, modVer = null;
let wl = null;
let busy = false;
let abortCtl = null;
let loadTimer = null;
const R = { env: [], settings: null, loadMs: null, loadErr: null, ttft: null, tps: null, chars: 0, chunks: 0, timings: null, ctxInfo: null, chatErr: null, loadedUrl: null };

/* ---------- ログ（クラッシュしても残るように保存） ---------- */
let logLines = LS.get("lab.log", []);
function log(msg) {
  const t = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  logLines.push("[" + t + "] " + msg);
  if (logLines.length > 250) logLines = logLines.slice(-250);
  LS.set("lab.log", logLines);
  const el = $("log");
  el.textContent = logLines.join("\n");
  el.scrollTop = el.scrollHeight;
}
function fmtB(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : Math.round(n / 1048576) + " MB"; }

/* ---------- 端末の状態 ---------- */
async function showEnv() {
  const rows = [];
  const add = (k, v) => rows.push([k, v]);
  add("ブラウザ", navigator.userAgent);
  add("HTTPS", window.isSecureContext ? "はい" : "いいえ");
  add("ホーム画面から起動", (navigator.standalone === true || matchMedia("(display-mode: standalone)").matches) ? "はい" : "いいえ（Safari）");
  add("オンライン", navigator.onLine ? "はい" : "いいえ");
  let gpu = "なし";
  if (navigator.gpu) {
    try {
      const ad = await navigator.gpu.requestAdapter();
      if (ad) {
        const f = [...ad.features].sort().join(", ") || "（なし）";
        gpu = "あり ／ 最大バッファ " + fmtB(ad.limits.maxBufferSize) + " ／ ストレージバインド上限 " + fmtB(ad.limits.maxStorageBufferBindingSize);
        add("GPU機能", f);
        const info = ad.info || {};
        if (info.vendor || info.architecture) add("GPU情報", (info.vendor || "") + " " + (info.architecture || ""));
      } else gpu = "アダプターなし";
    } catch (e) { gpu = "エラー：" + e.message; }
  }
  add("WebGPU", gpu);
  add("JSPI（高速な非同期）", HAS_JSPI ? "対応" : "非対応");
  let m64 = "非対応";
  try { if (WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]))) m64 = "対応"; } catch {}
  add("MEMORY64（4GB超メモリ）", m64);
  add("→ 互換モードが必要か（実際）", (HAS_JSPI && m64 === "対応") ? "不要" : "必要（Safariはこちら）");
  add("複数スレッド（COOP/COEP）", self.crossOriginIsolated ? "可" : "不可（1スレッド）");
  add("CPUコア数", String(navigator.hardwareConcurrency || "?"));
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      add("保存容量", "使用 " + fmtB(usage) + " ／ 上限目安 " + fmtB(quota));
    }
    if (navigator.storage && navigator.storage.persisted) add("保存データの保護", (await navigator.storage.persisted()) ? "保護済み" : "未保護");
  } catch {}
  R.env = rows;
  const tbl = document.createElement("table");
  rows.forEach(([k, v]) => {
    const tr = document.createElement("tr");
    const a = document.createElement("td"); a.textContent = k;
    const b = document.createElement("td"); b.textContent = v;
    tr.append(a, b); tbl.appendChild(tr);
  });
  const box = $("envTable"); box.textContent = ""; box.appendChild(tbl);
}

/* ---------- 設定 ---------- */
function settings() {
  const isCustom = $("preset").selectedIndex === PRESETS.length - 1;
  const ngl = $("ngl").value;
  return {
    url: (isCustom ? $("url").value.trim() : PRESETS[$("preset").selectedIndex].url),
    nctx: parseInt($("nctx").value, 10),
    ngl: ngl === "all" ? null : parseInt(ngl, 10),
    compat: $("compat").value,
    ver: $("ver").value,
  };
}
function initSettings() {
  PRESETS.forEach((p, i) => { const o = document.createElement("option"); o.value = i; o.textContent = p.label; $("preset").appendChild(o); });
  const s = LS.get("lab.settings", null);
  if (s) {
    const i = PRESETS.findIndex((p) => p.url === s.url);
    $("preset").selectedIndex = i >= 0 ? i : PRESETS.length - 1;
    if (i < 0) $("url").value = s.url || "";
    $("nctx").value = String(s.nctx);
    $("ngl").value = s.ngl === null ? "all" : String(s.ngl);
    $("compat").value = s.compat;
    $("ver").value = s.ver;
  }
  const upd = () => { $("url").disabled = $("preset").selectedIndex !== PRESETS.length - 1; };
  $("preset").addEventListener("change", upd); upd();
}

/* ---------- 互換モードの強制 ---------- */
// wllamaは「JSPIとMEMORY64が使えるか」で通常版／互換版を選ぶが、iPad Safariでは
// MEMORY64を誤って「使える」と判定し、動かない通常版を読み込んでしまう。
// そこでJSPIを一時的に隠し、互換版が選ばれるようにする。
function isSafariUA() {
  const u = navigator.userAgent;
  return /Version\/[0-9._]+.*Safari/.test(u) && !/Chrome|Chromium|Edg|Firefox/.test(u);
}
function applyCompatPatch(s) {
  const force = s.compat === "force" || (s.compat === "auto" && isSafariUA());
  try {
    if (force) {
      if (typeof WebAssembly.Suspending !== "undefined") {
        Object.defineProperty(WebAssembly, "Suspending", { value: undefined, configurable: true, writable: true });
      }
      log("互換モードを強制します（JSPIを無効に見せる）");
    } else if (JSPI_FN && typeof WebAssembly.Suspending === "undefined") {
      Object.defineProperty(WebAssembly, "Suspending", { value: JSPI_FN, configurable: true, writable: true });
      log("JSPIを元に戻しました");
    }
  } catch (e) { log("互換モードの強制に失敗: " + e.message); }
  return force;
}

/* ---------- ライブラリ ---------- */
async function getLib(ver) {
  if (mod && modVer === ver) return mod;
  log("ライブラリ読み込み: wllama " + ver);
  mod = await import(CDN(ver));
  modVer = ver;
  return mod;
}
function makeWl(m, s) {
  const logger = {
    debug() {},
    log: (...a) => log("wllama: " + a.join(" ").slice(0, 300)),
    warn: (...a) => log("wllama警告: " + a.join(" ").slice(0, 300)),
    error: (...a) => log("wllamaエラー: " + a.join(" ").slice(0, 400)),
  };
  const w = new m.Wllama({ default: WASM(s.ver) }, { allowOffline: true, parallelDownloads: 3, logger });
  if (typeof w.setCompat === "function") {
    if (s.compat === "off") w.setCompat(null);
    else w.setCompat("default", "safari");
  }
  return w;
}

/* ---------- 読み込み／解放 ---------- */
const seenRes = new Set();
function newRes() {
  try {
    return performance.getEntriesByType("resource")
      .filter((e) => /jsdelivr|huggingface|\.hf\.co|xethub/.test(e.name) && !seenRes.has(e.name))
      .map((e) => { seenRes.add(e.name); return e.name.split("?")[0].split("/").slice(-2).join("/") + "(" + Math.round(e.duration) + "ms," + Math.round((e.transferSize || 0) / 1024) + "KB)"; });
  } catch { return []; }
}
function setLoadState(t) { $("loadState").textContent = t; }
async function unload() {
  if (wl) { try { await wl.exit(); } catch (e) { log("解放時の警告: " + (e && e.message)); } }
  wl = null;
}
async function loadModel() {
  if (busy) return;
  const s = settings();
  if (!s.url || !/^https:\/\/.+\.gguf(\?.*)?$/i.test(s.url)) { setLoadState("URLが正しくありません（https:// から始まり .gguf で終わる必要があります）"); return; }
  busy = true; setBtns();
  LS.set("lab.settings", s);
  LS.set("lab.loading", s);
  R.settings = s; R.loadMs = null; R.loadErr = null; R.ttft = null; R.tps = null; R.ctxInfo = null; R.chatErr = null;
  $("dlBar").style.width = "0%";
  try {
    await unload();
    setLoadState("ライブラリを読み込み中…");
    const m = await getLib(s.ver);
    applyCompatPatch(s);
    wl = makeWl(m, s);
    try { log("WebGPU対応(wllama判定): " + (typeof wl.isSupportWebGPU === "function" ? wl.isSupportWebGPU() : "不明")); } catch {}
    log("読み込み開始: " + s.url.split("/").pop() + " n_ctx=" + s.nctx + " gpu層=" + (s.ngl === null ? "すべて" : s.ngl) + " 互換=" + s.compat);
    setLoadState("モデルを読み込み中…（ダウンロード済みなら保存から読みます）");
    const t0 = performance.now();
    let lastStep = -1, done100 = false;
    const hb = setInterval(() => {
      const sec = Math.round((performance.now() - t0) / 1000);
      const nr = newRes();
      log("経過 " + sec + "秒・読み込み中" + (done100 ? "（ダウンロード完了後の展開中）" : "") + (nr.length ? " 取得: " + nr.join(", ") : ""));
      if (done100) setLoadState("ダウンロード完了。モデルを展開中…（" + sec + "秒経過）" + (sec > 60 ? " ※60秒以上止まっています。ページを開き直し、下の「結果をまとめてコピー」で状況を送ってください。" : ""));
    }, 5000);
    loadTimer = hb;
    const params = {
      n_ctx: s.nctx,
      useCache: true,
      progressCallback: ({ loaded, total }) => {
        const pct = total ? (loaded / total) * 100 : 0;
        if (total && loaded >= total && !done100) { done100 = true; log("ダウンロード100%。モデルの展開を開始"); }
        $("dlBar").style.width = pct.toFixed(1) + "%";
        setLoadState("ダウンロード " + fmtB(loaded) + " / " + (total ? fmtB(total) : "?") + "（" + pct.toFixed(0) + "%）");
        const step = Math.floor(pct / 10);
        if (step !== lastStep) { lastStep = step; log("ダウンロード " + pct.toFixed(0) + "%"); }
      },
    };
    if (s.ngl !== null) params.n_gpu_layers = s.ngl;
    await wl.loadModelFromUrl(s.url, params);
    R.loadMs = Math.round(performance.now() - t0);
    R.loadedUrl = s.url;
    $("dlBar").style.width = "100%";
    setLoadState("読み込み完了（" + (R.loadMs / 1000).toFixed(1) + "秒）。会話テストへ進めます。");
    log("読み込み完了 " + (R.loadMs / 1000).toFixed(1) + "秒");
    try {
      const info = typeof wl.getLoadedContextInfo === "function" ? wl.getLoadedContextInfo() : null;
      R.ctxInfo = info ? JSON.stringify(info).slice(0, 700) : null;
      if (R.ctxInfo) log("モデル情報: " + R.ctxInfo);
    } catch {}
  } catch (e) {
    R.loadErr = (e && (e.name + ": " + e.message)) || String(e);
    log("読み込み失敗: " + R.loadErr);
    if (e && e.stack) log(String(e.stack).split("\n").slice(0, 3).join(" | "));
    setLoadState("失敗：" + R.loadErr);
  } finally {
    if (loadTimer) { clearInterval(loadTimer); loadTimer = null; }
    LS.del("lab.loading");
    busy = false; setBtns();
    refreshCache(); showEnv();
  }
}
async function exitModel() {
  if (busy) return;
  await unload();
  setLoadState("解放しました（未読み込み）");
  log("解放");
  showEnv();
}

/* ---------- 会話テスト ---------- */
async function runChat(prompt, maxTokens) {
  if (busy) return;
  if (!wl || !wl.isModelLoaded || !wl.isModelLoaded()) { $("stats").textContent = "先にモデルを読み込んでください。"; return; }
  const ac = new AbortController(); abortCtl = ac;
  busy = true; setBtns();
  LS.set("lab.generating", true);
  const out = $("out"); out.textContent = "";
  R.ttft = null; R.tps = null; R.chars = 0; R.chunks = 0; R.timings = null; R.chatErr = null;
  const t0 = performance.now();
  let raf = 0, text = "";
  const paint = () => { raf = 0; out.textContent = text; };
  log("生成開始: " + prompt.slice(0, 30));
  try {
    const stream = await wl.createChatCompletion({
      messages: [{ role: "user", content: prompt }],
      stream: true, abortSignal: ac.signal,
      max_tokens: maxTokens, temperature: 0.5, top_p: 0.9,
    });
    for await (const ch of stream) {
      const d = ch.choices && ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content;
      if (d) {
        if (R.ttft === null) R.ttft = Math.round(performance.now() - t0);
        text += d; R.chunks++;
        if (!raf) raf = requestAnimationFrame(paint);
      }
      if (ch.timings) R.timings = ch.timings;
    }
  } catch (e) {
    const name = (e && e.name) || "";
    if (/abort/i.test(name) || ac.signal.aborted) { log("生成を停止しました"); }
    else { R.chatErr = name + ": " + ((e && e.message) || e); log("生成エラー: " + R.chatErr); }
  } finally {
    if (raf) cancelAnimationFrame(raf);
    paint();
    const total = performance.now() - t0;
    R.chars = text.length;
    if (R.ttft !== null && R.chunks > 1) R.tps = +(((R.chunks - 1) / ((total - R.ttft) / 1000))).toFixed(2);
    $("stats").textContent = "最初の文字まで " + (R.ttft === null ? "－" : (R.ttft / 1000).toFixed(2) + "秒")
      + " ／ 速さ 約 " + (R.tps === null ? "－" : R.tps) + " トークン/秒 ／ " + R.chars + "文字 ／ 合計 " + (total / 1000).toFixed(1) + "秒"
      + (R.chatErr ? " ／ エラー：" + R.chatErr : "");
    log("生成終了 " + (total / 1000).toFixed(1) + "秒 ttft=" + R.ttft + "ms tps=" + R.tps + (R.timings ? " timings=" + JSON.stringify(R.timings).slice(0, 200) : ""));
    LS.del("lab.generating");
    abortCtl = null; busy = false; setBtns();
  }
}

/* ---------- 保存されているモデル ---------- */
async function refreshCache() {
  const box = $("cacheList");
  try {
    if (!mod) {
      try { await getLib(settings().ver); }
      catch { box.textContent = "ライブラリを読み込めないため一覧を表示できません（初回はオンラインで開いてください）。"; return; }
    }
    const w = wl || (wl = makeWl(mod, settings()));
    const models = await w.modelManager.getModels();
    box.textContent = "";
    if (!models.length) { box.textContent = "保存されているモデルはありません。"; return; }
    models.forEach((m) => {
      const row = document.createElement("div"); row.className = "crow";
      const t = document.createElement("span");
      const name = String(m.url || m.name || "").split("/").pop();
      t.textContent = name + "（" + (m.size >= 0 ? fmtB(m.size) : "削除済み") + "）";
      const b = document.createElement("button"); b.className = "small danger-outline"; b.textContent = "削除";
      b.addEventListener("click", async () => { try { await m.remove(); log("削除: " + name); } catch (e) { log("削除失敗: " + e.message); } refreshCache(); showEnv(); });
      row.append(t, b); box.appendChild(row);
    });
  } catch (e) { box.textContent = "一覧を取得できませんでした：" + (e && e.message); }
}
async function clearCache() {
  if (busy || !mod) return;
  if (!confirm("保存されているモデルをすべて削除します。よろしいですか？")) return;
  try { const w = wl || (wl = makeWl(mod, settings())); await w.modelManager.clear(); log("すべて削除"); } catch (e) { log("削除失敗: " + e.message); }
  refreshCache(); showEnv();
}

/* ---------- 結果レポート ---------- */
function buildReport() {
  const s = R.settings || settings();
  const L = [];
  L.push("【実験ページ結果】 " + new Date().toLocaleString("ja-JP"));
  L.push("wllama " + s.ver + " ／ モデル " + String(s.url).split("/").pop() + " ／ n_ctx " + s.nctx + " ／ GPU層 " + (s.ngl === null ? "すべて" : s.ngl) + " ／ 互換 " + s.compat);
  L.push("読み込み時間: " + (R.loadMs === null ? "－" : (R.loadMs / 1000).toFixed(1) + "秒") + (R.loadErr ? " ／ 失敗: " + R.loadErr : ""));
  L.push("最初の文字まで: " + (R.ttft === null ? "－" : R.ttft + "ms") + " ／ 速さ: " + (R.tps === null ? "－" : R.tps + " トークン/秒") + " ／ " + R.chars + "文字" + (R.chatErr ? " ／ 生成エラー: " + R.chatErr : ""));
  if (R.timings) L.push("timings: " + JSON.stringify(R.timings).slice(0, 300));
  if (R.ctxInfo) L.push("モデル情報: " + R.ctxInfo);
  L.push("--- 端末 ---");
  R.env.forEach(([k, v]) => L.push(k + ": " + v));
  L.push("--- ログ（直近） ---");
  L.push(logLines.slice(-40).join("\n"));
  return L.join("\n");
}
async function copyReport() {
  const t = buildReport();
  const ta = $("report"); ta.value = t;
  try { await navigator.clipboard.writeText(t); log("結果をコピーしました"); }
  catch { ta.removeAttribute("readonly"); ta.focus(); ta.select(); try { document.execCommand("copy"); } catch {} ta.setAttribute("readonly", ""); log("手動でコピーしてください（枠内を長押し→すべてを選択→コピー）"); }
}

/* ---------- ボタン ---------- */
function setBtns() {
  ["loadBtn", "exitBtn", "sendBtn", "benchBtn", "cacheClearBtn"].forEach((id) => ($(id).disabled = busy));
  $("stopBtn").classList.toggle("hidden", !abortCtl);
  $("stopBtn").disabled = false;
}
$("loadBtn").addEventListener("click", loadModel);
$("exitBtn").addEventListener("click", exitModel);
$("sendBtn").addEventListener("click", () => { const p = $("prompt").value.trim(); if (p) runChat(p, 256); });
$("benchBtn").addEventListener("click", () => { $("prompt").value = BENCH_PROMPT; runChat(BENCH_PROMPT, 96); });
$("stopBtn").addEventListener("click", () => { if (abortCtl) abortCtl.abort(); });
$("cacheBtn").addEventListener("click", refreshCache);
$("cacheClearBtn").addEventListener("click", clearCache);
$("envBtn").addEventListener("click", showEnv);
$("reportBtn").addEventListener("click", copyReport);
$("logClearBtn").addEventListener("click", () => { logLines = []; LS.set("lab.log", []); $("log").textContent = ""; });
window.addEventListener("unhandledrejection", (e) => log("未処理エラー: " + ((e.reason && e.reason.message) || e.reason)));

/* ---------- 起動 ---------- */
(async function init() {
  initSettings();
  if ("serviceWorker" in navigator && window.isSecureContext) { try { await navigator.serviceWorker.register("./sw.js"); } catch {} }
  $("log").textContent = logLines.join("\n");
  const lo = LS.get("lab.loading", null), ge = LS.get("lab.generating", false);
  if (lo || ge) {
    LS.del("lab.loading"); LS.del("lab.generating");
    const box = $("crashBox");
    box.textContent = (lo ? "前回、モデルの読み込み中にページが終了しました。" : "前回、返答の生成中にページが終了しました。")
      + "メモリ不足の可能性が高いです。設定" + (lo ? "（" + String(lo.url).split("/").pop() + "、n_ctx " + lo.nctx + "）" : "") + "を軽くして試してください。ログは下にあります。";
    box.classList.remove("hidden");
    log("★前回ページが終了していました（" + (lo ? "読み込み中" : "生成中") + "）");
  }
  setBtns();
  await showEnv();
  refreshCache();
})();
