import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(__filename);
const distDir = path.join(rootDir, "..", "dist");

await rm(distDir, { recursive: true, force: true });
