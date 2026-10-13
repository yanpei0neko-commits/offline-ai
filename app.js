// iPad Offline AI — メインスクリプト（ビルド不要・ES Modules）
const $ = (id) => document.getElementById(id);
const emptyChatEl = document.getElementById("emptyChat");
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const MAX_VRAM_MB = 3500;        // 一覧に出すモデルの上限（必要GPUメモリの推定値）
const MAX_CONVS = 30;
const SYSTEM_PROMPT = "あなたは親切で正確なAIアシスタントです。ユーザーが別の言語を使わない限り、日本語で簡潔に答えてください。";

let webllm = null;
let engine = null;
let worker = null;
let loadedModelId = null;
let loading = false;
let generating = false;
let cancelLoad = null;           // ダウンロード中止用
let lastTriedModel = null;
let convs = LS.get("ioa.convs", []);
let currentConvId = LS.get("ioa.currentConv", null);

/* ---------- 画面切り替え ---------- */
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "models") refreshModelLists();
  if (name === "status") refreshStatus();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.goto)));

function banner(text, isError = false) {
  const b = $("banner");
  if (!text) { b.classList.add("hidden"); return; }
  b.textContent = text;
  b.classList.toggle("error", isError);
  b.classList.remove("hidden");
}

/* ---------- エラーを分かりやすい日本語に ---------- */
function friendlyError(e) {
  const m = String((e && (e.message || e.name)) || e);
  if (/maxBufferSize|max.*buffer|exceeds? limit|binding size/i.test(m))
    return "このモデルはiPadのGPUが扱えるメモリ上限を超えています。\n対処：もっと小さいモデル（0.5B〜1B）を選んでください。\n（詳細：" + m + "）";
  if (/out of memory|OOM|device (was )?lost|memory/i.test(m))
    return "メモリが足りませんでした。\n対処：他のアプリやSafariのタブを閉じ、もっと小さいモデルを選んでください。\n（詳細：" + m + "）";
  if (/quota|storage.*full|no space/i.test(m))
    return "iPadの保存容量が足りません。\n対処：不要なモデルを削除するか、iPadの空き容量を増やしてください。\n（詳細：" + m + "）";
  if (/WebGPU|adapter|navigator\.gpu/i.test(m))
    return "このブラウザではWebGPUが使えません。\n対処：iPadOSを最新にして、Safariで開いてください（設定→Safari→詳細→機能フラグでWebGPUが無効でないかも確認）。\n（詳細：" + m + "）";
  if (/Failed to fetch|NetworkError|network|Load failed|offline|timeout/i.test(m))
    return "ネットワークに接続できませんでした。\n対処：Wi-Fiを確認して「再試行」を押してください。ダウンロード済みのファイルは再利用されます。\n（詳細：" + m + "）";
  if (/Cache|cache/i.test(m))
    return "モデルの保存（キャッシュ）に失敗しました。\n対処：容量を空けてから再試行してください。プライベートブラウズでは保存できないことがあります。\n（詳細：" + m + "）";
  return "エラーが発生しました。\n（詳細：" + m + "）";
}

