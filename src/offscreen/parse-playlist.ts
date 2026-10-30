import { type M3u8Manifest, type M3u8Segment, Parser } from "m3u8-parser";
import type { EncryptionClass, KeyEntry, Variant } from "@/src/shared/types";

const AES128 = "AES-128";
const IDENTITY = "identity";

const FAIRPLAY = "com.apple.streamingkeydelivery";
const WIDEVINE = "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
const PLAYREADY = "com.microsoft.playready";

const MIN_SEGMENTS = 1;

interface KeyAttributes {
  method: string;
  keyFormat: string;
  uri: string;
  ivHex?: string;
}

export interface PlaylistPlan {
  url: string;
  isMaster: boolean;
  variants: Variant[];
  inputUrl: string;
  encryption: EncryptionClass;
  durationSeconds: number;
  segmentCount: number;
  estimatedBytes: number | null;
  hosts: string[];
  live: boolean;
  hasAudioGroup: boolean;
}

export class BlockedPlaylist extends Error {
  constructor(
    readonly kind: "unsupported" | "drm",
    message: string,
  ) {
    super(message);
    this.name = "BlockedPlaylist";
  }
}

function parseAttributeList(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    const raw = match[2];
    if (!name || raw === undefined) continue;
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    attributes.set(name.toUpperCase(), value.trim());
  }
  return attributes;
}

function scanKeys(text: string, tag: string): KeyAttributes[] {
  const keys: KeyAttributes[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`#${tag}:`)) continue;
    const attributes = parseAttributeList(line.slice(tag.length + 2));
    const method = (attributes.get("METHOD") ?? "NONE").toUpperCase();
    keys.push({
      method,
      keyFormat: attributes.get("KEYFORMAT") ?? IDENTITY,
      uri: attributes.get("URI") ?? "",
      ivHex: attributes.get("IV"),
    });
  }
  return keys;
}

function isIdentity(keyFormat: string): boolean {
  return keyFormat === "" || keyFormat.toLowerCase() === IDENTITY;
}

function isDrmKeyFormat(keyFormat: string): string | null {
  const value = keyFormat.toLowerCase();
  if (value === FAIRPLAY) return "FairPlay";
  if (value === WIDEVINE) return "Widevine";
  if (value === PLAYREADY) return "PlayReady";
  return null;
}

export function classifyEncryption(
  keys: KeyAttributes[],
  sessionKeys: KeyAttributes[],
  segments: M3u8Segment[],
  mediaSequence: number,
): EncryptionClass {
  const all = [...keys, ...sessionKeys];

  const identityAes = all.filter((key) => key.method === AES128 && isIdentity(key.keyFormat));
  const fallbackKey = identityAes[0];
  if (fallbackKey) {
    const entries = aesEntries(segments, mediaSequence);
    return { kind: "aes128", keys: entries.length > 0 ? entries : [toEntry(fallbackKey, 0)] };
  }

  for (const key of all) {
    if (key.method === "SAMPLE-AES") {
      const system = isDrmKeyFormat(key.keyFormat);
      if (system) return { kind: "drm", reason: `${system} (SAMPLE-AES)` };
      if (isIdentity(key.keyFormat)) {
        return {
          kind: "unsupported",
          reason: "SAMPLE-AES with an identity key is not decryptable in v1",
        };
      }
      return { kind: "unsupported", reason: `SAMPLE-AES with KEYFORMAT="${key.keyFormat}"` };
    }

    if (key.method === "SAMPLE-AES-CTR" || key.method === "SAMPLE-AES-CENC") {
      const system = isDrmKeyFormat(key.keyFormat);
      return { kind: "drm", reason: `${system ?? key.method} (${key.method})` };
    }

    if (key.method === AES128) {
      return {
        kind: "unsupported",
        reason: `AES-128 with non-identity KEYFORMAT="${key.keyFormat}"`,
      };
    }

    if (key.method !== "NONE") {
      return { kind: "unsupported", reason: `unsupported encryption METHOD="${key.method}"` };
    }
  }

  return { kind: "none" };
}

function toEntry(key: KeyAttributes, mediaSequence: number): KeyEntry {
  return {
    mediaSequence,
    keyUri: key.uri,
    ivHex: key.ivHex,
    keyFormat: key.keyFormat || IDENTITY,
  };
}

function aesEntries(segments: M3u8Segment[], mediaSequence: number): KeyEntry[] {
  const entries: KeyEntry[] = [];
  for (const [index, segment] of segments.entries()) {
    const key = segment.key;
    if (!key || key.method !== AES128) continue;
    const keyFormat = key.keyFormat ?? IDENTITY;
    if (!isIdentity(keyFormat)) continue;

    const sequence = mediaSequence + index;
    const ivHex = ivToHex(key.iv);
    const previous = entries.at(-1);
    if (previous && previous.keyUri === (key.uri ?? "") && previous.ivHex === ivHex) continue;

    entries.push({ mediaSequence: sequence, keyUri: key.uri ?? "", ivHex, keyFormat });
  }
  return entries.sort((a, b) => a.mediaSequence - b.mediaSequence);
}

