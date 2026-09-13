import test from "node:test";
import assert from "node:assert/strict";
import { makeEdit, applyEdit, textAt, validateRecording } from "../src/record.ts";
import type { Recording } from "../src/record.ts";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const CREATED = "2026-09-12T18:00:00.000Z";

function rec(edits: Recording["edits"], title = "t"): Recording {
  return { schema: "witness-recording@1", id: ID, title, createdAt: CREATED, initialText: "", edits };
}

test("a revision preserves both the result and its actual source", () => {
  const e = makeEdit("I wanted an answer.", "I wanted a question.", {
    seq: 1, elapsedMs: 100, kind: "edit",
  })!;
  assert.equal(applyEdit("I wanted an answer.", e), "I wanted a question.");
  assert.throws(() => applyEdit("Different source.", e));
});

test("unchanged input adds no fictional edit", () => {
  assert.equal(makeEdit("same", "same", { seq: 1, elapsedMs: 0, kind: "typing" }), null);
});

test("deletion to empty records full removal", () => {
  const e = makeEdit("hello", "", { seq: 1, elapsedMs: 10, kind: "typing" })!;
  assert.equal(e.at, 0);
  assert.equal(e.removed, "hello");
  assert.equal(e.inserted, "");
  assert.equal(applyEdit("hello", e), "");
});

test("multiline paste is one contiguous replacement", () => {
  const e1 = makeEdit("", "a\nb", { seq: 1, elapsedMs: 0, kind: "typing" })!;
  const e2 = makeEdit("a\nb", "a\nline1\nline2\nb", { seq: 2, elapsedMs: 5, kind: "paste" })!;
  assert.equal(applyEdit("a\nb", e2), "a\nline1\nline2\nb");
  assert.equal(textAt(rec([e1, e2]), 2), "a\nline1\nline2\nb");
  assert.equal(textAt(rec([e1, e2]), 0), "");
});

test("emoji edit never splits a surrogate pair", () => {
  const before = "a\ud83d\ude00b";
  const after = "a\ud83d\ude00c";
  const e = makeEdit(before, after, { seq: 1, elapsedMs: 5, kind: "typing" })!;
  assert.equal(applyEdit(before, e), after);
  assert.ok(!/[\ud800-\udbff]$/.test(e.removed) || e.removed.length !== 1);
  // Shared-lead-surrogate emojis expand to whole pairs.
  const b2 = "a\ud83d\ude00";
  const a2 = "a\ud83d\ude01";
  const e2 = makeEdit(b2, a2, { seq: 1, elapsedMs: 5, kind: "typing" })!;
  assert.equal(e2.removed, "\ud83d\ude00");
  assert.equal(e2.inserted, "\ud83d\ude01");
});

test("combining marks and RTL text round-trip", () => {
  const before = "cafe\u0301 \u05e9\u05dc\u05d5\u05dd";
  const after = "caf\u00e9! \u05e9\u05dc\u05d5\u05dd!";
  const e = makeEdit(before, after, { seq: 1, elapsedMs: 5, kind: "typing" })!;
  assert.equal(applyEdit(before, e), after);
});

test("whitespace-only change is a real edit", () => {
  const e = makeEdit("a  b", "a b", { seq: 1, elapsedMs: 5, kind: "typing" });
  assert.notEqual(e, null);
  assert.equal(applyEdit("a  b", e!), "a b");
});

test("invalid offsets and source mismatches throw, never repair", () => {
  assert.throws(() => applyEdit("hi", { seq: 1, elapsedMs: 0, at: 99, removed: "", inserted: "x", kind: "typing" }));
  assert.throws(() => applyEdit("hi", { seq: 1, elapsedMs: 0, at: 0, removed: "bye", inserted: "x", kind: "typing" }));
  assert.throws(() => applyEdit("hi", { seq: 1, elapsedMs: 0, at: -1, removed: "", inserted: "x", kind: "typing" }));
});

test("sequence gaps and regressions are rejected", () => {
  const e1 = makeEdit("", "a", { seq: 1, elapsedMs: 0, kind: "typing" })!;
  const e3 = makeEdit("a", "ab", { seq: 3, elapsedMs: 10, kind: "typing" })!;
  assert.throws(() => validateRecording(rec([e1, e3])));
  const e2 = makeEdit("a", "ab", { seq: 2, elapsedMs: 10, kind: "typing" })!;
  assert.throws(() =>
    validateRecording(rec([{ ...e1, elapsedMs: 20 }, e2])),
  );
});

test("validator rejects bad schema, id, date, title, kind, initialText", () => {
  const e1 = makeEdit("", "a", { seq: 1, elapsedMs: 0, kind: "typing" })!;
  const good = rec([e1], "ok");
  assert.throws(() => validateRecording({ ...good, schema: "witness-recording@2" }));
  assert.throws(() => validateRecording({ ...good, id: "not-a-uuid" }));
  assert.throws(() => validateRecording({ ...good, createdAt: "yesterday" }));
  assert.throws(() => validateRecording({ ...good, title: "x".repeat(121) }));
  assert.throws(() => validateRecording({ ...good, initialText: "seed" }));
  assert.throws(() =>
    validateRecording(rec([{ ...e1, kind: "ai" as never }])),
  );
});

test("validator rejects state mismatch and out-of-range offsets", () => {
  assert.throws(() =>
    validateRecording(
      rec([{ seq: 1, elapsedMs: 0, at: 0, removed: "zzz", inserted: "a", kind: "typing" }]),
    ),
  );
  assert.throws(() =>
    validateRecording(
      rec([{ seq: 1, elapsedMs: 0, at: 5, removed: "", inserted: "a", kind: "typing" }]),
    ),
  );
});

test("NaN and infinite elapsed are rejected", () => {
  assert.throws(() =>
    validateRecording(rec([{ seq: 1, elapsedMs: NaN, at: 0, removed: "", inserted: "a", kind: "typing" }])),
  );
  assert.throws(() =>
    validateRecording(
      rec([{ seq: 1, elapsedMs: Infinity, at: 0, removed: "", inserted: "a", kind: "typing" }]),
    ),
  );
});