/* ---------- 会話の保存と表示 ---------- */
function saveConvs() {
  if (convs.length > MAX_CONVS) convs = convs.slice(0, MAX_CONVS);
  LS.set("ioa.convs", convs);
  LS.set("ioa.currentConv", currentConvId);
}
function currentConv() {
  let c = convs.find((x) => x.id === currentConvId);
  if (!c) {
    c = { id: "c" + Date.now(), title: "新しい会話", ts: Date.now(), messages: [] };
    convs.unshift(c);
    currentConvId = c.id;
    saveConvs();
  }
  return c;
}
function renderConvSelect() {
  const sel = $("convSelect");
  sel.textContent = "";
  convs.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.title;
    if (c.id === currentConvId) o.selected = true;
    sel.appendChild(o);
  });
  sel.classList.toggle("hidden", convs.length === 0);
}
function renderMessages() {
  const box = $("messages");
  const c = convs.find((x) => x.id === currentConvId);
  box.textContent = "";
  if (!c || c.messages.length === 0) {
    box.appendChild(emptyChatEl);
    emptyChatEl.querySelector("p").textContent = loadedModelId
      ? "メッセージを入力して送信してください。"
      : "まず「モデル管理」で小さなモデルをダウンロードして読み込んでください。";
    return;
  }
  c.messages.forEach((m) => box.appendChild(msgEl(m)));
  box.scrollTop = box.scrollHeight;
}
function msgEl(m) {
  const d = document.createElement("div");
  d.className = "msg " + m.role + (m.error ? " err" : "");
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = m.role === "user" ? "あなた" : "AI";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = m.content;
  d.append(who, body);
  return d;
}
$("convSelect").addEventListener("change", (e) => {
  if (generating) return;
  currentConvId = e.target.value;
  saveConvs();
  renderMessages();
});
$("newChatBtn").addEventListener("click", () => {
  if (generating) return;
  const cur = convs.find((x) => x.id === currentConvId);
  if (cur && cur.messages.length === 0) return;
  currentConvId = null;
  currentConv();
  renderConvSelect();
  renderMessages();
});
$("clearBtn").addEventListener("click", () => {
  if (generating) return;
  if (!confirm("すべての会話履歴を消去します。よろしいですか？")) return;
  convs = [];
  currentConvId = null;
  saveConvs();
  renderConvSelect();
  renderMessages();
});

/* ---------- チャット（生成） ---------- */
function setGenUI(on) {
  generating = on;
  $("sendBtn").classList.toggle("hidden", on);
  $("stopBtn").classList.toggle("hidden", !on);
  $("input").disabled = on;
}
function trimHistory(msgs) {
  // コンテキスト超過を避けるため、直近の発言から約6000文字ぶんだけ送る
  const out = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    total += msgs[i].content.length;
    if (total > 6000 && out.length > 0) break;
    out.unshift({ role: msgs[i].role, content: msgs[i].content });
  }
  return out;
}
$("chatForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (generating || loading) return;
  const text = $("input").value.trim();
  if (!text) return;
  if (!engine) {
    banner("先にモデルを読み込んでください（「モデル管理」→「ダウンロードして読み込む」）。", true);
    return;
  }
  banner("");
  const c = currentConv();
  c.messages.push({ role: "user", content: text });
  if (c.messages.length === 1) c.title = text.slice(0, 24);
  c.ts = Date.now();
  const aiMsg = { role: "assistant", content: "" };
  c.messages.push(aiMsg);
  $("input").value = "";
  saveConvs();
  renderConvSelect();
  renderMessages();
  const bodyEl = $("messages").lastElementChild.querySelector(".body");
  bodyEl.textContent = "考え中…";
  setGenUI(true);
  const g = $("genStatus");
  g.classList.remove("hidden");
  g.textContent = "生成中…（停止ボタンで中断できます）";
  const t0 = performance.now();
  let n = 0;
  try {
    const history = trimHistory(c.messages.slice(0, -1));
    const stream = await engine.chat.completions.create({
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.7,
      max_tokens: 1024,
    });
    for await (const chunk of stream) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (d) {
        aiMsg.content += d;
        n++;
        bodyEl.textContent = aiMsg.content;
        const box = $("messages");
        box.scrollTop = box.scrollHeight;
        if (n % 8 === 0) g.textContent = "生成中… " + Math.round(aiMsg.content.length) + "文字";
      }
    }
    if (!aiMsg.content) { aiMsg.content = "（空の応答でした。もう一度送信してください）"; bodyEl.textContent = aiMsg.content; }
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    g.textContent = "完了（" + sec + "秒）";
  } catch (e) {
    const msg = friendlyError(e);
    aiMsg.content = (aiMsg.content ? aiMsg.content + "\n\n" : "") + "⚠️ " + msg;
    aiMsg.error = true;
    renderMessages();
    g.textContent = "エラーで停止しました";
  } finally {
    setGenUI(false);
    saveConvs();
    $("input").focus();
  }
});
$("stopBtn").addEventListener("click", async () => {
  try { if (engine) await engine.interruptGenerate(); } catch {}
  $("genStatus").textContent = "停止しました";
});
$("input").addEventListener("keydown", (e) => {
  // Cmd/Ctrl+Enter で送信（外付けキーボード用）
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("chatForm").requestSubmit(); }
});

