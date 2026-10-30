import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type LaunchMode, switchSurface } from "@/src/shared/launch-mode";
import {
  errorMessage,
  type MediaListReply,
  type PopupToSW,
  STORAGE_PREFIX,
  type SWToPopup,
} from "@/src/shared/messages";
import type {
  DetectedMedia,
  JobProgress,
  JobRecord,
  JobState,
  Variant,
  VariantDetail,
} from "@/src/shared/types";
import styles from "./styles.module.css";

const RENDER_INTERVAL_MS = 250;

const STATE_LABEL: Record<JobState, string> = {
  DETECTED: "Detected",
  QUEUED: "Queued",
  CHOOSING: "Choose quality",
  PROCESSING: "Downloading",
  SAVING: "Saving",
  DONE: "Done",
  CANCELLED: "Cancelled",
  DRM_BLOCKED: "DRM protected",
  UNSUPPORTED: "Unsupported",
  ERROR: "Failed",
};

const TERMINAL: JobState[] = ["DONE", "CANCELLED", "DRM_BLOCKED", "UNSUPPORTED", "ERROR"];

interface QualityOption {
  uri: string;
  label: string;
  detail: VariantDetail;
}

const RETRYABLE: JobState[] = ["DETECTED", "CANCELLED"];

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function sizeLabel(media: DetectedMedia, variantUri?: string): string {
  if (media.kind === "mp4") return formatBytes(media.estimatedBytes);

  const estimates = Object.values(media.variantEstimates ?? {});
  const picked = variantUri !== undefined ? media.variantEstimates?.[variantUri] : undefined;
  const bytes =
    picked ?? (estimates.length > 0 ? Math.max(...estimates) : (media.estimatedBytes ?? 0));
  const text = formatBytes(bytes);
  return text === "" ? "" : `~${text}`;
}

function bestVariant(media: DetectedMedia): VariantDetail | null {
  let withHeight: VariantDetail | null = null;
  let anyVariant: VariantDetail | null = null;

  for (const detail of Object.values(media.variantDetails ?? {})) {
    if (!anyVariant || detail.bandwidth > anyVariant.bandwidth) anyVariant = detail;
    if (detail.height === undefined) continue;
    if (!withHeight || detail.bandwidth > withHeight.bandwidth) withHeight = detail;
  }

  return withHeight ?? anyVariant;
}

function bitrateLabel(bandwidth: number): string {
  return bandwidth >= 1_000_000
    ? `${(bandwidth / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(bandwidth / 1000)} kbps`;
}

function qualityOptions(media: DetectedMedia): QualityOption[] {
  if (media.kind !== "hls") return [];

  const entries = Object.entries(media.variantDetails ?? {});
  const withHeight = entries.filter(([, detail]) => detail.height !== undefined);
  const pool = withHeight.length > 0 ? withHeight : entries;
  if (pool.length < 2) return [];

  const sorted = pool
    .map(([uri, detail]) => ({ uri, detail }))
    .sort((a, b) => b.detail.bandwidth - a.detail.bandwidth);

  const heights = new Map<string, number>();
  for (const { detail } of sorted) {
    if (detail.height === undefined) continue;
    const name = `${detail.height}p`;
    heights.set(name, (heights.get(name) ?? 0) + 1);
  }

  return sorted.map(({ uri, detail }) => {
    const name = detail.height !== undefined ? `${detail.height}p` : bitrateLabel(detail.bandwidth);
    const ambiguous = detail.height !== undefined && (heights.get(name) ?? 0) > 1;
    return {
      uri,
      detail,
      label: ambiguous ? `${name} · ${bitrateLabel(detail.bandwidth)}` : name,
    };
  });
}

function resolveQuality(
  media: DetectedMedia,
  choice: Record<string, string>,
): { options: QualityOption[]; picked: QualityOption | null } {
  const options = qualityOptions(media);
  const uri = choice[media.id];
  return { options, picked: options.find((option) => option.uri === uri) ?? options[0] ?? null };
}

