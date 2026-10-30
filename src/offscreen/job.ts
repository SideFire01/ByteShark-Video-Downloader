import {
  Conversion,
  HLS_FORMATS,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
} from "mediabunny";
import { SIZE_CONFIRM_THRESHOLD_BYTES } from "@/src/shared/messages";
import type { JobProgress, JobState } from "@/src/shared/types";
import { deleteJobDir, outputHandle } from "./opfs";
import { BlockedPlaylist, inspectPlaylist, type PlaylistPlan } from "./parse-playlist";

const FETCH_PARALLELISM = 5;
const CHUNK_SIZE = 8 * 1024 * 1024;

interface Runner {
  jobId: string;
  tabId: number;
  cancelled: boolean;
  plan?: PlaylistPlan;
  blobUrl?: string;
  cleanup: Array<() => void>;
  variantResolver: ((uri: string) => void) | null;
  sizeResolver: ((accept: boolean) => void) | null;
  auto?: boolean;
}

const runners = new Map<string, Runner>();

function send(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch((error: unknown) => {
    const type = (message as { type?: string }).type ?? "?";
    console.warn(`[job] push ${type} failed`, error);
  });
}

function progress(runner: Runner, state: JobState, patch: Partial<JobProgress> = {}): void {
  const update: JobProgress = {
    jobId: runner.jobId,
    tabId: runner.tabId,
    state,
    ...patch,
  };
  send({ target: "sw", type: "OFFSCREEN_PROGRESS", progress: update });
}

function fail(
  runner: Runner,
  state: Extract<JobState, "ERROR" | "UNSUPPORTED" | "DRM_BLOCKED">,
  error: string,
): void {
  progress(runner, state, { error });
  send({ target: "sw", type: "OFFSCREEN_FAILED", jobId: runner.jobId, error, state });
}

function readyToSave(runner: Runner, blobUrl: string, filename: string): void {
  send({
    target: "sw",
    type: "OFFSCREEN_READY_TO_SAVE",
    jobId: runner.jobId,
    blobUrl,
    filename,
  });
}

function getOrCreate(jobId: string, tabId: number): Runner {
  const existing = runners.get(jobId);
  if (existing) return existing;
  const runner: Runner = {
    jobId,
    tabId,
    cancelled: false,
    cleanup: [],
    variantResolver: null,
    sizeResolver: null,
  };
  runners.set(jobId, runner);
  return runner;
}

function opfsSink(handle: FileSystemFileHandle): {
  writable: WritableStream<{ data: Uint8Array<ArrayBuffer>; position: number }>;
  bytesWritten: () => number;
  dispose: () => Promise<void>;
} {
  let writer: FileSystemWritableFileStream | null = null;
  let written = 0;

  const writable = new WritableStream<{ data: Uint8Array<ArrayBuffer>; position: number }>({
    async start() {
      writer = await handle.createWritable();
    },
    async write(chunk) {
      if (!writer) throw new Error("OPFS sink was written to before it started");
      await writer.write({ type: "write", position: chunk.position, data: chunk.data });
      written += chunk.data.byteLength;
    },
    async close() {
      const open = writer;
      writer = null;
      await open?.close();
    },
    async abort(reason) {
      const open = writer;
      writer = null;
      await open?.abort(reason);
    },
  });

  return {
    writable,
    bytesWritten: () => written,
    async dispose() {
      const open = writer;
      writer = null;
      if (!open) return;
      try {
        await open.abort("job finished");
      } catch {}
    },
  };
}

async function requestHosts(runner: Runner, hosts: string[]): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      target: "sw",
      type: "OFFSCREEN_HOSTS",
      jobId: runner.jobId,
      hosts,
    });
  } catch (error) {
    console.warn(`[job] ${runner.jobId}: could not widen DNR rules`, error);
  }
}

function waitForVariant(runner: Runner, fallback: string): Promise<string> {
  return new Promise<string>((resolve) => {
    runner.variantResolver = (uri) => {
      runner.variantResolver = null;
      resolve(uri);
    };
    setTimeout(() => {
      if (!runner.variantResolver) return;
      runner.variantResolver = null;
      resolve(fallback);
    }, 5 * 60_000);
  });
}

function waitForSize(runner: Runner): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    runner.sizeResolver = (accept) => {
      runner.sizeResolver = null;
      resolve(accept);
    };
  });
}

