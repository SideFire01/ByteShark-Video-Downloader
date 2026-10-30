const MAX_HOPS = 24;
const MOOV_HEAD_BYTES = 4096;

interface Slice {
  bytes: Uint8Array;
  total: number | null;
}

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function totalFromContentRange(value: string | null): number | null {
  const match = /\/(\d+)\s*$/.exec(value ?? "");
  if (!match?.[1]) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

async function readRange(url: string, start: number, end: number): Promise<Slice | null> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    credentials: "include",
    cache: "no-store",
  });
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("video")) {
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("text/html") || type.includes("application/json")) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    total: totalFromContentRange(response.headers.get("content-range")),
  };
}

export async function mp4DurationSeconds(url: string): Promise<number | null> {
  let offset = 0;
  let total: number | null = null;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const slice = await readRange(url, offset, offset + 15);
    if (!slice || slice.bytes.length < 8) return null;
    total ??= slice.total;

    const view = new DataView(slice.bytes.buffer, slice.bytes.byteOffset, slice.bytes.byteLength);
    let size = view.getUint32(0);
    const type = boxType(slice.bytes, 4);
    let headerSize = 8;

    if (size === 1) {
      if (slice.bytes.length < 16) return null;
      size = Number(view.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      if (total === null) return null;
      size = total - offset;
    }

    if (type === "moov") return await durationFromMoov(url, offset + headerSize);
    if (size <= headerSize) return null;

    offset += size;
    if (total !== null && offset >= total) return null;
  }

  return null;
}

async function durationFromMoov(url: string, payloadOffset: number): Promise<number | null> {
  const slice = await readRange(url, payloadOffset, payloadOffset + MOOV_HEAD_BYTES - 1);
  if (!slice || slice.bytes.length < 28) return null;

  const view = new DataView(slice.bytes.buffer, slice.bytes.byteOffset, slice.bytes.byteLength);
  const size = view.getUint32(0);
  if (boxType(slice.bytes, 4) !== "mvhd" || size < 8) return null;

  const version = slice.bytes[8];
  let timescale: number;
  let duration: number;

  if (version === 1) {
    if (slice.bytes.length < 40) return null;
    timescale = view.getUint32(28);
    duration = Number(view.getBigUint64(32));
  } else {
    timescale = view.getUint32(20);
    duration = view.getUint32(24);
  }

  if (!Number.isFinite(duration) || !Number.isFinite(timescale) || timescale <= 0) return null;
  if (duration <= 0) return null;

  const seconds = duration / timescale;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
