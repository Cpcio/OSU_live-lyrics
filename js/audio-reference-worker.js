importScripts('audio-reference-align.js');
self.onmessage = async event => {
  try {
    const { reference, queries, sampleRate, speed, options, preservePitch, queryStarts = [], hintStarts = [] } = event.data;
    const prepared = self.AudioReferenceAlignment.prepare(reference, sampleRate, options);
    const alignments = [];
    let soundTouch;
    if (preservePitch && Math.abs(speed - 1) >= 0.01) soundTouch = await import('./soundtouch.js');
    let sharedOffset;
    for (const [index, query] of queries.entries()) {
      const hint = Number.isFinite(hintStarts[index]) ? hintStarts[index]
        : Number.isFinite(sharedOffset) && Number.isFinite(queryStarts[index]) ? sharedOffset + queryStarts[index] : undefined;
      const queryOptions = { ...options, hintStartMs: hint };
      let best = self.AudioReferenceAlignment.alignPrepared(query, prepared, sampleRate, speed, queryOptions);
      best.mode = 'pitch-shift';
      if (soundTouch) {
        const targetLength = Math.round(query.length * speed);
        const total = query.length + Math.max(sampleRate * 2, 16384);
        const source = { extract(target, count, position) {
          const available = Math.max(0, Math.min(count, total - position));
          for (let i = 0; i < available; i++) target[i * 2] = target[i * 2 + 1] = query[position + i] || 0;
          return available;
        } };
        const processor = new soundTouch.SoundTouch();
        processor.stretch.setParameters(sampleRate, 0, 0, 0);
        processor.tempo = 1 / speed;
        const filter = new soundTouch.SimpleFilter(source, processor);
        const frames = new Float32Array(8192);
        const stretched = new Float32Array(targetLength);
        let written = 0;
        for (let pass = 0; pass < Math.ceil(total * Math.max(1, speed) / 4096) + 16 && written < targetLength; pass++) {
          const length = filter.extract(frames, 4096);
          if (!length) break;
          for (let i = 0; i < length && written < targetLength; i++) stretched[written++] = frames[i * 2];
        }
        if (written === targetLength) {
          const pitchMatch = self.AudioReferenceAlignment.alignPrepared(stretched, prepared, sampleRate, 1, queryOptions);
          if (pitchMatch.score > best.score) best = { ...pitchMatch, mode: 'preserve-pitch' };
        }
      }
      alignments.push(best);
      if (sharedOffset === undefined && best.score >= 0.7 && Number.isFinite(queryStarts[index])) sharedOffset = best.startMs - queryStarts[index];
    }
    self.postMessage({ alignments });
  } catch (error) { self.postMessage({ error: error.message }); }
};