async function assemble(runner: Runner, inputUrl: string, filename: string): Promise<void> {
  const handle = await outputHandle(runner.jobId);
  const sink = opfsSink(handle);

  const source = new UrlSource(inputUrl, { parallelism: FETCH_PARALLELISM });
  const input = new Input({ source, formats: HLS_FORMATS });
  const target = new StreamTarget(sink.writable, { chunked: true, chunkSize: CHUNK_SIZE });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });

  runner.cleanup.push(() => input.dispose());
  runner.cleanup.push(() => void sink.dispose());

  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    video: {},
    audio: {},
  });

  if (!conversion.isValid) {
    throw new Error("no playable tracks were found in this stream");
  }

  let lastReport = 0;
  conversion.onProgress = (fraction, processedTime) => {
    const now = Date.now();
    if (now - lastReport < 300) return;
    lastReport = now;
    progress(runner, "PROCESSING", {
      segmentsDone: Math.round(fraction * (runner.plan?.segmentCount ?? 0)),
      segmentsTotal: runner.plan?.segmentCount,
      bytesWritten: sink.bytesWritten(),
      estimatedBytes: runner.plan?.estimatedBytes ?? undefined,
      filename,
    });
    void processedTime;
  };

  runner.cleanup.push(() => {
    if (conversion.state === "executing") conversion.cancel();
  });

  progress(runner, "PROCESSING", {
    segmentsTotal: runner.plan?.segmentCount,
    bytesWritten: 0,
    estimatedBytes: runner.plan?.estimatedBytes ?? undefined,
    filename,
  });

  await conversion.execute();

  if (runner.cancelled) throw new Error("cancelled");

  const file = await handle.getFile();
  progress(runner, "PROCESSING", {
    segmentsDone: runner.plan?.segmentCount,
    segmentsTotal: runner.plan?.segmentCount,
    bytesWritten: file.size,
    filename,
  });

  runner.blobUrl = URL.createObjectURL(file);
  readyToSave(runner, runner.blobUrl, filename);
}

async function runHls(
  runner: Runner,
  playlistUrl: string,
  filename: string,
  presetVariantUri?: string,
): Promise<void> {
  progress(runner, "QUEUED", { filename });
  const plan = await inspectPlaylist(playlistUrl);
  runner.plan = plan;

  if (plan.variants.length > 0) {
    send({
      target: "sw",
      type: "OFFSCREEN_VARIANTS",
      jobId: runner.jobId,
      variants: plan.variants,
    });
  }

  const preset =
    presetVariantUri !== undefined &&
    (plan.variants.length === 0 || plan.variants.some((variant) => variant.uri === presetVariantUri))
      ? presetVariantUri
      : undefined;

  let chosen = preset ?? plan.variants[0]?.uri;

  if (plan.variants.length > 1) {
    const highest = [...plan.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (preset !== undefined) {
      chosen = preset;
    } else if (runner.auto) {
      chosen = highest?.uri ?? playlistUrl;
    } else {
      chosen = await waitForVariant(runner, highest?.uri ?? playlistUrl);
    }
  }

  if (runner.cancelled) return;

  const inputUrl = plan.hasAudioGroup ? plan.url : (chosen ?? plan.inputUrl);

  if (plan.estimatedBytes !== null) {
    send({
      target: "sw",
      type: "OFFSCREEN_SIZE_ESTIMATE",
      jobId: runner.jobId,
      estimatedBytes: plan.estimatedBytes,
    });

    if (plan.estimatedBytes > SIZE_CONFIRM_THRESHOLD_BYTES && !runner.auto) {
      progress(runner, "QUEUED", {
        estimatedBytes: plan.estimatedBytes,
        filename,
      });
      const accepted = await waitForSize(runner);
      if (!accepted || runner.cancelled) {
        await deleteJobDir(runner.jobId);
        runners.delete(runner.jobId);
        return;
      }
    }
  }

  await requestHosts(runner, plan.hosts);
  await assemble(runner, inputUrl, filename);
}

async function runFetch(runner: Runner, url: string, filename: string): Promise<void> {
  progress(runner, "PROCESSING", { filename, bytesWritten: 0 });

  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`the server refused the download (HTTP ${response.status})`);
  }
  if (!response.body) throw new Error("the response had no body");

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html")) {
    throw new Error("that address returned a web page, not a video file");
  }

  const announced = Number(response.headers.get("content-length") ?? "0");
  const estimatedBytes = Number.isFinite(announced) && announced > 0 ? announced : undefined;

  const handle = await outputHandle(runner.jobId);
  const writer = await handle.createWritable();
  runner.cleanup.push(() => void writer.abort().catch(() => {}));

  const reader = response.body.getReader();
  let written = 0;
  let lastReport = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (runner.cancelled) {
      await reader.cancel().catch(() => {});
      throw new Error("cancelled");
    }

    if (written === 0) {
      const head = new TextDecoder().decode(value.subarray(0, 64)).trimStart().toLowerCase();
      if (
        head.startsWith("<!doctype html") ||
        head.startsWith("<html") ||
        head.startsWith("<?xml")
      ) {
        await reader.cancel().catch(() => {});
        throw new Error("that address returned a web page, not a video file");
      }
    }

    await writer.write(value);
    written += value.byteLength;

    const now = Date.now();
    if (now - lastReport >= 250) {
      lastReport = now;
      progress(runner, "PROCESSING", { bytesWritten: written, estimatedBytes, filename });
    }
  }

  await writer.close();

  if (written === 0) throw new Error("the download was empty");

  const file = await handle.getFile();
  runner.blobUrl = URL.createObjectURL(file);

  progress(runner, "PROCESSING", {
    bytesWritten: file.size,
    estimatedBytes,
    filename,
  });

  readyToSave(runner, runner.blobUrl, filename);
}

