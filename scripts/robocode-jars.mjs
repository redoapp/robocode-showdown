import { createWriteStream } from "node:fs";
import { access, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const ROBOCODE_VERSION = "1.0.2";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(repoRoot, ".robocode");

const jarUrl = (component) =>
  `https://github.com/robocode-dev/tank-royale/releases/download/v${ROBOCODE_VERSION}/robocode-tankroyale-${component}-${ROBOCODE_VERSION}.jar`;

const exists = async (path) =>
  access(path).then(() => true, () => false);

export async function ensureJar(component) {
  const jarPath = join(cacheDir, `robocode-tankroyale-${component}-${ROBOCODE_VERSION}.jar`);
  if (await exists(jarPath)) return jarPath;

  const url = jarUrl(component);
  console.error(`Downloading ${component} jar (one-time) from ${url}`);
  await mkdir(cacheDir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url} — HTTP ${response.status}`);
  }

  const tmpPath = `${jarPath}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));
  await rename(tmpPath, jarPath);
  return jarPath;
}
