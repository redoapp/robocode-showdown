import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureJar } from "./robocode-jars.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const botsDir = join(repoRoot, "bots").replaceAll("\\", "/");

const guiConfigDir = (() => {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Robocode Tank Royale");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(homedir(), "AppData", "Local"), "Robocode Tank Royale");
    default:
      return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "robocode-tank-royale");
  }
})();

const readProperties = async (path) => {
  const text = await readFile(path, "utf8").catch(() => "");
  return new Map(
    text.split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => {
        const eq = line.indexOf("=");
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );
};

// Value is comma-separated alternating [path, enabledFlag, ...].
const botDirsInclude = (value, dir) => {
  const tokens = value ? value.split(",") : [];
  const paths = tokens.filter((_, i) => i % 2 === 0);
  if (paths.includes(dir)) return value;
  return [...tokens, dir, "true"].filter(Boolean).join(",");
};

const seedBotDirectory = async () => {
  await mkdir(guiConfigDir, { recursive: true });
  const guiProperties = join(guiConfigDir, "gui.properties");
  const props = await readProperties(guiProperties);
  props.set("bot-directories", botDirsInclude(props.get("bot-directories"), botsDir));
  const body = [...props].map(([k, v]) => `${k}=${v}`).join("\n");
  await writeFile(guiProperties, `${body}\n`);
};

await seedBotDirectory();
const guiJar = await ensureJar("gui");

const gui = spawn("java", ["-jar", guiJar], { stdio: "inherit" });
gui.on("exit", (code) => process.exit(code ?? 0));