/* ---------- モデル一覧 ---------- */
function candidateModels() {
  const list = (webllm && webllm.prebuiltAppConfig && webllm.prebuiltAppConfig.model_list) || [];
  return list
    .filter((m) => !/vision|embed|snowflake/i.test(m.model_id))
    .filter((m) => !m.model_type)                       // 0 = 通常のLLM
    .filter((m) => (m.vram_required_MB || 0) > 0 && m.vram_required_MB <= MAX_VRAM_MB)
    .sort((a, b) => a.vram_required_MB - b.vram_required_MB);
}
function jaNote(id) {
  if (/qwen/i.test(id)) return "日本語：比較的使える（Qwen系・未検証）";
  if (/gemma/i.test(id)) return "日本語：比較的使える（Gemma系・未検証）";
  if (/llama|smollm|phi|tinyllama/i.test(id)) return "日本語：弱め（英語向け・未検証）";
  return "日本語性能：未確認";
}
function fmtMB(mb) { return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB"; }

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
async function isCached(id) {
  try { return await withTimeout(webllm.hasModelInCache(id), 4000); } catch { return null; } // null = 確認できず
}
async function cachedMap(models) {
  const res = {};
  await Promise.all(models.map(async (m) => { res[m.model_id] = await isCached(m.model_id); }));
  return res;
}
function jaScore(id) {
  if (/qwen/i.test(id)) return 0;
  if (/gemma/i.test(id)) return 1;
  return 2;
}
let listSeq = 0;
async function refreshModelLists() {
  const seq = ++listSeq;
  const inst = $("installedList");
  const avail = $("availableList");
  try {
    if (!webllm) {
      inst.textContent = "";
      avail.textContent = "";
      $("listNote").textContent = "WebLLMを読み込めていません。オンラインでこのページを開き直してください。";
      return;
    }
    const models = candidateModels().sort((a, b) => jaScore(a.model_id) - jaScore(b.model_id) || a.vram_required_MB - b.vram_required_MB);
    $("listNote").textContent = "必要GPUメモリ " + fmtMB(MAX_VRAM_MB) + " 以下のモデルのみ表示。日本語に向くQwen系・Gemma系を上に並べています。ダウンロード容量はおおよその目安です。";
    // まず一覧をすぐ表示（保存状況の確認で止まっても一覧は見える）
    inst.textContent = "";
    avail.textContent = "";
    if (models.length === 0) {
      avail.textContent = "表示できるモデルがありません（WebLLMのモデル一覧が空です）。";
      return;
    }
    const ph = document.createElement("p");
    ph.className = "note";
    ph.textContent = "保存状況を確認中…";
    inst.appendChild(ph);
    models.forEach((m) => avail.appendChild(modelCard(m, false)));
    const cached = await cachedMap(models);
    if (seq !== listSeq) return;     // 新しい更新が始まっていたら捨てる
    inst.textContent = "";
    avail.textContent = "";
    const have = models.filter((m) => cached[m.model_id] === true);
    const unknown = models.some((m) => cached[m.model_id] === null);
    if (have.length === 0) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = unknown
        ? "保存状況を確認できませんでした（ブラウザの保存領域の応答がありません）。「状態・ヘルプ」の「アプリを初期化」を試してください。"
        : "まだダウンロード済みのモデルはありません。";
      inst.appendChild(p);
    }
    have.forEach((m) => inst.appendChild(modelCard(m, true)));
    models.filter((m) => cached[m.model_id] !== true).forEach((m) => avail.appendChild(modelCard(m, false)));
  } catch (e) {
    inst.textContent = "";
    avail.textContent = "";
    $("listNote").textContent = "一覧の表示でエラー：" + (e && e.message ? e.message : e) + "（「状態・ヘルプ」の「アプリを初期化」を試してください）";
  }
}
function modelCard(m, installed) {
  const div = document.createElement("div");
  div.className = "model";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = m.model_id;
  if (installed) { const b = document.createElement("span"); b.className = "badge ok"; b.textContent = "保存済み"; name.appendChild(b); }
  if (installed && loadedModelId === m.model_id) { const b = document.createElement("span"); b.className = "badge ok"; b.textContent = "使用中"; name.appendChild(b); }
  if (installed && LS.get("ioa.ok." + m.model_id, false) === false) { const b = document.createElement("span"); b.className = "badge warn"; b.textContent = "読み込み未確認"; name.appendChild(b); }
  const meta = document.createElement("div");
  meta.className = "meta";
  const dl = Math.round(m.vram_required_MB * 0.8);
  meta.textContent = "ダウンロード目安：約 " + fmtMB(dl) + "（概算） ／ 必要GPUメモリ（推定）：" + fmtMB(m.vram_required_MB) + "\n" + "推奨：RAMに余裕のあるiPad / 空き容量 " + fmtMB(dl * 1.3) + " 以上\n" + jaNote(m.model_id);
  meta.style.whiteSpace = "pre-line";
  const row = document.createElement("div");
  row.className = "row";
  const useBtn = document.createElement("button");
  useBtn.className = "big primary";
  useBtn.textContent = installed ? "このモデルを使う" : "ダウンロードして読み込む";
  useBtn.disabled = loading || generating;
  useBtn.addEventListener("click", () => loadModel(m.model_id));
  row.appendChild(useBtn);
  if (installed) {
    const del = document.createElement("button");
    del.className = "big danger-outline";
    del.textContent = "削除";
    del.disabled = loading || generating;
    del.addEventListener("click", () => deleteModel(m.model_id));
    row.appendChild(del);
  }
  div.append(name, meta, row);
  return div;
}

