// An R2Bucket for unit tests, held in a Map. Only what the Worker uses is implemented: put of
// bytes, get and head of a key, and delete of one key or a list of them.

/** One stored object: its bytes and the HTTP metadata it was put with. */
export interface StoredObject {
  body: Uint8Array<ArrayBuffer>;
  httpMetadata: R2HTTPMetadata;
}

/** A fresh empty bucket, and the Map behind it for assertions. */
export function createR2(): { bucket: R2Bucket; objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();

  const view = (key: string, stored: StoredObject) => ({
    key,
    size: stored.body.byteLength,
    httpMetadata: stored.httpMetadata,
    body: new Response(stored.body).body,
    arrayBuffer: async () => stored.body.slice().buffer,
  });

  const bucket = {
    put: async (key: string, value: ArrayBuffer | ArrayBufferView, options?: R2PutOptions) => {
      const bytes = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
      const stored = {
        body: bytes.slice(),
        httpMetadata: { ...(options?.httpMetadata as R2HTTPMetadata | undefined) },
      };
      objects.set(key, stored);
      return view(key, stored);
    },
    get: async (key: string) => {
      const stored = objects.get(key);
      return stored ? view(key, stored) : null;
    },
    head: async (key: string) => {
      const stored = objects.get(key);
      return stored ? view(key, stored) : null;
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}
