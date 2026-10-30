import {
  BlockedPlaylist,
  inspectPlaylist,
  type PlaylistPlan,
} from "@/src/offscreen/parse-playlist";
import type { DetectedMedia, VariantDetail } from "@/src/shared/types";
import { patchDetection } from "./detection";
import { installJobRules, removeJobRules } from "./dnr-rules";
import { mp4DurationSeconds } from "./mp4-duration";

const PROBE_TTL_MS = 10 * 60_000;

const inFlight = new Set<string>();

export function probeMediaFacts(media: DetectedMedia[]): void {
  for (const entry of media) void probe(entry);
}

function needsProbe(media: DetectedMedia): boolean {
  if (media.kind === "hls") return media.estimatedBytes === undefined;
  return media.durationSeconds === undefined;
}

async function probe(media: DetectedMedia): Promise<void> {
  if (!needsProbe(media)) return;
  if (media.probeAt !== undefined && Date.now() - media.probeAt < PROBE_TTL_MS) return;
  if (inFlight.has(media.id)) return;

  inFlight.add(media.id);
  const probeId = `probe:${media.id}`;
  try {
    const facts =
      media.kind === "hls" ? await hlsFacts(media, probeId) : await mp4Facts(media, probeId);
    await patchDetection(media.tabId, media.id, { probeAt: Date.now(), ...facts });
  } catch (error) {
    await patchDetection(media.tabId, media.id, { probeAt: Date.now() });
    console.debug(`[probe] ${media.url}: no facts (${String(error)})`);
  } finally {
    await removeJobRules(probeId).catch(() => {});
    inFlight.delete(media.id);
  }
}

async function hlsFacts(media: DetectedMedia, probeId: string): Promise<Partial<DetectedMedia>> {
  const plan = await readPlan(media, probeId);
  const estimates = perVariantEstimates(plan);
  const details = perVariantDetails(plan);

  return {
    ...(plan.estimatedBytes !== null ? { estimatedBytes: plan.estimatedBytes } : {}),
    ...(plan.durationSeconds > 0 ? { durationSeconds: plan.durationSeconds } : {}),
    ...(Object.keys(estimates).length > 0 ? { variantEstimates: estimates } : {}),
    ...(Object.keys(details).length > 0 ? { variantDetails: details } : {}),
    ...(plan.isMaster
      ? {
          variantUris: plan.variants.map((variant) => variant.uri),
          hasAudioGroup: plan.hasAudioGroup,
        }
      : {}),
  };
}

async function mp4Facts(media: DetectedMedia, probeId: string): Promise<Partial<DetectedMedia>> {
  const duration = await durationWithFallback(media, probeId);
  return duration === null ? {} : { durationSeconds: duration };
}

async function durationWithFallback(media: DetectedMedia, probeId: string): Promise<number | null> {
  const direct = await mp4DurationSeconds(media.url).catch(() => null);
  if (direct !== null) return direct;

  await installJobRules(probeId, media);
  return mp4DurationSeconds(media.url).catch(() => null);
}

async function readPlan(media: DetectedMedia, probeId: string): Promise<PlaylistPlan> {
  try {
    return await inspectPlaylist(media.url);
  } catch (error) {
    if (error instanceof BlockedPlaylist) throw error;

    await installJobRules(probeId, media);
    const extraHosts = await playlistHosts(media.url);
    if (extraHosts.length > 0) await installJobRules(probeId, media, extraHosts);
    return inspectPlaylist(media.url);
  }
}

function perVariantEstimates(plan: PlaylistPlan): Record<string, number> {
  if (plan.durationSeconds <= 0) return {};
  const estimates: Record<string, number> = {};
  for (const variant of plan.variants) {
    if (variant.bandwidth > 0) {
      estimates[variant.uri] = Math.round((variant.bandwidth * plan.durationSeconds) / 8);
    }
  }
  return estimates;
}

function perVariantDetails(plan: PlaylistPlan): Record<string, VariantDetail> {
  const details: Record<string, VariantDetail> = {};
  for (const variant of plan.variants) {
    const width = variant.resolution?.width;
    const height = variant.resolution?.height;
    if (variant.bandwidth <= 0 && width === undefined && height === undefined) continue;
    details[variant.uri] = {
      bandwidth: variant.bandwidth,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  }
  return details;
}

const URI_IN_TAG = /URI="([^"]+)"/g;

async function playlistHosts(url: string): Promise<string[]> {
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) return [];

    const text = await response.text();
    const candidates = [...text.matchAll(URI_IN_TAG)].map((match) => match[1] ?? "");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed !== "" && !trimmed.startsWith("#")) candidates.push(trimmed);
    }

    const hosts = new Set<string>();
    for (const candidate of candidates) {
      try {
        hosts.add(new URL(candidate, url).hostname);
      } catch {}
    }
    return [...hosts];
  } catch {
    return [];
  }
}
