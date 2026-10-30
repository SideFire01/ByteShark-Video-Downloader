const OPAQUE = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16,}$/i,
  /^[A-Za-z0-9_-]{22,}$/,
];

export function looksOpaque(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  return OPAQUE.some((pattern) => pattern.test(trimmed));
}

interface TitleCandidates {
  meta: string;
  document: string;
  heading: string;
}

function readTitleCandidates(): TitleCandidates {
  const meta: string[] = [];
  for (const name of ["og:title", "video:title", "twitter:title"]) {
    const element =
      document.querySelector(`meta[property="${name}"]`) ??
      document.querySelector(`meta[name="${name}"]`);
    const content = element?.getAttribute("content")?.trim();
    if (content) meta.push(content);
  }

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed: unknown = JSON.parse(script.textContent ?? "");
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const record = node as { "@type"?: unknown; name?: unknown };
        const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
        if (types.includes("VideoObject") && typeof record.name === "string") {
          meta.push(record.name.trim());
        }
      }
    } catch {
    }
  }

  return {
    meta: meta.join("\n"),
    document: document.title,
    heading: document.querySelector("h1")?.textContent?.trim() ?? "",
  };
}

async function readInPage(tabId: number): Promise<TitleCandidates | null> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readTitleCandidates,
    });
    return (result?.result as TitleCandidates | undefined) ?? null;
  } catch (error) {
    console.debug(`[title] cannot read page metadata for tab ${tabId}: ${String(error)}`);
    return null;
  }
}

export async function pageTitle(tabId: number): Promise<string | null> {
  const seen = await readInPage(tabId);
  if (!seen) return null;

  for (const candidate of seen.meta.split("\n")) {
    if (!looksOpaque(candidate)) return candidate.trim();
  }
  if (!looksOpaque(seen.document)) return seen.document.trim();
  if (!looksOpaque(seen.heading)) return seen.heading.trim();
  return null;
}

export async function titleReport(tabId: number): Promise<Record<string, unknown>> {
  const [seen, tab] = await Promise.all([
    readInPage(tabId),
    chrome.tabs.get(tabId).catch(() => null),
  ]);
  return {
    tabId,
    tabUrl: tab?.url ?? null,
    tabTitle: tab?.title ?? null,
    meta: seen?.meta ?? null,
    document: seen?.document ?? null,
    heading: seen?.heading ?? null,
    chosen: await pageTitle(tabId),
  };
}
