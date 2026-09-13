import { textAt } from "./record.ts";
import type { Edit, Recording, Span } from "./record.ts";

export type SpanRelation =
  | "unchanged"
  | "edited"
  | "replaced"
  | "introduced"
  | "context-expanded";

export type MappedSpan = { span: Span; relation: SpanRelation };

export type HistoryRow = { seq: number; text: string; relation: string };

export function sentenceSpans(text: string): Span[] {
  if (text === "") return [];
  const segmenter = segmenterForSentences();
  if (segmenter) {
    const spans: Span[] = [];
    for (const item of segmenter.segment(text)) {
      const start = item.index;
      const end = start + item.segment.length;
      if (end > start) spans.push({ start, end });
    }
    return spans.length > 0 ? spans : [{ start: 0, end: text.length }];
  }
  return fallbackSpans(text);
}

function segmenterForSentences(): Intl.Segmenter | null {
  try {
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
      return new Intl.Segmenter("en", { granularity: "sentence" });
    }
  } catch {
    return null;
  }
  return null;
}

function fallbackSpans(text: string): Span[] {
  const cuts = new Set<number>();
  for (const m of text.matchAll(/[.?!\u2026]+(?=\s|$)/g)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end < text.length) cuts.add(end);
  }
  for (const m of text.matchAll(/\n(?=[ \t]*\n)/g)) {
    cuts.add((m.index ?? 0) + 1);
  }
  const ordered = [...cuts].sort((a, b) => a - b);
  const spans: Span[] = [];
  let start = 0;
  for (const cut of ordered) {
    if (cut > start) spans.push({ start, end: cut });
    start = cut;
  }
  if (start < text.length) spans.push({ start, end: text.length });
  const kept = spans.filter((s) => text.slice(s.start, s.end).trim() !== "");
  return kept.length > 0 ? kept : spans.length > 0 ? spans : [{ start: 0, end: text.length }];
}

export function mapSpanBeforeEdit(span: Span, edit: Edit): MappedSpan {
  const s = span.start;
  const e = span.end;
  const p = edit.at;
  const r = edit.removed.length;
  const i = edit.inserted.length;

  if (s === e) {
    if (r === 0 && i === 0) return { span: { start: s, end: e }, relation: "unchanged" };
    if (r === 0) {
      const v = s <= p ? s : s >= p + i ? s - i : p;
      return { span: { start: v, end: v }, relation: "unchanged" };
    }
    if (i === 0) {
      if (s < p) return { span: { start: s, end: s }, relation: "unchanged" };
      if (s > p) return { span: { start: s + r, end: s + r }, relation: "unchanged" };
      return { span: { start: s, end: s }, relation: "unchanged" };
    }
    if (s <= p) return { span: { start: s, end: s }, relation: "unchanged" };
    if (s >= p + i) return { span: { start: s - i + r, end: s - i + r }, relation: "unchanged" };
    return { span: { start: p, end: p }, relation: "unchanged" };
  }

  if (r === 0 && i === 0) return { span: { start: s, end: e }, relation: "unchanged" };

  if (r === 0) {
    // Pure insertion. An interval ending at the selected start counts as
    // before (shift); one starting at the selected end counts as after.
    if (p + i <= s) return { span: { start: s - i, end: e - i }, relation: "unchanged" };
    if (p >= e) return { span: { start: s, end: e }, relation: "unchanged" };
    if (p <= s && e <= p + i) return { span: { start: p, end: p }, relation: "introduced" };
    const ms = s <= p ? s : p;
    const me = e >= p + i ? e - i : p;
    return { span: { start: ms, end: me }, relation: "edited" };
  }

  if (i === 0) {
    // Pure deletion at point p. A point at the selected start counts as
    // before (shifts both boundaries); at the selected end counts as after.
    // Only a strictly internal point is included as an edit.
    if (p <= s || p >= e) {
      if (p <= s) return { span: { start: s + r, end: e + r }, relation: "unchanged" };
      return { span: { start: s, end: e }, relation: "unchanged" };
    }
    return { span: { start: s, end: e + r }, relation: "edited" };
  }

  // Replacement: after-interval [p,p+i) corresponds to before-interval [p,p+r).
  if (p + i <= s) {
    return { span: { start: s + r - i, end: e + r - i }, relation: "unchanged" };
  }
  if (p >= e) return { span: { start: s, end: e }, relation: "unchanged" };
  if (p <= s && e <= p + i) return { span: { start: p, end: p + r }, relation: "replaced" };
  if (p >= s && p + i <= e) {
    return { span: { start: s, end: e - i + r }, relation: "edited" };
  }
  const ms = s <= p ? s : p;
  const me = e >= p + i ? e - i + r : p + r;
  return { span: { start: ms, end: me }, relation: "context-expanded" };
}

export function historyForSpan(recording: Recording, seq: number, span: Span): HistoryRow[] {
  if (!Number.isInteger(seq) || seq < 0 || seq > recording.edits.length) {
    throw new RangeError(`Sequence out of range: ${seq}`);
  }
  const sliceAt = (text: string, at: Span): string =>
    text.slice(Math.max(0, Math.min(at.start, text.length)), Math.max(0, Math.min(at.end, text.length)));

  let current = { start: span.start, end: span.end };
  const here = textAt(recording, seq);
  const rows: HistoryRow[] = [{ seq, text: sliceAt(here, current), relation: "unchanged" }];

  for (let k = seq; k >= 1; k--) {
    const mapped = mapSpanBeforeEdit(current, recording.edits[k - 1]!);
    if (mapped.relation === "introduced") {
      rows.push({ seq: k - 1, text: "", relation: "introduced" });
      break;
    }
    current = mapped.span;
    const before = textAt(recording, k - 1);
    rows.push({ seq: k - 1, text: sliceAt(before, current), relation: mapped.relation });
  }
  return rows;
}

export function coalesceRows(rows: HistoryRow[]): HistoryRow[] {
  const out: HistoryRow[] = [];
  for (const row of rows) {
    if (out.length > 0 && out[out.length - 1]!.text === row.text) continue;
    out.push(row);
  }
  return out;
}
