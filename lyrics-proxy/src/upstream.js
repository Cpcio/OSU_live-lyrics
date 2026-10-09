const { AsyncLocalStorage } = require('async_hooks');
const requests = new AsyncLocalStorage();

class UpstreamError extends Error {
  constructor(message, kind, status = 502) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

async function upstreamJson(url, options = {}) {
  const parent = options.signal || requests.getStore()?.signal;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timeout = setTimeout(cancel, 12000);
    parent?.addEventListener('abort', cancel, { once: true });
    if (parent?.aborted) cancel();
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new UpstreamError(`upstream HTTP ${response.status}`,
        response.status === 429 ? 'rate_limited' : 'upstream_http', response.status === 429 ? 429 : 502);
      const code = body.code ?? body.retcode;
      if (code !== undefined && ![0, 200].includes(Number(code))) {
        throw new UpstreamError(`upstream code ${code}: ${body.message || body.msg || ''}`,
          [405, 429].includes(Number(code)) ? 'rate_limited' : 'upstream_business',
          [405, 429].includes(Number(code)) ? 429 : 502);
      }
      return body;
    } catch (error) {
      if (parent?.aborted) throw new UpstreamError('request cancelled', 'cancelled', 499);
      const transient = !error.kind || ['rate_limited', 'upstream_http'].includes(error.kind);
      if (attempt || !transient) throw error.kind ? error : new UpstreamError(
        controller.signal.aborted ? 'upstream timed out' : error.message,
        controller.signal.aborted ? 'timeout' : 'network', 504);
    } finally {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', cancel);
    }
    await new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); parent?.removeEventListener('abort', cancel); reject(new UpstreamError('request cancelled', 'cancelled', 499)); };
      const timer = setTimeout(() => { parent?.removeEventListener('abort', cancel); resolve(); }, 350);
      parent?.addEventListener('abort', cancel, { once: true });
      if (parent?.aborted) cancel();
    });
  }
}

module.exports = { requests, upstreamJson, UpstreamError };
