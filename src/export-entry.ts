import { validateRecording } from "./record.ts";
import { mountReplay } from "./replay.ts";

function readRecording(): unknown {
  const el = document.getElementById("witness-data");
  if (!el) throw new Error("Missing recording data.");
  return JSON.parse(el.textContent ?? "");
}

function start(): void {
  const host = document.getElementById("witness-replay") ?? document.getElementById("app");
  if (!host) return;
  let recording;
  try {
    recording = validateRecording(readRecording());
  } catch {
    host.textContent = "This recording could not be opened.";
    return;
  }
  mountReplay(host, recording);
  const download = document.getElementById("witness-download-json");
  download?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(recording)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `witness-${recording.id}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

export { start };
