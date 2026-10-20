// GGUFエンジン（wllama = llama.cpp + WebGPU）。メインアプリ用ラッパー（v7.1）
// ・iPad Safariでは「互換モード」を強制（通常版は読み込みで固まるため）
// ・落ちにくさ優先：会話の長さ・出力の長さを小さく固定、停止後/無反応後は自動で再準備
const VER = "3.8.1";
const CDN = "https://cdn.jsdelivr.net/npm/@wllama/wllama@" + VER + "/esm/index.js";
const WASM = "https://cdn.jsdelivr.net/npm/@wllama/wllama@" + VER + "/esm/wasm/wllama.wasm";
const HFQ = "https://huggingface.co/Qwen/";
const HFG = "https://huggingface.co/bartowski/gemma-2-2b-jpn-it-GGUF/resolve/main/";

// ctx=会話の長さ(トークン), maxOut=1回の返答の最大トークン。重いほど小さくして落ちにくくしている。
export const GGUF_MODELS = [
  { key: "gemma2-jpn-q4km", name: "Gemma-2-2B 日本語版 Q4_K_M（GGUF）", dlMB: 1750, ctx: 1024, maxOut: 192, noSystem: true, speed: "遅め（未検証・1〜2トークン/秒の見込み）", note: "日本語向けに追加学習されたGoogleのモデル。標準画質（Q4）。本命。",
    url: HFG + "gemma-2-2b-jpn-it-Q4_K_M.gguf" },
  { key: "gemma2-jpn-iq3m", name: "Gemma-2-2B 日本語版 IQ3_M・小さめ（GGUF）", dlMB: 1420, ctx: 1024, maxOut: 192, noSystem: true, speed: "遅め（未検証）", note: "約20%小さいが、圧縮が強いぶん少し精度が落ちます。Q4が落ちるときの代替。",
    url: HFG + "gemma-2-2b-jpn-it-IQ3_M.gguf" },
  { key: "qwen25-05b", name: "Qwen2.5-0.5B（GGUF）", dlMB: 400, ctx: 2048, maxOut: 320, speed: "速い（実測：未）", note: "最軽量。賢さは控えめ。",
    url: HFQ + "Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf" },
  { key: "qwen25-15b", name: "Qwen2.5-1.5B（GGUF）", dlMB: 1100, ctx: 1024, maxOut: 160, speed: "遅め（実測：約2トークン/秒）", note: "日本語は0.5Bより自然。長文で落ちやすいため、入力・出力を短めに制限。",
    url: HFQ + "Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf" },
  { key: "qwen25-3b", name: "Qwen2.5-3B（GGUF・重い）", dlMB: 2100, ctx: 768, maxOut: 128, speed: "とても遅い（未検証）", note: "iPadでは落ちやすい。非商用ライセンス。",
    url: HFQ + "Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" },
].map((m) => ({ ...m, id: "gguf:" + m.key, kind: "gguf" }));

const JSPI_FN = WebAssembly.Suspending;
function isSafariUA() {
  const u = navigator.userAgent;
  return /Version\/[0-9._]+.*Safari/.test(u) && !/Chrome|Chromium|Edg|Firefox/.test(u);
}
let mod = null;
export async function getLib() {
  if (mod) return mod;
  try {
    if (isSafariUA() && typeof WebAssembly.Suspending !== "undefined") {
      Object.defineProperty(WebAssembly, "Suspending", { value: undefined, configurable: true, writable: true });
    }
  } catch {}
  mod = await import(CDN);
  return mod;
}
function make(m) {
  const quiet = { debug() {}, log() {}, warn() {}, error() {} };
  const w = new m.Wllama({ default: WASM }, { allowOffline: true, parallelDownloads: 3, logger: quiet });
  if (typeof w.setCompat === "function") w.setCompat("default", "safari");
  return w;
}
function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}
async function loadInto(wl, model, onProgress) {
  await wl.loadModelFromUrl(model.url, {
    n_ctx: model.ctx, n_batch: 256, n_ubatch: 256, useCache: true,
    progressCallback: ({ loaded, total }) => { if (onProgress) onProgress(total ? loaded / total : 0, loaded, total); },
  });
}

export async function loadGguf(model, { onProgress, onStatus } = {}) {
  const m = await getLib();
  let wl = make(m);
  await loadInto(wl, model, onProgress);
  let dirty = false, ac = null;

  async function restart() {
    if (onStatus) onStatus("エンジンを再準備中…（保存済みのモデルを読み直します）");
    try { await withTimeout(wl.exit(), 8000, "exit timeout"); } catch {}
    wl = make(m);
    await loadInto(wl, model, null);
    dirty = false;
  }

  return {
    kind: "gguf", model,
    async *chat(messages, { maxTokens }) {
      if (dirty) await restart();
      ac = new AbortController();
      const mine = ac;
      try {
        const stream = await withTimeout(wl.createChatCompletion({
          messages, stream: true, abortSignal: mine.signal,
          max_tokens: maxTokens, temperature: 0.5, top_p: 0.9,
        }), 120000, "STALL");
        const it = stream[Symbol.asyncIterator]();
        let first = true;
        for (;;) {
          // 最初の1文字までは長め、その後は40秒無反応なら止まったとみなす
          const r = await withTimeout(it.next(), first ? 150000 : 40000, "STALL");
          if (r.done) break;
          first = false;
          const c = r.value;
          const d = c && c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content;
          if (d) yield d;
        }
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (mine.signal.aborted && !/STALL/.test(msg)) { dirty = true; return; }   // 利用者が停止した
        dirty = true;
        try { mine.abort(); } catch {}
        if (msg === "STALL") throw new Error("生成が途中で止まりました（応答なし）。入力か返答が長すぎた可能性があります");
        throw e;
      } finally {
        if (ac === mine) ac = null;
      }
    },
    async stop() { if (ac) { dirty = true; try { ac.abort(); } catch {} } },
    async unload() { try { await withTimeout(wl.exit(), 8000, "exit timeout"); } catch {} },
  };
}

export async function deleteGguf(model) {
  const m = await getLib();
  const w = make(m);
  const list = await w.modelManager.getModels();
  for (const x of list) { if (String(x.url || "") === model.url) await x.remove(); }
}
