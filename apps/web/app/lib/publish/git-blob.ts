// Git's object id for a file's text, so the Worker can tell whether a file it is about to push is
// byte for byte the one GitHub already has (design doc §4.9.7) without asking GitHub.

/** The git blob SHA-1 of `text` as UTF-8, as `git hash-object` prints it. */
export async function gitBlobSha(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", object));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