export interface StartHlsOptions {
  jobId: string;
  tabId: number;
  playlistUrl: string;
  filename: string;
  variantUri?: string;
  auto?: boolean;
}

export function startHls(options: StartHlsOptions): void {
  if (runners.has(options.jobId)) {
    console.info(`[job] ${options.jobId}: already running`);
    return;
  }
  const runner = getOrCreate(options.jobId, options.tabId);
  if (options.auto) runner.auto = true;

  void (async () => {
    try {
      await runHls(runner, options.playlistUrl, options.filename, options.variantUri);
    } catch (error) {
      if (runner.cancelled) return;
      if (error instanceof BlockedPlaylist) {
        fail(runner, error.kind === "drm" ? "DRM_BLOCKED" : "UNSUPPORTED", error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      fail(runner, "ERROR", message);
    }
  })();
}

export function startFetch(options: {
  jobId: string;
  tabId: number;
  url: string;
  filename: string;
}): void {
  if (runners.has(options.jobId)) return;
  const runner = getOrCreate(options.jobId, options.tabId);

  void (async () => {
    try {
      await runFetch(runner, options.url, options.filename);
    } catch (error) {
      if (runner.cancelled) return;
      fail(runner, "ERROR", error instanceof Error ? error.message : String(error));
    }
  })();
}

export function selectVariant(jobId: string, variantUri: string): void {
  runners.get(jobId)?.variantResolver?.(variantUri);
}

export function confirmSize(jobId: string, accept: boolean): void {
  runners.get(jobId)?.sizeResolver?.(accept);
}

export async function cancelJob(jobId: string): Promise<void> {
  const runner = runners.get(jobId);
  if (!runner) return;
  runner.cancelled = true;
  for (const cleanup of runner.cleanup) {
    try {
      cleanup();
    } catch {}
  }
  if (runner.blobUrl) {
    URL.revokeObjectURL(runner.blobUrl);
    runner.blobUrl = undefined;
  }
  await deleteJobDir(jobId);
  runners.delete(jobId);
  send({ target: "sw", type: "OFFSCREEN_CLEANED", jobId });
}

export async function revokeAndClean(jobId: string): Promise<void> {
  const runner = runners.get(jobId);

  if (runner?.blobUrl) {
    URL.revokeObjectURL(runner.blobUrl);
    runner.blobUrl = undefined;
  }
  for (const cleanup of runner?.cleanup ?? []) {
    try {
      cleanup();
    } catch {}
  }

  await deleteJobDir(jobId);
  runners.delete(jobId);

  send({ target: "sw", type: "OFFSCREEN_CLEANED", jobId });
}

export function activeJobs(): string[] {
  return [...runners.keys()];
}
