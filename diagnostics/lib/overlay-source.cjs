// Read both historical inline overlays and current split classic scripts.
// Prefixing a throw lets V8 expose hoisted declarations without executing any
// initialization, DOM access, requests, timers or event registration.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readOverlaySources(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const scripts = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = match[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) {
      // Vendor runtimes are tested separately; only overlay-owned scripts
      // contribute application functions to these focused diagnostics.
      if (!src.startsWith('js/overlay/')) continue;
      const file = path.resolve(path.dirname(htmlFile), src.split(/[?#]/)[0]);
      scripts.push({ file, code: fs.readFileSync(file, 'utf8') });
    } else if (match[2].trim()) scripts.push({ file: htmlFile, code: match[2] });
  }
  return { html, scripts };
}

function createOverlaySource(htmlFile) {
  const { html, scripts } = readOverlaySources(htmlFile);
  const functions = new Map();
  for (const script of scripts) {
    const sentinel = {};
    const context = vm.createContext({ __overlayReadSentinel: sentinel });
    try { vm.runInContext('throw __overlayReadSentinel;\n' + script.code, context, { filename: script.file }); }
    catch (error) { if (error !== sentinel) throw error; }
    for (const [name, value] of Object.entries(context)) {
      if (typeof value !== 'function') continue;
      if (functions.has(name)) throw new Error(`Duplicate overlay function: ${name}`);
      functions.set(name, { file: script.file, code: value.toString() });
    }
  }
  return {
    html, scripts, functions,
    hasFunction: name => functions.has(name),
    functionText(name) {
      const entry = functions.get(name);
      if (!entry) throw new Error(`Overlay function not found: ${name}`);
      return entry.code;
    },
  };
}

module.exports = { readOverlaySources, createOverlaySource };
