export type EditKind = "typing" | "paste" | "composition" | "undo" | "redo" | "edit";

export type Edit = {
  seq: number;
  elapsedMs: number;
  at: number;
  removed: string;
  inserted: string;
  kind: EditKind;
};

export type Recording = {
  schema: "witness-recording@1";
  id: string;
  title: string;
  createdAt: string;
  initialText: "";
  edits: Edit[];
};

export type Span = { start: number; end: number };

export const RECORD_SCHEMA = "witness-recording@1" as const;
export const MAX_TEXT_UNITS = 100_000;
export const MAX_EDITS = 50_000;
export const MAX_SERIALIZED_BYTES = 20 * 1024 * 1024;
export const MAX_TITLE_CHARS = 120;

const EDIT_KINDS: Record<string, true> = {
  typing: true,
  paste: true,
  composition: true,
  undo: true,
  redo: true,
  edit: true,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO 8601 datetime with timezone (e.g. 2026-09-12T18:00:00.000Z or +00:00 offset).
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

function bisectsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const prev = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

export function makeEdit(
  before: string,
  after: string,
  meta: Pick<Edit, "seq" | "elapsedMs" | "kind">,
): Edit | null {
  if (before === after) return null;
  const minLen = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < minLen && before[prefix] === after[prefix]) prefix++;
  // Expand a boundary that would bisect a surrogate pair: shrink shared
  // prefix so the whole pair lands inside removed/inserted.
  while (prefix > 0 && bisectsPair(before, prefix)) prefix--;

  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  // Same expansion on the suffix side: shrink shared suffix past a split pair.
  while (suffix > 0 && bisectsPair(before, before.length - suffix)) suffix--;

  // Keep prefix+suffix from overlapping after adjustment.
  if (prefix + suffix > minLen) suffix = minLen - prefix;

  const at = prefix;
  const removed = before.slice(at, before.length - suffix);
  const inserted = after.slice(at, after.length - suffix);
  if (removed === "" && inserted === "") return null;
  return {
    seq: meta.seq,
    elapsedMs: meta.elapsedMs,
    at,
    removed,
    inserted,
    kind: meta.kind,
  };
}

export function applyEdit(text: string, edit: Edit): string {
  if (!Number.isInteger(edit.at) || edit.at < 0 || edit.at > text.length) {
    throw new RangeError(`Edit offset out of range: at=${edit.at}`);
  }
  if (edit.at + edit.removed.length > text.length) {
    throw new RangeError("Edit removed range extends past text end.");
  }
  if (text.slice(edit.at, edit.at + edit.removed.length) !== edit.removed) {
    throw new Error("Edit source mismatch: removed text does not match.");
  }
  return text.slice(0, edit.at) + edit.inserted + text.slice(edit.at + edit.removed.length);
}

export function textAt(recording: Recording, seq: number): string {
  if (!Number.isInteger(seq) || seq < 0 || seq > recording.edits.length) {
    throw new RangeError(`Sequence out of range: ${seq}`);
  }
  let text: string = recording.initialText;
  for (let i = 0; i < seq; i++) {
    text = applyEdit(text, recording.edits[i]!);
  }
  return text;
}


export function validateRecording(value: unknown): Recording {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recording must be an object.");
  }
  const v = value as Record<string, unknown>;
  if (v["schema"] !== RECORD_SCHEMA) throw new Error("Unknown recording schema.");
  if (typeof v["id"] !== "string" || !UUID_RE.test(v["id"])) {
    throw new Error("Invalid recording id.");
  }
  if (typeof v["title"] !== "string") throw new Error("Invalid recording title.");
  if ([...v["title"]].length > MAX_TITLE_CHARS) {
    throw new Error("Recording title exceeds 120 characters.");
  }
  if (
    typeof v["createdAt"] !== "string" ||
    !ISO_RE.test(v["createdAt"]) ||
    Number.isNaN(Date.parse(v["createdAt"]))
  ) {
    throw new Error("Invalid recording createdAt.");
  }
  if (v["initialText"] !== "") throw new Error("Invalid initialText: must be empty.");
  if (!Array.isArray(v["edits"])) throw new Error("Invalid edits array.");
  if (v["edits"].length > MAX_EDITS) throw new Error("Recording exceeds edit capacity.");

  const edits: Edit[] = [];
  let prevElapsed = -1;
  let isFirst = true;
  for (let i = 0; i < v["edits"].length; i++) {
    const raw = v["edits"][i] as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Invalid edit at index ${i}.`);
    }
    const { seq, elapsedMs, at, removed, inserted, kind } = raw;
    if (!Number.isInteger(seq) || (seq as number) !== i + 1) {
      throw new Error(`Noncontiguous edit sequence at index ${i}.`);
    }
    if (
      typeof elapsedMs !== "number" ||
      !Number.isFinite(elapsedMs) ||
      elapsedMs < 0
    ) {
      throw new Error(`Malformed edit time at seq ${seq}.`);
    }
    if (!isFirst && (elapsedMs as number) < prevElapsed) {
      throw new Error(`Non-monotonic edit time at seq ${seq}.`);
    }
    isFirst = false;
    prevElapsed = elapsedMs as number;
    if (!Number.isInteger(at) || (at as number) < 0) {
      throw new Error(`Malformed edit offset at seq ${seq}.`);
    }
    if (typeof removed !== "string" || typeof inserted !== "string") throw new Error(`Malformed edit text at seq ${String(seq)}.`);
    if (typeof kind !== "string" || EDIT_KINDS[kind] !== true) throw new Error(`Unknown edit kind at seq ${String(seq)}.`);
    edits.push({
      seq: seq as number,
      elapsedMs: elapsedMs as number,
      at: at as number,
      removed: removed as string,
      inserted: inserted as string,
      kind: kind as EditKind,
    });
  }

  // Reconstruct every state: rejects bad offsets and source mismatches.
  let text = "";
  for (const edit of edits) {
    text = applyEdit(text, edit);
    if (text.length > MAX_TEXT_UNITS) {
      throw new Error("Recording exceeds text capacity.");
    }
  }

  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_SERIALIZED_BYTES) throw new Error("Recording exceeds serialized size capacity.");

  return {
    schema: RECORD_SCHEMA,
    id: v["id"] as string,
    title: v["title"] as string,
    createdAt: v["createdAt"] as string,
    initialText: "",
    edits,
  };
}
