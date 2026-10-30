const OUTPUT_FILE = "output.mp4";

type DirectoryEntries = AsyncIterable<[string, FileSystemHandle]>;

function entriesOf(directory: FileSystemDirectoryHandle): DirectoryEntries {
  return directory as unknown as DirectoryEntries;
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

export async function jobDir(jobId: string, create = true): Promise<FileSystemDirectoryHandle> {
  const base = await root();
  return base.getDirectoryHandle(jobId, { create });
}

export async function outputHandle(jobId: string): Promise<FileSystemFileHandle> {
  const directory = await jobDir(jobId);
  return directory.getFileHandle(OUTPUT_FILE, { create: true });
}

export async function deleteJobDir(jobId: string, attempts = 4): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const base = await root();
      await base.removeEntry(jobId, { recursive: true });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return;

      const name = error instanceof DOMException ? error.name : "Error";
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) {
        console.warn(`[opfs] ${jobId}: delete failed (${name}), retrying`);
        await new Promise((done) => setTimeout(done, 100 * attempt));
        continue;
      }
      console.warn(
        `[opfs] could not delete ${jobId} after ${attempts} attempts: ${name}: ${detail}`,
      );
    }
  }
}

export async function listJobDirs(): Promise<string[]> {
  const base = await root();
  const names: string[] = [];
  for await (const [name] of entriesOf(base)) names.push(name);
  return names.sort();
}

export async function pruneExcept(keep: Iterable<string>): Promise<string[]> {
  const keepSet = new Set(keep);
  const names = await listJobDirs();
  for (const name of names) {
    if (keepSet.has(name)) continue;
    await deleteJobDir(name);
  }
  return listJobDirs();
}