function ivToHex(iv: M3u8KeyIv | undefined): string | undefined {
  if (!iv) return undefined;
  const words = [0, 1, 2, 3].map((index) =>
    Number((iv as Record<string, number>)[String(index)] ?? 0),
  );
  return `0x${words.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("")}`;
}

type M3u8KeyIv = Uint32Array | Record<string, number>;

function absolute(uri: string, base: string): string {
  return new URL(uri, base).toString();
}

function hostsOf(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {}
  }
  return [...hosts];
}

async function fetchText(url: string): Promise<{ text: string; contentType: string }> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`playlist request failed: HTTP ${response.status}`);
  return {
    text: await response.text(),
    contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
  };
}

function parse(text: string): M3u8Manifest {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  return parser.manifest;
}

function variantsOf(manifest: M3u8Manifest, base: string): Variant[] {
  return (manifest.playlists ?? []).map((playlist) => ({
    bandwidth: Number(playlist.attributes.BANDWIDTH ?? 0),
    resolution: playlist.attributes.RESOLUTION,
    uri: absolute(playlist.uri, base),
  }));
}

function hasAudioGroup(manifest: M3u8Manifest): boolean {
  const groups = manifest.mediaGroups?.AUDIO;
  if (!groups) return false;
  return Object.values(groups).some((names) =>
    Object.values(names).some((entry) => typeof entry.uri === "string" && entry.uri.length > 0),
  );
}

function urlSetOf(manifest: M3u8Manifest, base: string): string[] {
  const urls: string[] = [base];
  for (const variant of manifest.playlists ?? []) urls.push(absolute(variant.uri, base));
  for (const segment of manifest.segments ?? []) {
    urls.push(absolute(segment.uri, base));
    if (segment.key?.uri) urls.push(absolute(segment.key.uri, base));
    if (segment.map?.uri) urls.push(absolute(segment.map.uri, base));
  }
  for (const group of Object.values(manifest.mediaGroups?.AUDIO ?? {})) {
    for (const entry of Object.values(group)) {
      if (entry.uri) urls.push(absolute(entry.uri, base));
    }
  }
  return urls;
}

export async function inspectPlaylist(url: string): Promise<PlaylistPlan> {
  if (/\.mpd(\?|#|$)/i.test(url)) {
    throw new BlockedPlaylist("unsupported", "DASH (.mpd) is not supported in v1");
  }

  const { text, contentType } = await fetchText(url);
  if (contentType.includes("dash+xml") || text.trimStart().startsWith("<MPD")) {
    throw new BlockedPlaylist("unsupported", "DASH (.mpd) is not supported in v1");
  }
  if (!text.trimStart().startsWith("#EXTM3U")) {
    throw new BlockedPlaylist("unsupported", "the response is not an HLS playlist");
  }

  const manifest = parse(text);
  const variants = variantsOf(manifest, url);
  const isMaster = variants.length > 0;

  const mediaUrl = isMaster
    ? absolute(
        [...variants].sort((a, b) => b.bandwidth - a.bandwidth)[0]?.uri ?? variants[0]?.uri ?? url,
        url,
      )
    : url;

  const mediaText = isMaster ? (await fetchText(mediaUrl)).text : text;
  const media = isMaster ? parse(mediaText) : manifest;

  if (media.endList !== true) {
    throw new BlockedPlaylist("unsupported", "live playlist (no #EXT-X-ENDLIST) is not supported");
  }
  const segments = media.segments ?? [];
  if (segments.length < MIN_SEGMENTS) {
    throw new BlockedPlaylist("unsupported", "the playlist contains no segments");
  }

  const keys = scanKeys(mediaText, "EXT-X-KEY");
  const sessionKeys = scanKeys(text, "EXT-X-SESSION-KEY");
  const mediaSequence = Number(media.mediaSequence ?? 0);
  const encryption = classifyEncryption(keys, sessionKeys, segments, mediaSequence);

  if (encryption.kind === "drm") {
    throw new BlockedPlaylist("drm", `DRM-protected stream: ${encryption.reason}`);
  }
  if (encryption.kind === "unsupported") {
    throw new BlockedPlaylist("unsupported", encryption.reason);
  }

  const durationSeconds = segments.reduce((total, segment) => total + (segment.duration ?? 0), 0);
  const bandwidth = isMaster
    ? (variants.find((variant) => variant.uri === mediaUrl)?.bandwidth ?? 0)
    : 0;
  const estimatedBytes =
    bandwidth > 0 && durationSeconds > 0 ? Math.round((bandwidth * durationSeconds) / 8) : null;

  const audioGroup = isMaster && hasAudioGroup(manifest);

  return {
    url,
    isMaster,
    variants,
    inputUrl: isMaster && !audioGroup ? mediaUrl : url,
    encryption,
    durationSeconds,
    segmentCount: segments.length,
    estimatedBytes,
    hosts: hostsOf([...urlSetOf(manifest, url), ...urlSetOf(media, mediaUrl)]),
    live: false,
    hasAudioGroup: audioGroup,
  };
}
