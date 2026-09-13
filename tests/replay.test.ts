import test from "node:test";
import assert from "node:assert/strict";
import { makeEdit } from "../src/record.ts";
import type { Recording } from "../src/record.ts";
import {
  CHECKPOINT_EVERY,
  SKIP_CAP_MS,
  checkpointTexts,
  effectiveGapMs,
  elapsedAt,
  formatTime,
  rawGapMs,
  seekText,
} from "../src/replay.ts";

const ID = "123e4567-e89b-12d3-a456-426614174000";

function build(count: number): Recording {
  const edits: Recording["edits"] = [];
  let text = "";
  for (let n = 1; n <= count; n++) {
    const e = makeEdit(text, `${text}x`, { seq: n, elapsedMs: n * 100, kind: "typing" })!;
    edits.push(e);
    text = `${text}x`;
  }
  return {
    schema: "witness-recording@1",
    id: ID,
    title: "t",
    createdAt: "2026-09-12T18:00:00.000Z",
    initialText: "",
    edits,
  };
}

test("elapsed values are the original recorded times", () => {
  const rec = build(3);
  assert.equal(elapsedAt(rec, 0), 0);
  assert.equal(elapsedAt(rec, 2), 200);
  assert.equal(rawGapMs(rec, 1), 100);
});

test("pause-skipping caps each gap before speed division", () => {
  assert.equal(effectiveGapMs(10_000, 1, true), SKIP_CAP_MS);
  assert.equal(effectiveGapMs(10_000, 4, true), SKIP_CAP_MS / 4);
  assert.equal(effectiveGapMs(10_000, 1, false), 10_000);
  assert.equal(effectiveGapMs(500, 16, true), 500 / 16);
});

test("checkpoints rebuild any position exactly", () => {
  const rec = build(CHECKPOINT_EVERY * 2 + 7);
  const points = checkpointTexts(rec);
  for (const seq of [0, 1, 99, 100, 101, 199, 200, 201, CHECKPOINT_EVERY * 2 + 7]) {
    assert.equal(seekText(rec, points, seq), "x".repeat(seq));
  }
});

test("seek clamps outside positions", () => {
  const rec = build(5);
  const points = checkpointTexts(rec);
  assert.equal(seekText(rec, points, -3), "");
  assert.equal(seekText(rec, points, 99), "xxxxx");
});

test("time format is minutes, seconds, tenths", () => {
  assert.equal(formatTime(0), "0:00.0");
  assert.equal(formatTime(12_400), "0:12.4");
  assert.equal(formatTime(63_200), "1:03.2");
});
