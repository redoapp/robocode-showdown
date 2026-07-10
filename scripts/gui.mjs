import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureJar } from "./robocode-jars.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const botsDir = join(repoRoot, "bots").replaceAll("\\", "/");

// The GUI boots its local server on `local-port` from server.properties (default
// 7654), so two GUIs sharing one config dir would both grab the same port. On
// Linux the config dir is resolved purely from the XDG_CONFIG_HOME env var, so we
// give each process its own throwaway config dir there — that's what lets every
// instance boot on a *different* random port with no shared-file race. On mac/win
// we use the normal shared config dir (relocating those requires touching the
// JVM's user.home, which breaks Java startup).
const isLinux = platform() !== "darwin" && platform() !== "win32";
const instanceDir = isLinux ? join(tmpdir(), `robocode-gui-${process.pid}`) : null;

const guiConfigDir = (() => {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Robocode Tank Royale");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(homedir(), "AppData", "Local"), "Robocode Tank Royale");
    default:
      return join(instanceDir, ".config", "robocode-tank-royale");
  }
})();

const guiEnv = isLinux
  ? { ...process.env, XDG_CONFIG_HOME: join(instanceDir, ".config") }
  : process.env;

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

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const seedServerPort = async () => {
  await mkdir(guiConfigDir, { recursive: true });
  const serverProperties = join(guiConfigDir, "server.properties");
  const props = await readProperties(serverProperties);
  const port = await freePort();
  props.set("local-port", String(port));
  const body = [...props].map(([k, v]) => `${k}=${v}`).join("\n");
  await writeFile(serverProperties, `${body}\n`);
  return port;
};

await seedBotDirectory();
const serverPort = await seedServerPort();
console.log(`GUI local server port: ${serverPort}`);
const guiJar = await ensureJar("gui");

const cleanup = () => {
  if (instanceDir) rmSync(instanceDir, { recursive: true, force: true });
};
const gui = spawn("java", ["-jar", guiJar], { stdio: "inherit", env: guiEnv });
gui.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
process.on("exit", cleanup);
