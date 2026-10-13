// 推論はこのWeb Workerの中で実行します（UIが固まらないようにするため）。
import { WebWorkerMLCEngineHandler } from "./webllm-url.js";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => {
  handler.onmessage(msg);
};
