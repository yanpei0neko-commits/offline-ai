// WebLLM の読み込み元を1か所で管理します（バージョン固定）。
// 初回のオンライン時に取得され、Service Worker がオフライン用に保存します。
export * from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm";
