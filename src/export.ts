import { MAX_TITLE_CHARS, validateRecording } from "./record.ts";
import type { Recording } from "./record.ts";

export const EXPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "base-uri 'none'; form-action 'none'; object-src 'none'; connect-src 'none'";

export const EXPORT_DISCLAIMER =
  "This is a record supplied by its author. It does not prove who wrote the text, " +
  "whether AI was used, or when the writing happened.";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeInertJson(json: string): string {
  const text = json.replace(/</g, "\\u003c");
  return text.split(String.fromCharCode(0x2028)).join("\\u2028").split(String.fromCharCode(0x2029)).join("\\u2029");
}

function escapeClosingScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

export function buildExportHtml(recording: Recording, replayJs: string, replayCss: string): string {
  const valid = validateRecording(recording);
  const data = escapeInertJson(JSON.stringify(valid));
  const safeJs = escapeClosingScript(replayJs);
  const title = escapeHtml(valid.title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}" />
<title>Witness replay \u2014 ${title}</title>
<style>
${replayCss}
</style>
</head>
<body>
<div id="app">
<header class="wx-head">
<h1>${title}</h1>
<p>Recorded writing history</p>
<p class="wx-disclaimer">${escapeHtml(EXPORT_DISCLAIMER)}</p>
<button type="button" id="witness-download-json">Download recording data (JSON)</button>
</header>
<div id="witness-replay"></div>
</div>
<script id="witness-data" type="application/json">${data}</script>
<script>
${safeJs}
</script>
</body>
</html>
`;
}

export function downloadRecording(recording: Recording): void {
  const valid = validateRecording(recording);
  const blob = new Blob([JSON.stringify(valid)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `witness-${valid.id}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadExportFile(recording: Recording, html: string): void {
  const valid = validateRecording(recording);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `witness-${valid.id}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const IMPORT_SUFFIX = " (imported)";

export function prepareImport(value: unknown): Recording {
  const valid = validateRecording(value);
  const chars = [...valid.title];
  const suffixChars = [...IMPORT_SUFFIX];
  const base =
    chars.length + suffixChars.length > MAX_TITLE_CHARS
      ? chars.slice(0, MAX_TITLE_CHARS - suffixChars.length).join("")
      : valid.title;
  return {
    ...valid,
    id: crypto.randomUUID(),
    title: `${base}${IMPORT_SUFFIX}`,
    edits: valid.edits.map((edit) => ({ ...edit })),
  };
}
