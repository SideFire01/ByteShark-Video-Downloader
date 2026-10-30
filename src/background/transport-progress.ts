import { publishProgress } from "./jobs";
import { getJob } from "./storage";

const POLL_MS = 400;

const tracked = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

export function trackTransportProgress(jobId: string): void {
  tracked.add(jobId);
  if (timer !== null) return;
  timer = setInterval(() => {
    void poll();
  }, POLL_MS);
}

async function poll(): Promise<void> {
  for (const jobId of [...tracked]) {
    const job = await getJob(jobId);
    if (job?.state !== "SAVING" || job.downloadId === undefined) {
      tracked.delete(jobId);
      continue;
    }

    const [item] = await chrome.downloads.search({ id: job.downloadId });
    if (!item) {
      tracked.delete(jobId);
      continue;
    }

    await publishProgress(job, {
      bytesWritten: item.bytesReceived,
      estimatedBytes: item.totalBytes > 0 ? item.totalBytes : job.estimatedBytes,
    });
  }

  if (tracked.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