/* ---------- ダウンロード＆読み込み ---------- */
async function unloadEngine() {
  try { if (engine) await engine.unload(); } catch {}
  if (worker) { try { worker.terminate(); } catch {} }
  engine = null;
  worker = null;
  loadedModelId = null;
  updateCurrentLabel();
}
function updateCurrentLabel(extra) {
  $("currentModel").textContent = "モデル：" + (extra || loadedModelId || "未読み込み");
}
function showDl(title, pct, text) {
  $("dlPanel").classList.remove("hidden");
  $("dlTitle").textContent = title;
  $("dlBar").style.width = Math.max(0, Math.min(100, pct)) + "%";
  $("dlText").textContent = text || "";
}
async function storageCheck(m) {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      const need = m.vram_required_MB * 0.8 * 1024 * 1024 * 1.2;
      if (quota && usage != null && quota - usage < need) {
        return "保存できる容量が足りない可能性があります（空き約 " + fmtMB((quota - usage) / 1048576) + "、必要目安 " + fmtMB(need / 1048576) + "）。不要なモデルを削除してください。";
      }
    }
  } catch {}
  return null;
}
async function loadModel(id) {
  if (loading || generating) return;
  if (!webllm) { banner("WebLLMを読み込めていません。オンラインでページを開き直してください。", true); return; }
  if (!navigator.gpu) { showErr(friendlyError(new Error("WebGPU not available"))); return; }
  lastTriedModel = id;
  $("dlError").classList.add("hidden");
  const m = candidateModels().find((x) => x.model_id === id) || { vram_required_MB: 1000 };
  const warn = await storageCheck(m);
  if (warn) { showErr(warn); return; }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}

  loading = true;
  await unloadEngine();
  LS.set("ioa.loading", id);           // 読み込み中にSafariが落ちた場合の検出用
  updateCurrentLabel("読み込み中… " + id);
  showDl(id, 0, "準備中…");
  $("genStatus").classList.remove("hidden");
  $("genStatus").textContent = "モデルを読み込み中…（モデル管理画面で進捗を確認できます）";
  setBusyButtons(true);

  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker = w;
  const cancelP = new Promise((_, rej) => { cancelLoad = () => rej(new Error("__cancelled__")); });
  try {
    const eng = await Promise.race([
      webllm.CreateWebWorkerMLCEngine(w, id, {
        initProgressCallback: (p) => {
          const pct = (p.progress || 0) * 100;
          showDl(id, pct, (p.text || "") + "  (" + pct.toFixed(0) + "%)");
        },
      }),
      cancelP,
    ]);
    engine = eng;
    loadedModelId = id;
    LS.set("ioa.last", id);
    LS.set("ioa.ok." + id, true);
    showDl(id, 100, "読み込み完了。チャットで使えます。");
    setTimeout(() => $("dlPanel").classList.add("hidden"), 1500);
    banner("");
  } catch (e) {
    try { w.terminate(); } catch {}
    worker = null;
    engine = null;
    if (String(e && e.message) === "__cancelled__") {
      $("dlPanel").classList.add("hidden");
      showErr("ダウンロードをキャンセルしました。保存済みのファイルは再利用されるため、続きから再開できます（ファイル単位）。");
    } else {
      $("dlPanel").classList.add("hidden");
      showErr(friendlyError(e));
    }
  } finally {
    LS.del("ioa.loading");
    cancelLoad = null;
    loading = false;
    $("genStatus").classList.add("hidden");
    setBusyButtons(false);
    updateCurrentLabel();
    refreshModelLists();
    renderMessages();
  }
}
function showErr(text) {
  const e = $("dlError");
  e.textContent = "";
  const p = document.createElement("div");
  p.textContent = text;
  e.appendChild(p);
  if (lastTriedModel) {
    const b = document.createElement("button");
    b.className = "big";
    b.style.marginTop = "10px";
    b.textContent = "再試行";
    b.addEventListener("click", () => loadModel(lastTriedModel));
    e.appendChild(b);
  }
  e.classList.remove("hidden");
}
function setBusyButtons(busy) {
  document.querySelectorAll("#installedList button, #availableList button").forEach((b) => (b.disabled = busy));
}
$("cancelDlBtn").addEventListener("click", () => { if (cancelLoad) cancelLoad(); });

