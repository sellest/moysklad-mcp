import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, open, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
export function credentialScope() {
  return createHash("sha256")
    .update(JSON.stringify([process.env.MOYSKLAD_TOKEN, process.env.MOYSKLAD_LOGIN, process.env.MOYSKLAD_PASSWORD]))
    .digest("hex");
}
export function dataRoot() {
  return resolve(process.env.MOYSKLAD_DATA_DIR ?? join(homedir(), ".local", "share", "moysklad-mcp"));
}
export function storePath(scope: string, ...parts: string[]) {
  if (!/^[a-f0-9]{64}$/.test(scope) || parts.some((p) => !/^[a-zA-Z0-9_.-]+$/.test(p) || p === "." || p === ".."))
    throw new Error("INVALID_ARGUMENT: Invalid storage identifier.");
  return join(dataRoot(), scope, ...parts);
}
let root = "",
  used = 0;
let chain: Promise<unknown> = Promise.resolve();
async function bytes(path: string): Promise<number> {
  const s = await stat(path).catch(() => null);
  if (!s) return 0;
  if (s.isFile()) return s.size;
  if (!s.isDirectory()) throw new Error("STORAGE_LIMIT: Unsupported storage entry.");
  let total = 0;
  const names = await readdir(path);
  for (let offset = 0; offset < names.length; offset += 64)
    total += (await Promise.all(names.slice(offset, offset + 64).map((name) => bytes(join(path, name))))).reduce(
      (sum, value) => sum + value,
      0,
    );
  return total;
}
export async function atomicWrite(path: string, value: string) {
  const operation = chain.then(async () => {
    const base = dataRoot();
    if (!resolve(path).startsWith(base + sep)) throw new Error("INVALID_ARGUMENT: Invalid storage path.");
    if (root !== base) {
      used = await bytes(base);
      root = base;
    }
    const previous = await stat(path)
      .then((s) => s.size)
      .catch(() => 0);
    const size = Buffer.byteLength(value);
    const quota = Number(process.env.MOYSKLAD_STORAGE_MAX_BYTES ?? 1073741824);
    const limit = path.includes(sep + "jobs" + sep) ? quota : quota - Math.min(8 * 1024 * 1024, quota / 8);
    if (!Number.isSafeInteger(quota) || quota < 1048576 || used - previous + size > limit)
      throw new Error("STORAGE_LIMIT: Storage quota exceeded.");
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const temp = path + "." + randomUUID() + ".tmp";
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(value, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temp, path);
          break;
        } catch (error) {
          if (
            process.platform !== "win32" ||
            attempt >= 20 ||
            !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 5));
        }
      }
      used += size - previous;
    } catch (e) {
      await rm(temp, { force: true });
      throw e;
    }
  });
  chain = operation.catch(() => {});
  return operation;
}
export async function readJson<T = any>(path: string): Promise<T> {
  const operation = chain.then(async () => JSON.parse(await readFile(path, "utf8")) as T);
  chain = operation.catch(() => {});
  return operation;
}
export async function removeStored(path: string) {
  const base = dataRoot();
  if (!resolve(path).startsWith(base + sep)) throw new Error("INVALID_ARGUMENT: Invalid storage path.");
  const operation = chain.then(async () => {
    const count = await bytes(path);
    await rm(path, { recursive: true, force: true });
    if (root === base) used -= count;
  });
  chain = operation.catch(() => {});
  return operation;
}
export async function* readLines(path: string) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) if (line) yield JSON.parse(line);
  } finally {
    reader.close();
    stream.destroy();
  }
}
export async function storageDiagnostics() {
  if (root !== dataRoot()) {
    used = await bytes(dataRoot());
    root = dataRoot();
  }
  return { bytes: used, quota_bytes: Number(process.env.MOYSKLAD_STORAGE_MAX_BYTES ?? 1073741824) };
}
