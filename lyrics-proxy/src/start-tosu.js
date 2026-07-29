const { spawn } = require("child_process");
const path = require("path");

const root = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
const proxyPort = Number(process.env.LYRICS_PROXY_PORT || 3002);
const tosuPath = process.env.TOSU_PATH || "E:\\tosu\\tosu.exe";
const proxyExe = process.pkg
  ? path.join(root, "lyrics-proxy.exe")
  : path.join(root, "dist", "lyrics-proxy.exe");
const cacheFile = process.pkg
  ? path.join(root, "song-cache.json")
  : path.resolve(root, "..", "song-cache.json");
const proxyArgs = ["--port", String(proxyPort), "--cache", cacheFile];

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
  const proxyCommand = require("fs").existsSync(proxyExe) ? proxyExe : process.execPath;
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
  tosu.on("exit", () => {
    if (!proxy.killed) proxy.kill();
  });
}

main().catch((error) => {
  console.error(`[launcher] ${error.message}`);
  process.exitCode = 1;
});