async function deleteModel(id) {
  if (!confirm(id + " を削除します。再び使うには再ダウンロードが必要です。よろしいですか？")) return;
  try {
    if (loadedModelId === id) await unloadEngine();
    await webllm.deleteModelAllInfoInCache(id);
    LS.del("ioa.ok." + id);
    if (LS.get("ioa.last", null) === id) LS.del("ioa.last");
  } catch (e) {
    showErr(friendlyError(e));
  }
  refreshModelLists();
  renderMessages();
}

/* ---------- 状態・オフライン準備チェック ---------- */
async function refreshStatus() {
  const rows = [];
  const add = (k, v) => rows.push([k, v]);
  add("ネット接続", navigator.onLine ? "オンライン" : "オフライン");
  add("HTTPS（安全な接続）", window.isSecureContext ? "✅ はい" : "❌ いいえ（Service Workerが使えません）");
  const standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  add("ホーム画面から起動", standalone ? "✅ はい" : "いいえ（Safariで表示中）");

  let gpuText = "❌ 使えません";
  if (navigator.gpu) {
    try {
      const ad = await navigator.gpu.requestAdapter();
      gpuText = ad ? "✅ 使えます（最大バッファ " + fmtMB(ad.limits.maxBufferSize / 1048576) + "）" : "❌ アダプターを取得できません";
    } catch (e) { gpuText = "❌ エラー：" + e.message; }
  }
  add("WebGPU", gpuText);
  add("WebLLM本体の読み込み", webllm ? "✅ 成功" : "❌ 失敗（オンラインで開き直してください）");

  let swOk = false, appN = 0, cdnN = 0;
  try {
    swOk = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    appN = (await (await caches.open("ioa-app-v2")).keys()).length;
    cdnN = (await (await caches.open("ioa-cdn-v1")).keys()).length;
  } catch {}
  add("Service Worker", swOk ? "✅ 有効" : "⚠️ まだ有効ではありません（ページを再読み込みしてください）");
  add("アプリ本体の保存", appN > 0 ? "✅ " + appN + " ファイル" : "❌ 未保存");
  add("WebLLM本体(JS)の保存", cdnN > 0 ? "✅ " + cdnN + " ファイル" : "❌ 未保存");

  let nModels = 0, okModels = 0;
  if (webllm) {
    const models = candidateModels();
    const cached = await cachedMap(models);
    models.forEach((m) => { if (cached[m.model_id] === true) { nModels++; if (LS.get("ioa.ok." + m.model_id, false)) okModels++; } });
  }
  add("保存済みモデル", nModels + " 個（うち読み込み成功済み " + okModels + " 個）");
  add("使用中モデル", loadedModelId || "なし");

  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      add("保存容量", "使用 " + fmtMB(usage / 1048576) + " ／ 上限目安 " + fmtMB(quota / 1048576));
    }
    if (navigator.storage && navigator.storage.persisted) {
      const p = await navigator.storage.persisted();
      add("保存データの保護", p ? "✅ 保護されています" : "⚠️ 未保護（容量不足時にSafariが削除する可能性）");
    }
  } catch {}

  const ready = swOk && appN > 0 && cdnN > 0 && okModels > 0;
  add("オフライン準備", ready ? "✅ 準備OK（機内モードで実際に起動して確認してください）" : "⚠️ 未完了：上の項目をすべて ✅ にしてください（モデルを1回読み込む必要があります）");

  const tbl = document.createElement("table");
  rows.forEach(([k, v]) => {
    const tr = document.createElement("tr");
    const a = document.createElement("td"); a.textContent = k;
    const b = document.createElement("td"); b.textContent = v;
    tr.append(a, b);
    tbl.appendChild(tr);
  });
  const box = $("statusTable");
  box.textContent = "";
  box.appendChild(tbl);
}
$("refreshStatusBtn").addEventListener("click", refreshStatus);
$("persistBtn").addEventListener("click", async () => {
  try {
    const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
    banner(ok ? "保存データの保護が有効になりました。" : "保護を許可されませんでした（ホーム画面に追加して使うと許可されやすくなります）。");
  } catch (e) { banner(friendlyError(e), true); }
  refreshStatus();
});

