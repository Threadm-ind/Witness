import test from "node:test";
import assert from "node:assert/strict";
import { makeEdit, textAt, validateRecording } from "../src/record.ts";
import type { Recording } from "../src/record.ts";
import { EXPORT_CSP, EXPORT_DISCLAIMER, buildExportHtml, prepareImport } from "../src/export.ts";
import { buildExample } from "../src/example.ts";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const CREATED = "2026-09-12T18:00:00.000Z";

function singleEditRec(title: string, final: string): Recording {
  const e = makeEdit("", final, { seq: 1, elapsedMs: 100, kind: "typing" })!;
  return validateRecording({
    schema: "witness-recording@1",
    id: ID,
    title,
    createdAt: CREATED,
    initialText: "",
    edits: [e],
  });
}

test("illustrative example is 80-120 words and reconstructs", () => {
  const rec = buildExample();
  assert.equal(rec.title, "Illustrative example");
  const words = textAt(rec, rec.edits.length).split(/\s+/).filter((w) => w !== "");
  assert.ok(words.length >= 80 && words.length <= 120, `word count ${words.length}`);
});

test("export embeds CSP, disclaimer, data and one viewer script", () => {
  const rec = singleEditRec("My draft", "Hello world.");
  const html = buildExportHtml(rec, "window.WitnessReplay={};", ".wr{}");
  assert.ok(html.includes(EXPORT_CSP));
  assert.ok(html.includes("Recorded writing history"));
  assert.ok(html.includes(EXPORT_DISCLAIMER));
  assert.ok(html.includes('id="witness-data"'));
  assert.ok(!/src=|href=|fetch\(|XMLHttpRequest/.test(html));
  const parsed = JSON.parse(
    html.split('<script id="witness-data" type="application/json">')[1]!.split("</script>")[0]!
      .replace(/\\u003c/g, "<"),
  );
  assert.equal(validateRecording(parsed).id, ID);
});

test("export escapes paragraph separators in embedded data", () => {
  const sep = String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
  const rec = singleEditRec("t", `a${sep}b`);
  const html = buildExportHtml(rec, "var a = 1;", ".wr{}");
  const data = html.split('<script id="witness-data" type="application/json">')[1]!.split("</script>")[0]!;
  assert.ok(!data.includes(sep));
  assert.ok(data.includes("\\u2028") && data.includes("\\u2029"));
});

test("export neutralizes markup, quotes, ampersands and separators", () => {
  const evil =
    `</script><script>window.__injected=1</script>` +
    `<img src=https://example.invalid/leak>` +
    `"quotes" & 'ampersands'  end`;
  const rec = singleEditRec(evil, evil);
  const html = buildExportHtml(rec, "var a = 1;", ".wr{}");
  assert.ok(!html.includes("<script>window.__injected=1</script>"));
  assert.ok(!html.includes("<img src=https://example.invalid/leak>"));
  assert.ok(!html.includes(evil));
  assert.ok(html.includes("&lt;"));
  assert.ok(html.includes("&amp;"));
});

test("export escapes closing-script sequences in the viewer bundle", () => {
  const rec = singleEditRec("t", "x");
  const html = buildExportHtml(rec, "var s = '</SCRIPT> ';", ".wr{}");
  assert.ok(html.includes("<\\/script"));
  assert.ok(!html.includes("</SCRIPT"));
  assert.equal(html.split("</script>").length - 1, 2);
});

test("import assigns a fresh identity and keeps event timing", () => {
  const rec = singleEditRec("Field notes", "Hello.");
  const imported = prepareImport(JSON.parse(JSON.stringify(rec)));
  assert.notEqual(imported.id, ID);
  assert.equal(imported.title, "Field notes (imported)");
  assert.deepEqual(
    imported.edits.map((e) => e.elapsedMs),
    rec.edits.map((e) => e.elapsedMs),
  );
  assert.equal(rec.title, "Field notes");
});

test("import truncates long titles within the limit", () => {
  const rec = singleEditRec("y".repeat(120), "Hello.");
  const imported = prepareImport(JSON.parse(JSON.stringify(rec)));
  assert.ok([...imported.title].length <= 120);
  assert.ok(imported.title.endsWith("(imported)"));
});

test("import rejects malformed recordings", () => {
  assert.throws(() => prepareImport({ schema: "witness-recording@9" }));
  assert.throws(() => prepareImport(null));
});
