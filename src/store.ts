import {
  MAX_EDITS,
  MAX_SERIALIZED_BYTES,
  MAX_TEXT_UNITS,
  MAX_TITLE_CHARS,
  RECORD_SCHEMA,
  applyEdit,
  textAt,
  validateRecording,
} from "./record.ts";
import type { Edit, Recording } from "./record.ts";

export type DocumentMeta = {
  id: string;
  schema: "witness-recording@1";
  title: string;
  createdAt: string;
  headSeq: number;
  elapsedMs: number;
  currentText: string;
  byteCount: number;
};

export type DocumentRow = {
  id: string;
  title: string;
  updatedSeq: number;
  createdAt: string;
};

type EditRow = Edit & { documentId: string };

const DB_NAME = "witness";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("Could not open storage."));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("documents")) {
        db.createObjectStore("documents", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("edits")) {
        const edits = db.createObjectStore("edits", {
          keyPath: ["documentId", "seq"],
        });
        edits.createIndex("documentId", "documentId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open storage."));
    req.onblocked = () => reject(new Error("Storage upgrade blocked by another tab."));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Storage transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("Storage transaction aborted."));
  });
}

function getOne<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error("Storage read failed."));
  });
}

function getAllByIndex<T>(store: IDBObjectStore, index: string, key: IDBValidKey): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = store.index(index).getAll(key);
    req.onsuccess = () => resolve((req.result ?? []) as T[]);
    req.onerror = () => reject(req.error ?? new Error("Storage read failed."));
  });
}

function getAllDocs(store: IDBObjectStore): Promise<DocumentMeta[]> {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result ?? []) as DocumentMeta[]);
    req.onerror = () => reject(req.error ?? new Error("Storage read failed."));
  });
}

function canonicalJson(recording: Recording): string {
  return JSON.stringify({
    schema: recording.schema,
    id: recording.id,
    title: recording.title,
    createdAt: recording.createdAt,
    initialText: "",
    edits: recording.edits,
  });
}

function editBytes(edit: Edit): number {
  return new TextEncoder().encode(JSON.stringify(edit)).length;
}

export function capacityError(): Error {
  return new Error("This recording has reached its limit. Export it before starting another.");
}

export async function listDocuments(): Promise<DocumentRow[]> {
  const db = await openDb();
  try {
    const tx = db.transaction("documents", "readonly");
    const rows = await getAllDocs(tx.objectStore("documents"));
    return rows.map((m) => ({
      id: m.id,
      title: m.title,
      updatedSeq: m.headSeq,
      createdAt: m.createdAt,
    }));
  } finally {
    db.close();
  }
}

export async function createDocument(recording: Recording): Promise<void> {
  const valid = validateRecording(recording);
  const currentText = textAt(valid, valid.edits.length);
  const byteCount = new TextEncoder().encode(canonicalJson(valid)).length;
  const meta: DocumentMeta = {
    id: valid.id,
    schema: RECORD_SCHEMA,
    title: valid.title,
    createdAt: valid.createdAt,
    headSeq: valid.edits.length,
    elapsedMs: valid.edits.length > 0 ? valid.edits[valid.edits.length - 1]!.elapsedMs : 0,
    currentText,
    byteCount,
  };
  const db = await openDb();
  try {
    const tx = db.transaction(["documents", "edits"], "readwrite");
    tx.objectStore("documents").put(meta);
    const editStore = tx.objectStore("edits");
    for (const edit of valid.edits) {
      editStore.put({ ...edit, documentId: valid.id } satisfies EditRow);
    }
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function loadDocument(id: string): Promise<Recording> {
  const db = await openDb();
  try {
    const tx = db.transaction(["documents", "edits"], "readonly");
    const meta = await getOne<DocumentMeta>(tx.objectStore("documents"), id);
    if (!meta) throw new Error("Draft not found.");
    const rows = await getAllByIndex<EditRow>(tx.objectStore("edits"), "documentId", id);
    rows.sort((a, b) => a.seq - b.seq);
    const recording: Recording = {
      schema: RECORD_SCHEMA,
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      initialText: "",
      edits: rows.map(({ documentId: _omit, ...edit }) => edit),
    };
    return validateRecording(recording);
  } finally {
    db.close();
  }
}

export async function appendEdit(
  id: string,
  expectedSeq: number,
  edit: Edit,
  nextText: string,
): Promise<void> {
  if (!Number.isInteger(expectedSeq) || expectedSeq < 0) {
    throw new Error("Invalid expected sequence.");
  }
  if (!Number.isInteger(edit.seq) || edit.seq !== expectedSeq + 1) {
    throw new Error("Edit sequence does not follow the saved draft.");
  }
  if (typeof edit.elapsedMs !== "number" || !Number.isFinite(edit.elapsedMs) || edit.elapsedMs < 0) {
    throw new Error("Malformed edit time.");
  }
  if (!Number.isInteger(edit.at) || edit.at < 0) throw new Error("Malformed edit offset.");
  if (typeof edit.removed !== "string" || typeof edit.inserted !== "string") {
    throw new Error("Malformed edit text.");
  }
  const db = await openDb();
  try {
    const tx = db.transaction(["documents", "edits"], "readwrite");
    const docStore = tx.objectStore("documents");
    const meta = await getOne<DocumentMeta>(docStore, id);
    if (!meta) throw new Error("Draft not found.");
    if (meta.headSeq !== expectedSeq) {
      throw new Error("STALE_DRAFT");
    }
    if (edit.elapsedMs < meta.elapsedMs) throw new Error("Non-monotonic edit time.");
    // Validate the patch against saved text only — never reserialize history.
    const rebuilt = applyEdit(meta.currentText, edit);
    if (rebuilt !== nextText) throw new Error("Edit does not match the saved draft text.");
    if (rebuilt.length > MAX_TEXT_UNITS) throw capacityError();
    if (meta.headSeq + 1 > MAX_EDITS) throw capacityError();
    const nextBytes = meta.byteCount + editBytes(edit) + (meta.headSeq === 0 ? 0 : 1);
    if (nextBytes > MAX_SERIALIZED_BYTES) throw capacityError();
    tx.objectStore("edits").put({ ...edit, documentId: id } satisfies EditRow);
    docStore.put({
      ...meta,
      headSeq: edit.seq,
      elapsedMs: edit.elapsedMs,
      currentText: rebuilt,
      byteCount: nextBytes,
    } satisfies DocumentMeta);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function renameDocument(id: string, title: string): Promise<void> {
  if ([...title].length > MAX_TITLE_CHARS) {
    throw new Error("Title exceeds 120 characters.");
  }
  const db = await openDb();
  try {
    const tx = db.transaction("documents", "readwrite");
    const store = tx.objectStore("documents");
    const meta = await getOne<DocumentMeta>(store, id);
    if (!meta) throw new Error("Draft not found.");
    const enc = new TextEncoder();
    const nextBytes =
      meta.byteCount -
      enc.encode(JSON.stringify(meta.title)).length +
      enc.encode(JSON.stringify(title)).length;
    if (nextBytes > MAX_SERIALIZED_BYTES) throw capacityError();
    store.put({ ...meta, title, byteCount: nextBytes } satisfies DocumentMeta);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function deleteDocument(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(["documents", "edits"], "readwrite");
    const editStore = tx.objectStore("edits");
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = editStore.index("documentId").getAllKeys(id);
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error ?? new Error("Storage read failed."));
    });
    for (const key of keys) editStore.delete(key);
    tx.objectStore("documents").delete(id);
    await txDone(tx);
  } finally {
    db.close();
  }
}
