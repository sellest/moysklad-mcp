import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.env.MOYSKLAD_TOKEN_FILE) {
  try {
    const token = (await readFile(process.env.MOYSKLAD_TOKEN_FILE, "utf8")).trim();
    if (token) process.env.MOYSKLAD_TOKEN = token;
  } catch {
    console.error("TOKEN_FILE_UNAVAILABLE: check the mounted MoySklad secret.");
    process.exit(1);
  }
}
process.argv[1] = fileURLToPath(new URL("./dist/index.js", import.meta.url));
await import("./dist/index.js");
