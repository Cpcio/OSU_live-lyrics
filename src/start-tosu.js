const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
const proxyPort = Number(process.env.LYRICS_PROXY_PORT || 3002);
const proxyExe = process.pkg
  ? path.join(root, "lyrics-proxy.exe")
  : path.join(root, "dist", "lyrics-proxy.exe");
const cacheFile = process.pkg
  ? path.join(root, "song-cache.json")
  : path.resolve(root, "..", "song-cache.json");
const proxyArgs = ["--port", String(proxyPort), "--cache", cacheFile];
let launcherErrorShown = false;

async function showLauncherError(error) {
  if (launcherErrorShown) return;
  launcherErrorShown = true;
  console.error(`[launcher] ${error.message || error}`);
  console.error("Press Enter to close this window.");

  if (!process.stdin || process.stdin.destroyed) return;
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("data", resolve));
}

function findTosuPath() {
  if (process.env.TOSU_PATH) {
    const configuredPath = path.resolve(process.env.TOSU_PATH);
    return fs.existsSync(configuredPath) ? configuredPath : "";
  }

  const candidates = [
    path.resolve(root, "..", "..", "tosu.exe"), // tosu/static/this-plugin
    path.resolve(root, "..", "tosu.exe"),
    path.resolve(root, "tosu.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function waitForProxy(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("lyrics proxy did not become healthy within 8 seconds");
}

async function main() {
  const tosuPath = findTosuPath();
  if (!tosuPath) {
    throw new Error("tosu.exe not found. Put this plugin in tosu/static, or set TOSU_PATH.");
  }

  const proxyCommand = fs.existsSync(proxyExe) ? proxyExe : process.execPath;
  const proxyCommandArgs = proxyCommand === proxyExe ? proxyArgs : [path.join(root, "src", "server.js"), ...proxyArgs];
  const proxy = spawn(proxyCommand, proxyCommandArgs, { cwd: root, stdio: "ignore", windowsHide: true });
  proxy.unref();

  await waitForProxy();
  const tosu = spawn(tosuPath, [], {
    cwd: path.dirname(tosuPath),
    detached: false,
    stdio: "ignore",
    windowsHide: false,
  });
  tosu.once("error", (error) => {
    if (!proxy.killed) proxy.kill();
    void showLauncherError(new Error(`failed to start tosu: ${error.message}`));
  });
  tosu.on("exit", () => {
    if (!proxy.killed) proxy.kill();
  });
}

main().catch(async (error) => {
  await showLauncherError(error);
  process.exitCode = 1;
});
