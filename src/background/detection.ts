import type { DetectedKind, DetectedMedia } from "@/src/shared/types";
import { clearDetections, readDetections, writeDetections } from "./storage";

const HLS_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);

const DASH_CONTENT_TYPES = new Set(["application/dash+xml"]);

const MP4_CONTENT_TYPES = new Set(["video/mp4"]);

const MIN_MP4_BYTES = 1024 * 1024;

const MAX_PER_TAB = 20;

const VOLATILE_QUERY_PARAMS = new Set([
  "range",
  "_",
  "t",
  "token",
  "expires",
  "signature",
  "sig",
  "hdnts",
]);

const cache = new Map<number, DetectedMedia[]>();
const hydrating = new Map<number, Promise<DetectedMedia[]>>();

export function dedupeKeyFor(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const name of [...parsed.searchParams.keys()]) {
      if (VOLATILE_QUERY_PARAMS.has(name.toLowerCase())) parsed.searchParams.delete(name);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function classifyContentType(value: string): DetectedKind | null {
  const type = (value.split(";")[0] ?? "").trim().toLowerCase();
  if (HLS_CONTENT_TYPES.has(type) || DASH_CONTENT_TYPES.has(type)) return "hls";
  if (MP4_CONTENT_TYPES.has(type)) return "mp4";
  return null;
}

function classifyUrl(url: string): DetectedKind | null {
  const path = url.split(/[?#]/)[0] ?? "";
  if (/\.m3u8$/i.test(path)) return "hls";
  if (/\.mpd$/i.test(path)) return "hls";
  if (/\.mp4$/i.test(path)) return "mp4";
  return null;
}

function headerValue(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (header.name?.toLowerCase() === wanted) return header.value ?? null;
  }
  return null;
}

function announcedBytes(headers: chrome.webRequest.HttpHeader[] | undefined): number | null {
  const contentRange = headerValue(headers, "content-range");
  if (contentRange) {
    const total = /\/\s*(\d+)\s*$/.exec(contentRange);
    if (total?.[1]) {
      const parsed = Number(total[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const contentLength = headerValue(headers, "content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

type DetailsWithDocument = { documentUrl?: string };

async function documentUrlOf(
  details: chrome.webRequest.WebRequestDetails,
): Promise<string | undefined> {
  const fromDetails = (details as chrome.webRequest.WebRequestDetails & DetailsWithDocument)
    .documentUrl;
  if (fromDetails) return fromDetails;
  if (details.tabId < 0) return undefined;
  try {
    return (await chrome.tabs.get(details.tabId)).url ?? undefined;
  } catch {
    return undefined;
  }
}

async function listFor(tabId: number): Promise<DetectedMedia[]> {
  const cached = cache.get(tabId);
  if (cached) return cached;

  const pending = hydrating.get(tabId);
  if (pending) return pending;

  const load = readDetections(tabId).then(
    (media) => {
      cache.set(tabId, media);
      hydrating.delete(tabId);
      return media;
    },
    () => {
      hydrating.delete(tabId);
      return [] as DetectedMedia[];
    },
  );
  hydrating.set(tabId, load);
  return load;
}

export async function patchDetection(
  tabId: number,
  mediaId: string,
  patch: Partial<DetectedMedia>,
): Promise<void> {
  const media = await listFor(tabId);
  const entry = media.find((candidate) => candidate.id === mediaId);
  if (!entry) return;
  Object.assign(entry, patch);
  await writeDetections(tabId, media);
}

async function record(candidate: DetectedMedia): Promise<void> {
  const media = await listFor(candidate.tabId);
  const existing = media.find((entry) => entry.dedupeKey === candidate.dedupeKey);

  if (existing) {
    if (candidate.estimatedBytes !== undefined) existing.estimatedBytes = candidate.estimatedBytes;
    if (candidate.contentType !== undefined) existing.contentType = candidate.contentType;
    if (candidate.documentUrl !== undefined) existing.documentUrl = candidate.documentUrl;
  } else {
    media.push(candidate);
    if (media.length > MAX_PER_TAB) media.splice(0, media.length - MAX_PER_TAB);
  }

  await writeDetections(candidate.tabId, media);
}

async function baseMedia(
  details: chrome.webRequest.WebRequestDetails,
  url: string,
  kind: DetectedKind,
): Promise<Omit<DetectedMedia, "id">> {
  return {
    tabId: details.tabId,
    url,
    kind,
    documentUrl: await documentUrlOf(details),
    frameId: details.frameId,
    timestamp: Date.now(),
    dedupeKey: dedupeKeyFor(url),
  };
}

function handleHeaders(details: chrome.webRequest.WebResponseHeadersDetails): void {
  if (details.tabId < 0) return;
  if (details.statusCode !== 200 && details.statusCode !== 206) return;

  const contentType = headerValue(details.responseHeaders, "content-type");
  if (!contentType) return;

  const kind = classifyContentType(contentType);
  if (!kind) return;

  const bytes = announcedBytes(details.responseHeaders);
  if (kind === "mp4" && bytes !== null && bytes < MIN_MP4_BYTES) return;
  if (bytes === null) {
    console.debug(`[detect] ${kind} with unknown size, allowed: ${details.url}`);
  }

  void baseMedia(details, details.url, kind)
    .then((base) =>
      record({
        ...base,
        id: crypto.randomUUID(),
        contentType: contentType.split(";")[0]?.trim(),
        estimatedBytes: kind === "mp4" ? (bytes ?? undefined) : undefined,
      }),
    )
    .catch((error: unknown) => {
      console.warn("[detect] failed to persist detection", error);
    });
}

function handleBeforeRequest(details: chrome.webRequest.WebRequestDetails): void {
  if (details.tabId < 0) return;

  if (details.type === "main_frame") {
    cache.delete(details.tabId);
    void clearDetections(details.tabId).catch((error: unknown) => {
      console.warn("[detect] failed to clear detections on navigation", error);
    });
    return;
  }

  const kind = classifyUrl(details.url);
  if (!kind) return;

  void baseMedia(details, details.url, kind)
    .then((base) => record({ ...base, id: crypto.randomUUID() }))
    .catch((error: unknown) => {
      console.warn("[detect] failed to persist detection", error);
    });
}

function handleTabRemoved(tabId: number): void {
  cache.delete(tabId);
  void clearDetections(tabId).catch((error: unknown) => {
    console.warn("[detect] failed to clear detections for a closed tab", error);
  });
}

export function registerDetectionListeners(): void {
  chrome.webRequest.onHeadersReceived.addListener(
    handleHeaders,
    { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object"] },
    ["responseHeaders"],
  );

  chrome.webRequest.onBeforeRequest.addListener(handleBeforeRequest, {
    urls: ["<all_urls>"],
    types: ["main_frame", "media", "xmlhttprequest", "other", "object"],
  });

  chrome.tabs.onRemoved.addListener(handleTabRemoved);
}