$("resetBtn").addEventListener("click", async () => {
  if (!confirm("このアプリの保存データ（ダウンロード済みモデル・会話履歴・設定）をすべて削除して初期化します。よろしいですか？")) return;
  try {
    if (navigator.serviceWorker) { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); }
    for (const k of await caches.keys()) await caches.delete(k);
    localStorage.clear();
  } catch (e) { console.warn(e); }
  location.reload();
});
window.addEventListener("unhandledrejection", (e) => { console.warn("unhandled", e.reason); });

/* ---------- 起動 ---------- */
async function init() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch (e) { console.warn("SW登録失敗", e); }
  } else {
    banner("このページはHTTPSで開かれていないため、オフライン保存（Service Worker）が使えません。HTTPSで公開したURLを開いてください。", true);
  }
  try {
    webllm = await import("./webllm-url.js");
  } catch (e) {
    banner("AIエンジン(WebLLM)を読み込めませんでした。初回はインターネットに接続して開いてください。（" + (e.message || e) + "）", true);
  }
  currentConv();
  renderConvSelect();
  renderMessages();
  updateCurrentLabel();

  const crashed = LS.get("ioa.loading", null);
  if (crashed) {
    LS.del("ioa.loading");
    LS.del("ioa.last");
    banner("前回「" + crashed + "」の読み込み中にページが終了しました。メモリ不足の可能性が高いので、もっと小さいモデルを選んでください。", true);
    showView("models");
    return;
  }
  // 前回使ったモデルが保存済みなら自動で読み込む
  const last = LS.get("ioa.last", null);
  if (webllm && navigator.gpu && last) {
    try {
      if (await webllm.hasModelInCache(last)) { loadModel(last); return; }
      banner("前回のモデルが端末から見つかりません（ブラウザが削除した可能性）。「モデル管理」から再ダウンロードしてください。", true);
      LS.del("ioa.last");
    } catch {}
  } else if (!navigator.gpu) {
    banner("このブラウザではWebGPUが使えません。iPadOS 26以降のSafariで開いてください。", true);
  }
}
init();
