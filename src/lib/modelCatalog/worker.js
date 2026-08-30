// Worker-thread shell: downloads models.dev, normalizes, writes the snapshot.
//
// The 4.4MB / 7,488-model catalog takes ~180ms to JSON.parse — long enough to
// stall concurrent SSE traffic on the main loop, which is why this runs off
// the main thread (measured, not speculative — see .docs/model-catalog.md).
//
// The heavy logic lives in normalize.js (dependency-free, unit-tested); this
// file only adds filesystem writes. Started exclusively by sync.js.

import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fetchAndNormalizeCatalog } from "./normalize.js";

const { url, etag, outFile, timeoutMs, maxPayloadBytes, entries, minModalityShare, limitTolerance } = workerData;

// Write-then-rename: a reader can never observe a truncated snapshot (§8).
function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, file);
}

(async () => {
  const result = await fetchAndNormalizeCatalog(
    { url, etag, timeoutMs, maxPayloadBytes, entries, minModalityShare, limitTolerance },
  );
  if (result.status === "updated") {
    writeAtomic(outFile, JSON.stringify(result.snapshot));
  }
  return result;
})().then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error) => parentPort?.postMessage({ ok: false, error: error?.message || String(error) }),
);
