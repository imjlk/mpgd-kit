/**
 * A request body as text, or undefined once it passes `limit` bytes. Counts
 * the bytes actually read, so a chunked body without a Content-Length is
 * bounded too, and cancels the stream as soon as it is over.
 */
export async function readBoundedText(
  request: Request,
  limit: number,
): Promise<string | undefined> {
  const reader = request.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
