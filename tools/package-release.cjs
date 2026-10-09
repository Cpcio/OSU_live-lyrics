// Build each runtime package from an explicit list, never from an old release.
// Reports and development/source archives stay outside the deployed directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
const mandatory = ['index.html', 'metadata.txt', 'settings.json', 'song-cache.json',
  ...manifest.executables, ...Object.keys(manifest.distributionNotices), 'js/SOUNDTOUCH-LICENSE.txt'];
const expected = [...manifest.files, ...manifest.executables, ...Object.keys(manifest.distributionNotices)].sort();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function inside(parent, value) {
  const relative = path.relative(parent, value);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'path leaves target directory: ' + value);
  return value;
}

function filesIn(directory, base = directory) {
  assert.ok(!fs.lstatSync(directory).isSymbolicLink(), 'linked directory is not a package input: ' + directory);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = inside(base, path.join(directory, entry.name));
    assert.ok(!entry.isSymbolicLink(), 'linked file is not a package input: ' + full);
    return entry.isDirectory() ? filesIn(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  }).sort();
}

function validateAssets(read, present) {
  const found = new Set(present), visited = new Set();
  for (const name of mandatory) assert.ok(found.has(name), 'required runtime file missing: ' + name);
  assert.ok(read('metadata.txt').trim(), 'metadata is empty');
  assert.ok(Array.isArray(JSON.parse(read('settings.json'))), 'settings must be an array');
  assert.equal(typeof JSON.parse(read('song-cache.json')).tracks, 'object', 'cache must contain tracks');
  const dependencies = [];
  function localDependency(owner, reference, pageRelative = false) {
    if (/^(?:https?:|data:|blob:|#)/i.test(reference)) return;
    const clean = reference.split(/[?#]/)[0].replace(/\\/g, '/');
    if (!/\.(?:js|css|wasm|ttf|woff2?|json)$/i.test(clean)) return;
    const fromPage = pageRelative || /^(?:\.\/)?(?:js|css)\//.test(clean);
    const dependency = path.posix.normalize(path.posix.join(fromPage ? '' : path.posix.dirname(owner), clean));
    assert.ok(!dependency.startsWith('../') && !path.posix.isAbsolute(dependency), 'unsafe asset path: ' + reference);
    assert.ok(found.has(dependency), `${owner} needs missing asset ${dependency}`);
    dependencies.push({ from: owner, to: dependency });
    visit(dependency);
  }
  function visit(name) {
    if (visited.has(name) || !/\.(?:html|js|css)$/i.test(name)) return;
    visited.add(name);
    const text = read(name);
    if (name.endsWith('.html')) {
      for (const match of text.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) localDependency(name, match[1], true);
    }
    // Include imports within inline scripts, Worker dependencies and dynamic
    // SoundTouch imports. Source-map comments are not runtime dependencies.
    for (const match of text.matchAll(/\b(?:importScripts|import|require)\s*\(\s*["']([^"']+)["']/g)) localDependency(name, match[1]);
    for (const match of text.matchAll(/\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*document\.baseURI/g)) localDependency(name, match[1], true);
    for (const match of text.matchAll(/\bnew\s+Worker\s*\(\s*["']([^"']+)["']/g)) localDependency(name, match[1], true);
    if (name.endsWith('.css')) for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) localDependency(name, match[1]);
  }
  visit('index.html');
  for (const name of present.filter(file => /\.(?:js|css)$/i.test(file))) {
    assert.ok(visited.has(name), 'unused frontend file in runtime package: ' + name);
  }
  return { checkedAssets: visited.size, dependencies };
}

function verify(directory, legacy = false) {
  directory = inside(root, path.resolve(root, directory));
  const present = filesIn(directory);
  const allowed = new Set([...expected, ...(legacy ? manifest.legacyRuntimeFiles : [])]);
  for (const file of present) assert.ok(allowed.has(file), 'non-runtime file in release: ' + file);
  if (!legacy) assert.deepEqual(present, expected, 'release must contain exactly the manifest files');
  const assets = validateAssets(name => fs.readFileSync(inside(directory, path.join(directory, name)), 'utf8'), present);
  for (const name of present.filter(file => file.endsWith('.js'))) {
    const check = spawnSync(process.execPath, ['--check', path.join(directory, name)], { encoding: 'utf8' });
    assert.equal(check.status, 0, 'invalid script: ' + name + '\n' + check.stderr);
  }
  const records = present.map(name => ({ name, bytes: fs.statSync(path.join(directory, name)).size, sha256: hash(path.join(directory, name)) }));
  return { release: path.relative(root, directory).split(path.sep).join('/'), files: records.length,
    bytes: records.reduce((sum, file) => sum + file.bytes, 0), ...assets, records };
}

function build(name, runtimeDirectory, destination) {
  assert.match(name, /^[a-z0-9][a-z0-9-]{0,63}$/, 'use a short lowercase release name');
  const output = inside(root, path.resolve(root, destination || path.join('releases', name)));
  assert.ok(!fs.existsSync(output), 'release already exists; do not overwrite a historical version: ' + output);
  const runtime = inside(root, path.resolve(root, runtimeDirectory || manifest.defaultRuntimeDirectory));
  assert.ok(!fs.lstatSync(runtime).isSymbolicLink(), 'runtime directory must not be a link');
  const sources = new Map(manifest.files.map(file => [file, inside(root, path.join(root, file))]));
  for (const file of manifest.executables) sources.set(file, inside(runtime, path.join(runtime, file)));
  for (const [file, source] of Object.entries(manifest.distributionNotices)) sources.set(file, inside(root, path.join(root, source)));
  assert.equal(new Set(expected).size, expected.length, 'duplicate entries in manifest');
  for (const [file, source] of sources) {
    assert.ok(fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink(), 'missing normal source file: ' + file);
  }
  validateAssets(name => fs.readFileSync(sources.get(name), 'utf8'), expected);
  fs.mkdirSync(output, { recursive: true });
  for (const [file, source] of sources) {
    const target = inside(output, path.join(output, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    assert.equal(hash(source), hash(target), 'copy mismatch: ' + file);
  }
  return verify(output);
}

function main(args) {
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  if (args.includes('--verify-all')) {
    const reports = fs.readdirSync(path.join(root, 'releases'), { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => verify(path.join('releases', entry.name), true));
    const reportFile = path.join(root, 'diagnostics/release-cleanup-20261004/runtime-verification.json');
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(reports, null, 2) + '\n');
    return console.log(JSON.stringify({ verifiedReleases: reports.length, counts: reports.map(({ release, files, bytes }) => ({ release, files, bytes })) }));
  }
  const report = value('--verify') ? verify(value('--verify'), args.includes('--legacy'))
    : value('--name') ? build(value('--name'), value('--runtime-dir'), value('--output')) : null;
  if (!report) return console.log('node tools/package-release.cjs --name NAME [--runtime-dir DIR]\nnode tools/package-release.cjs --verify releases/NAME\nnode tools/package-release.cjs --verify-all');
  const reportFile = path.join(root, 'diagnostics/release-packages', path.basename(report.release) + '.json');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ release: report.release, files: report.files, bytes: report.bytes, checkedAssets: report.checkedAssets }));
}

if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { verify, build, validateAssets };
