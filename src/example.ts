import { makeEdit, validateRecording } from "./record.ts";
import type { EditKind, Recording } from "./record.ts";

const EXAMPLE_ID = "0e6f5c34-7a1d-4b2e-9c8f-3d5a7b9e1a2c";
const EXAMPLE_CREATED = "2026-09-12T12:00:00.000Z";

const T1 = "The city was quiet.";
const T3 =
  "We kept the porch light on through the whole storm.\n" +
  "The radio read the county names in alphabetical order, and we counted the pauses between thunder.";
const T4 = `${T3}\n\nBy midnight the rain had thinned to a bright curtain, and the street shone like a photograph.`;
const T5 = `${T4}\n\nSomeone laughed next door, relieved and a little embarrassed.`;
const T6 = `${T5}\n\nWe made coffee and forgot it on the stove.`;
const T7 = T6.replace(
  "We made coffee and forgot it on the stove.",
  "We made tea we did not drink and left the cups to cool on the sill.",
);
const T8 =
  `${T7}\n\nIn the morning the yard was littered with small branches, and the light was still on. ` +
  "We stood a while in the doorway, saying nothing worth keeping, and then we began again.";

const STEPS: { text: string; kind: EditKind; elapsedMs: number }[] = [
  { text: T1, kind: "typing", elapsedMs: 2000 },
  { text: "", kind: "edit", elapsedMs: 9000 },
  { text: T3, kind: "paste", elapsedMs: 15000 },
  { text: T4, kind: "typing", elapsedMs: 42000 },
  { text: T5, kind: "typing", elapsedMs: 68000 },
  { text: T6, kind: "typing", elapsedMs: 95000 },
  { text: T7, kind: "edit", elapsedMs: 121000 },
  { text: T8, kind: "typing", elapsedMs: 150000 },
];

export function buildExample(): Recording {
  const edits: Recording["edits"] = [];
  let prev = "";
  for (let n = 0; n < STEPS.length; n++) {
    const step = STEPS[n]!;
    const edit = makeEdit(prev, step.text, { seq: n + 1, elapsedMs: step.elapsedMs, kind: step.kind });
    if (!edit) throw new Error(`Example step ${n + 1} produced no edit.`);
    edits.push(edit);
    prev = step.text;
  }
  return validateRecording({
    schema: "witness-recording@1",
    id: EXAMPLE_ID,
    title: "Illustrative example",
    createdAt: EXAMPLE_CREATED,
    initialText: "",
    edits,
  });
}
