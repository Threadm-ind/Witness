import test from "node:test";
import assert from "node:assert/strict";
import { makeEdit } from "../src/record.ts";
import type { EditKind, Recording } from "../src/record.ts";
import {
  coalesceRows,
  historyForSpan,
  mapSpanBeforeEdit,
  sentenceSpans,
} from "../src/history.ts";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const CREATED = "2026-09-12T18:00:00.000Z";

function build(texts: string[], kinds?: EditKind[]): Recording {
  const edits: Recording["edits"] = [];
  for (let n = 1; n < texts.length; n++) {
    const e = makeEdit(texts[n - 1]!, texts[n]!, {
      seq: n,
      elapsedMs: n * 100,
      kind: kinds?.[n - 1] ?? "typing",
    })!;
    edits.push(e);
  }
  return { schema: "witness-recording@1", id: ID, title: "t", createdAt: CREATED, initialText: "", edits };
}

function finalText(rec: Recording): string {
  let t = "";
  for (const e of rec.edits) {
    t = t.slice(0, e.at) + e.inserted + t.slice(e.at + e.removed.length);
  }
  return t;
}

test("sentences keep exact source offsets", () => {
  const spans = sentenceSpans("Hello. World");
  assert.equal(spans.length, 2);
  assert.equal("Hello. World".slice(spans[0]!.start, spans[0]!.end).trim(), "Hello.");
  assert.equal("Hello. World".slice(spans[1]!.start, spans[1]!.end).trim(), "World");
  assert.deepEqual(sentenceSpans(""), []);
});

test("duplicate sentences never share history", () => {
  const rec = build(["", "Same. Same.", "Same. Different."]);
  const text = finalText(rec);
  const spans = sentenceSpans(text);
  assert.equal(spans.length, 2);
  const first = coalesceRows(historyForSpan(rec, 2, spans[0]!));
  assert.match(first[0]!.text, /Same/);
  assert.ok(first.every((r) => !r.text.includes("Different")));
  const second = historyForSpan(rec, 2, spans[1]!);
  assert.ok(second.some((r) => r.text.includes("Same.")));
});

test("an unrelated paragraph before the selection never enters its ancestry", () => {
  const rec = build(["", "I wanted a question.", "Intro paragraph.\n\nI wanted a question."]);
  const text = finalText(rec);
  const span = { start: text.indexOf("I wanted"), end: text.length };
  const rows = coalesceRows(historyForSpan(rec, 2, span));
  assert.ok(rows.some((r) => r.text === "I wanted a question."));
  assert.ok(rows.every((r) => !r.text.includes("paragraph")));
});

test("replacing answer with question shows the old sentence", () => {
  const rec = build(["", "I wanted an answer.", "I wanted a question."]);
  const rows = historyForSpan(rec, 2, { start: 0, end: "I wanted a question.".length });
  assert.equal(rows[1]!.relation, "edited");
  assert.equal(rows[1]!.text, "I wanted an answer.");
});

test("a replacement spanning the whole selection is labelled replaced", () => {
  const rec = build(["", "aa answer bb", "aa question bb"]);
  const rows = historyForSpan(rec, 2, { start: 3, end: 11 });
  assert.equal(rows[1]!.relation, "replaced");
  assert.equal(rows[1]!.text, "answer");
});

test("splitting a sentence traces back to the unsplit passage", () => {
  const rec = build(["", "Hello world", "Hello. world"]);
  const rows = historyForSpan(rec, 2, { start: 7, end: 12 });
  assert.equal(rows[1]!.text, "world");
  assert.equal(rows[1]!.relation, "unchanged");
});

test("merging sentences keeps the actual earlier words", () => {
  const rec = build(["", "Hello. world", "Hello world"]);
  const rows = historyForSpan(rec, 2, { start: 0, end: 11 });
  assert.ok(rows.some((r) => r.text.includes("Hello")));
});

test("deletion strictly inside expands; boundary deletions stay out", () => {
  const rec = build(["", "abc def", "ab def"]);
  const inside = historyForSpan(rec, 2, { start: 0, end: "ab def".length });
  assert.equal(inside[1]!.relation, "edited");
  assert.equal(inside[1]!.text, "abc def");

  const atStart = mapSpanBeforeEdit(
    { start: 0, end: 2 },
    { seq: 1, elapsedMs: 0, at: 0, removed: "xy", inserted: "", kind: "typing" },
  );
  assert.equal(atStart.relation, "unchanged");
  assert.deepEqual(atStart.span, { start: 2, end: 4 });
  const atEnd = mapSpanBeforeEdit(
    { start: 0, end: 4 },
    { seq: 1, elapsedMs: 0, at: 4, removed: "xy", inserted: "", kind: "typing" },
  );
  assert.equal(atEnd.relation, "unchanged");
  assert.deepEqual(atEnd.span, { start: 0, end: 4 });
});

test("touching insertion boundaries keep their side", () => {
  const endingAtStart = mapSpanBeforeEdit(
    { start: 5, end: 8 },
    { seq: 1, elapsedMs: 0, at: 3, removed: "", inserted: "ab", kind: "typing" },
  );
  assert.equal(endingAtStart.relation, "unchanged");
  assert.deepEqual(endingAtStart.span, { start: 3, end: 6 });

  const startingAtEnd = mapSpanBeforeEdit(
    { start: 5, end: 8 },
    { seq: 1, elapsedMs: 0, at: 8, removed: "", inserted: "ab", kind: "typing" },
  );
  assert.equal(startingAtEnd.relation, "unchanged");
  assert.deepEqual(startingAtEnd.span, { start: 5, end: 8 });
});

test("cut and paste is a new introduction, not a link", () => {
  const rec = build(["", "First. Second.", "Second. First."]);
  const text = finalText(rec);
  const moved = { start: text.indexOf("First."), end: text.indexOf("First.") + "First.".length };
  const rows = historyForSpan(rec, 1, moved);
  assert.ok(rows[0]!.relation === "introduced" || rows.some((r) => r.relation === "introduced"));
});

test("a fully inserted passage is introduced and stops the walk", () => {
  const rec = build(["", "Hello"]);
  const rows = historyForSpan(rec, 1, { start: 0, end: 5 });
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.relation, "introduced");
  assert.equal(rows[1]!.text, "");
});

test("straddling replacement expands to the earlier surrounding passage", () => {
  const rec = build(["", "First words. Second words.", "First terms. Second terms."]);
  const rows = historyForSpan(rec, 2, { start: 13, end: 26 });
  assert.equal(rows[1]!.relation, "context-expanded");
  assert.equal(rows[1]!.text, "words. Second words.");
});