function rowFacts(media: DetectedMedia, picked: QualityOption | null): Array<{ key: string; text: string }> {
  const facts: Array<{ key: string; text: string }> = [];

  const quality = picked?.detail ?? bestVariant(media);
  if (picked === null && quality?.height !== undefined) {
    facts.push({ key: "resolution", text: `${quality.height}p` });
  }

  const duration = formatDuration(media.durationSeconds);
  if (duration !== "") facts.push({ key: "duration", text: duration });

  const size = sizeLabel(media, picked?.uri);
  if (size !== "") facts.push({ key: "size", text: size });

  return facts;
}

function progressPercent(live: JobProgress | undefined): number | null {
  if (live?.segmentsTotal && live.segmentsDone !== undefined) {
    return Math.min(100, (live.segmentsDone / live.segmentsTotal) * 100);
  }
  const written = live?.bytesWritten ?? 0;
  const total = live?.estimatedBytes ?? 0;
  if (written > 0 && total > 0) return Math.min(100, (written / total) * 100);
  return null;
}

function progressLabel(live: JobProgress | undefined): string {
  const bytes = formatBytes(live?.bytesWritten);
  if (live?.segmentsTotal) {
    return `${live.segmentsDone ?? 0} / ${live.segmentsTotal} segments ${bytes}`.trim();
  }
  const total = formatBytes(live?.estimatedBytes);
  if (bytes !== "" && total !== "") return `${bytes} of ${total}`;
  return bytes !== "" ? bytes : "working…";
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function fileName(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return url;
  }
}

async function readProgress(): Promise<Record<string, JobProgress>> {
  const stored = await chrome.storage.session.get(null);
  const progress: Record<string, JobProgress> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(STORAGE_PREFIX.progress)) continue;
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Partial<JobProgress>;
    if (typeof entry.jobId === "string") progress[entry.jobId] = entry as JobProgress;
  }
  return progress;
}

function send(message: PopupToSW): void {
  void chrome.runtime.sendMessage(message).catch((error: unknown) => {
    console.warn("[popup] send failed", errorMessage(error));
  });
}

async function resolveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let id = tab?.id ?? -1;

  if (id < 0 || (tab?.url ?? "").startsWith("chrome-extension://")) {
    const candidates = (await chrome.tabs.query({})).filter(
      (candidate) =>
        candidate.id !== undefined && !(candidate.url ?? "").startsWith("chrome-extension://"),
    );
    candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    id = candidates[0]?.id ?? -1;
  }

  return id;
}

function Heading({ count }: { count: number }) {
  return (
    <h1 class={styles.heading}>
      Videos detected: <span class={styles.count}>{count}</span>
    </h1>
  );
}

function PopupIcon() {
  return (
    <svg
      class={styles.icon}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <rect x="8.25" y="6.25" width="5.5" height="6.5" rx="1.5" />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg
      class={styles.icon}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M9.75 2.75v10.5" />
    </svg>
  );
}

