// Export a reviewable source tree without copying development/history folders.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(root, 'source-manifest.json'), 'utf8'));
const files = [...new Set([...release.files, ...source.files])].sort();
const args = process.argv.slice(2);
assert.equal(args.length, 2, 'usage: node tools/package-source.cjs --out diagnostics/github-source-<version>');
assert.equal(args[0], '--out');
const destination = path.resolve(root, args[1]);
const diagnosticsRoot = path.join(root, 'diagnostics') + path.sep;
assert.ok(destination.startsWith(diagnosticsRoot), 'source exports must be inside workspace diagnostics/');
assert.ok(!fs.existsSync(destination), 'destination already exists; use a new directory');
function inputPath(name) {
  assert.ok(!path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'), 'unsafe source path: ' + name);
  const absolute = path.join(root, name);
  let cursor = absolute;
  while (cursor !== root) { assert.ok(!fs.lstatSync(cursor).isSymbolicLink(), 'linked source input: ' + name); cursor = path.dirname(cursor); }
  assert.ok(fs.statSync(absolute).isFile(), 'source input must be a file: ' + name);
  assert.ok(!/\.(exe|mp3|ogg|wav|osz|png|jpe?g|log)$/i.test(name), 'generated or recorded input: ' + name);
  assert.ok(!/(^|\/)(node_modules|backup|releases|\.pnpm-store)(\/|$)/.test(name), 'non-source directory: ' + name);
  return absolute;
}
// Validate all inputs before creating a new export.
for (const name of files) inputPath(name);
assert.ok(files.includes('js/afp.wasm.js') && files.includes('js/soundtouch.js'));
assert.ok(files.includes('lyrics-proxy/src/vendor/netease-crypto.js'));
assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'song-cache.json'), 'utf8')).tracks), [], 'source seed must be empty; do not export personal song mappings');
const records = [];
for (const name of files) {
  const target = path.join(destination, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(inputPath(name), target);
  const bytes = fs.readFileSync(target);
  records.push({ name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  if (/\.(?:js|cjs)$/.test(name)) {
    const check = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    assert.equal(check.status, 0, 'invalid source: ' + name + '\n' + check.stderr);
  }
}
const report = { destination: path.relative(root, destination).split(path.sep).join('/'), files: files.length,
  bytes: records.reduce((sum, item) => sum + item.bytes, 0), records };
const reportDirectory = path.join(root, 'diagnostics/source-packages');
fs.mkdirSync(reportDirectory, { recursive: true });
fs.writeFileSync(path.join(reportDirectory, path.basename(destination) + '.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ destination: report.destination, files: report.files, bytes: report.bytes }));