export function App({ fluid = false }: { fluid?: boolean } = {}) {
  const [tabId, setTabId] = useState<number | null>(null);
  const [view, setView] = useState<MediaListReply>({
    media: [],
    jobs: [],
    variants: {},
    launchMode: "panel",
  });
  const [launchMode, setLaunchMode] = useState<LaunchMode>("panel");
  const [progress, setProgress] = useState<Record<string, JobProgress>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [qualityChoice, setQualityChoice] = useState<Record<string, string>>({});
  const refreshAt = useRef(0);
  const pending = useRef<number | null>(null);

  const refresh = useCallback(async (id: number) => {
    try {
      const reply = (await chrome.runtime.sendMessage({
        target: "sw",
        type: "POPUP_LIST_MEDIA",
        tabId: id,
      })) as MediaListReply | undefined;

      if (reply && Array.isArray(reply.media)) {
        setView(reply);
        if (reply.launchMode !== undefined) setLaunchMode(reply.launchMode);
      }
      setProgress(await readProgress());
    } catch (error) {
      setNotice(`Could not read detections: ${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const scheduleRefresh = useCallback(
    (id: number) => {
      const now = Date.now();
      const wait = Math.max(0, RENDER_INTERVAL_MS - (now - refreshAt.current));
      if (pending.current !== null) return;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        refreshAt.current = Date.now();
        void refresh(id);
      }, wait);
    },
    [refresh],
  );

  useEffect(() => {
    let cancelled = false;

    const sync = async (): Promise<void> => {
      const id = await resolveTabId();
      if (cancelled) return;
      if (id < 0) {
        setNotice("Open a page with a video, then try again.");
        setLoading(false);
        return;
      }
      setTabId(id);
      await refresh(id);
    };

    void sync();

    const onActivated = (): void => void sync();
    const onUpdated = (_tabId: number, info: chrome.tabs.TabChangeInfo): void => {
      if (info.status === "complete") void sync();
    };
    const onRemoved = (): void => void sync();

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
  }, [refresh]);

  useEffect(() => {
    if (tabId === null) return;

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== "session") return;
      if (Object.keys(changes).some((key) => key.startsWith(STORAGE_PREFIX.progress))) {
        scheduleRefresh(tabId);
      }
    };

    const onMessage = (message: unknown): boolean => {
      const incoming = message as SWToPopup | undefined;
      if (incoming?.target !== "popup") return false;
      if (incoming.type === "POPUP_ERROR") setNotice(incoming.message);
      scheduleRefresh(tabId);
      return false;
    };

    chrome.storage.onChanged.addListener(onChanged);
    chrome.runtime.onMessage.addListener(onMessage);

    const poll = window.setInterval(() => void refresh(tabId), 1000);

    return () => {
      chrome.storage.onChanged.removeListener(onChanged);
      chrome.runtime.onMessage.removeListener(onMessage);
      window.clearInterval(poll);
      if (pending.current !== null) window.clearTimeout(pending.current);
    };
  }, [tabId, refresh, scheduleRefresh]);

  const jobsByMedia = useMemo(() => {
    const map = new Map<string, JobRecord>();
    const rank = (job: JobRecord): number => (TERMINAL.includes(job.state) ? 1 : 0);
    for (const job of view.jobs) {
      const existing = map.get(job.mediaId);
      if (!existing || rank(existing) > rank(job) || existing.createdAt < job.createdAt) {
        map.set(job.mediaId, job);
      }
    }
    return map;
  }, [view.jobs]);

  const pickVariant = (job: JobRecord, variant: Variant): void => {
    send({ target: "sw", type: "POPUP_START_HLS", mediaId: job.mediaId, variantUri: variant.uri });
  };

  const selectable = useMemo(
    () =>
      view.media.filter((media) => {
        const job = jobsByMedia.get(media.id);
        if (!job) return true;
        const state = (progress[job.jobId]?.state ?? job.state) as JobState;
        return RETRYABLE.includes(state);
      }),
    [view.media, jobsByMedia, progress],
  );

  const selectedRows = selectable.filter((media) => selected.has(media.id));
  const allSelected = selectable.length > 0 && selectedRows.length === selectable.length;
  const showSelection = selectable.length > 1;

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(selectable.map((media) => media.id)));
  };

  const toggleOne = (mediaId: string, checked: boolean): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(mediaId);
      else next.delete(mediaId);
      return next;
    });
  };

  const downloadSelected = (): void => {
    if (selectedRows.length === 0) return;
    const variantUris: Record<string, string> = {};
    for (const media of selectedRows) {
      const { picked } = resolveQuality(media, qualityChoice);
      if (picked !== null) variantUris[media.id] = picked.uri;
    }
    send({
      target: "sw",
      type: "POPUP_START_MANY",
      mediaIds: selectedRows.map((media) => media.id),
      ...(Object.keys(variantUris).length > 0 ? { variantUris } : {}),
    });
    setSelected(new Set());
  };

  const toggleLaunchMode = (): void => {
    const next: LaunchMode = launchMode === "panel" ? "popup" : "panel";
    const leavingPopup = launchMode === "popup";
    setLaunchMode(next);

    void (async () => {
      const { mode, opened, detail } = await switchSurface(next, tabId);
      if (mode !== next) setLaunchMode(mode);
      if (!opened) {
        setNotice(
          `${mode === "panel" ? "Side panel" : "Popup"} mode is on — Chrome could not open it here.` +
            (detail ? ` (${detail})` : "") +
            " Click the toolbar icon.",
        );
        return;
      }
      if (leavingPopup) window.close();
    })();
  };

  const row = (media: DetectedMedia) => {
    const job = jobsByMedia.get(media.id);
    const live = job ? progress[job.jobId] : undefined;
    const state = (live?.state ?? job?.state ?? "DETECTED") as JobState;
    const blocked = TERMINAL.includes(state) && state !== "DONE" && state !== "CANCELLED";
    const { options, picked } = resolveQuality(media, qualityChoice);
    const facts = rowFacts(media, picked);
    const percent = progressPercent(live);
    const canStart = !job || RETRYABLE.includes(state);
    const isSelected = selected.has(media.id) && canStart;
    const selectableRow = showSelection && canStart;

    const toggleRow = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("button, input, select, label, a")) return;
      if (!(window.getSelection()?.isCollapsed ?? true)) return;
      toggleOne(media.id, !selected.has(media.id));
    };

    const toggleRowKey = (event: KeyboardEvent): void => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      toggleOne(media.id, !selected.has(media.id));
    };

    return (
      <li
        key={media.id}
        class={`${styles.row} ${isSelected ? styles.rowSelected : ""} ${
          selectableRow ? styles.rowSelectable : ""
        }`}
        role={selectableRow ? "button" : undefined}
        tabIndex={selectableRow ? 0 : undefined}
        aria-label={
          selectableRow
            ? `${isSelected ? "Deselect" : "Select"} ${fileName(media.url)}`
            : undefined
        }
        onClick={selectableRow ? toggleRow : undefined}
        onKeyDown={selectableRow ? toggleRowKey : undefined}
      >
        <div class={styles.rowHead}>
          <span class={`${styles.kind} ${styles[media.kind]}`}>{media.kind.toUpperCase()}</span>
          <span class={styles.name} title={media.url}>
            {fileName(media.url)}
          </span>
          {state !== "DETECTED" && (
            <span class={`${styles.state} ${styles[`state_${state}`]}`}>{STATE_LABEL[state]}</span>
          )}
        </div>

        {(options.length > 0 || facts.length > 0 || canStart) && (
          <div class={styles.rowFoot}>
            {(options.length > 0 || facts.length > 0) && (
              <div class={styles.meta}>
                {options.length > 0 && (
                  <select
                    class={styles.quality}
                    aria-label={`Quality for ${fileName(media.url)}`}
                    value={picked?.uri ?? ""}
                    disabled={!canStart}
                    onChange={(event) =>
                      setQualityChoice((previous) => ({
                        ...previous,
                        [media.id]: event.currentTarget.value,
                      }))
                    }
                  >
                    {options.map((option) => (
                      <option key={option.uri} value={option.uri}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}

                {facts.map((fact) => (
                  <span key={fact.key} class={styles.fact}>
                    {fact.text}
                  </span>
                ))}
              </div>
            )}

            {canStart && (
              <button
                type="button"
                class={`${styles.primary} ${styles.rowDownload}`}
                onClick={() =>
                  media.kind === "mp4"
                    ? send({ target: "sw", type: "POPUP_START_MP4", mediaId: media.id })
                    : send({
                        target: "sw",
                        type: "POPUP_START_HLS",
                        mediaId: media.id,
                        ...(picked !== null ? { variantUri: picked.uri } : {}),
                      })
                }
              >
                Download
              </button>
            )}
          </div>
        )}

        {job && state === "CHOOSING" && (
          <div class={styles.variants}>
            <p class={styles.hint}>Pick a quality:</p>
            {(view.variants[job.jobId] ?? []).map((variant) => (
              <button
                key={variant.uri}
                type="button"
                class={styles.variant}
                onClick={() => pickVariant(job, variant)}
              >
                {variant.resolution
                  ? `${variant.resolution.width}×${variant.resolution.height}`
                  : "variant"}
                <span class={styles.muted}> {Math.round(variant.bandwidth / 1000)} kbps</span>
                {media.variantEstimates?.[variant.uri] !== undefined && (
                  <span class={styles.muted}>
                    {" "}
                    · ~{formatBytes(media.variantEstimates[variant.uri])}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {job?.awaitingSizeConfirm && live?.state !== "DETECTED" && (
          <div class={styles.dialog}>
            <p>
              This stream is estimated at <strong>{formatBytes(job.estimatedBytes)}</strong>. It
              will use roughly that much disk space while it assembles.
            </p>
            <button
              type="button"
              class={styles.primary}
              onClick={() =>
                send({ target: "sw", type: "POPUP_CONFIRM_SIZE", jobId: job.jobId, accept: true })
              }
            >
              Continue
            </button>
            <button
              type="button"
              onClick={() =>
                send({ target: "sw", type: "POPUP_CONFIRM_SIZE", jobId: job.jobId, accept: false })
              }
            >
              Cancel
            </button>
          </div>
        )}

        {job && (state === "PROCESSING" || state === "SAVING") && (
          <div class={styles.progressWrap}>
            <div class={styles.progressTrack}>
              <div
                class={`${styles.progressBar} ${percent === null ? styles.progressIndeterminate : ""}`}
                style={{ width: percent === null ? "35%" : `${percent}%` }}
              />
            </div>
            <span class={styles.muted}>{progressLabel(live)}</span>
          </div>
        )}

        {job && (state === "PROCESSING" || state === "QUEUED") && !job.awaitingSizeConfirm && (
          <button
            type="button"
            class={styles.danger}
            onClick={() => send({ target: "sw", type: "POPUP_CANCEL", jobId: job.jobId })}
          >
            Cancel
          </button>
        )}

        {blocked && <p class={styles.error}>{live?.error ?? job?.error ?? STATE_LABEL[state]}</p>}

        {state === "DONE" && (
          <p class={styles.hint}>{job?.filename ?? "Saved to your downloads."}</p>
        )}
      </li>
    );
  };

  return (
    <main class={`${styles.app} ${fluid ? styles.appFluid : ""}`}>
      <header class={styles.header}>
        <div class={styles.brand}>
          <img class={styles.logo} src="/logo.png" alt="" />
          <h1 class={styles.title}>ByteShark Video Downloader</h1>
        </div>
        <div class={styles.headerActions}>
          <button
            type="button"
            class={styles.modeToggle}
            aria-label={launchMode === "panel" ? "Switch to popup" : "Switch to side panel"}
            title={
              launchMode === "panel"
                ? "Clicking the toolbar icon opens this panel. Switch to a popup instead."
                : "Clicking the toolbar icon opens a popup. Switch to the docked panel instead."
            }
            onClick={toggleLaunchMode}
          >
            {launchMode === "panel" ? <PopupIcon /> : <PanelIcon />}
          </button>
        </div>
      </header>

      {notice && <p class={styles.error}>{notice}</p>}

      {tabId !== null && (
        <div class={styles.toolbar}>
          {showSelection && (
            <button type="button" onClick={toggleAll}>
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          )}
          {showSelection && (
            <button
              type="button"
              class={styles.primary}
              disabled={selectedRows.length === 0}
              onClick={downloadSelected}
            >
              Download selected{selectedRows.length > 0 ? ` (${selectedRows.length})` : ""}
            </button>
          )}
          <Heading count={view.media.length} />
        </div>
      )}

      <ul class={styles.list}>
        {view.media.map(row)}
        {!loading && view.media.length === 0 && (
          <li class={styles.empty}>
            No downloadable video found on this page yet. Start playback and reopen this popup.
          </li>
        )}
        {loading && <li class={styles.empty}>Looking for media…</li>}
      </ul>

      {fluid && (
        <footer class={styles.footer}>
          <img class={styles.helloShark} src="/shark-hello.png" alt="" />
        </footer>
      )}
    </main>
  );
}
