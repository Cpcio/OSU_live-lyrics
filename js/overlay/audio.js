// Audio decoding, speed conversion, fingerprint windows and live spectrum rendering.
// Large buffers and the spectrum frame are owned by state.js and reset here.

function throwIfAudioMatchAborted(signal) {
  if (signal?.aborted) throw new Error("audio match aborted");
}

async function decodeAudioBuffer(buffer, outputSampleRate = 8000, signal = null) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("AudioContext unavailable");

  const context = outputSampleRate
    ? new AudioContextClass({ sampleRate: outputSampleRate })
    : new AudioContextClass();
  try {
    return await audioMatchTask(context.decodeAudioData(buffer.slice(0)), signal, 15000, "audio decode");
  } finally {
    context.close?.();
  }
}

function audioMatchTask(task, signal, timeoutMs, stage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(new Error("audio match aborted"));
    const timer = setTimeout(() => {
      const error = new Error(`${stage} timed out`); error.kind = "timeout"; finish(error);
    }, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    Promise.resolve(task).then(value => finish(null, value), error => finish(error));
  });
}

function resetTimelineVisualizer() {
  timelineVisualizerAbortController?.abort();
  timelineVisualizerAbortController = null;
  if (timelineVisualizerFrame) cancelAnimationFrame(timelineVisualizerFrame);
  timelineVisualizerFrame = 0;
  timelineVisualizerAudioBuffer = null;
  timelineVisualizerTrackKey = "";
  timelineVisualizerLevels = [];
  timelineVisualizerSpectrumOutput = null;
  timelineVisualizerSpectrumEnergies = null;
  timelineVisualizerSpectrumBinCounts = null;
  timelineVisualizerSpectrumBandFrequencies = null;
  timelineVisualizerLastRenderAt = 0;
}

function startTimelineVisualizerLoop() {
  if (timelineVisualizerFrame) return;
  const renderFrame = () => {
    const supportedLayout = overlayEl?.classList.contains("layout-dashboard");
    if (!CONFIG.timelineVisualizerEnabled || !supportedLayout) {
      timelineVisualizerFrame = 0;
      return;
    }
    const duration = Number(currentDuration) || 0;
    const progress = duration ? clamp((Number(lastLiveTime) || 0) / duration, 0, 1) : 0;
    renderTimelineVisualizer(lastLiveTime, progress);
    timelineVisualizerFrame = requestAnimationFrame(renderFrame);
  };
  timelineVisualizerFrame = requestAnimationFrame(renderFrame);
}

async function loadTimelineVisualizerAudio(trackKey) {
  const supportedLayout = overlayEl?.classList.contains("layout-dashboard");
  if (!CONFIG.timelineVisualizerEnabled || !supportedLayout || !trackKey || trackKey === timelineVisualizerTrackKey) return;

  timelineVisualizerAbortController?.abort();
  timelineVisualizerAudioBuffer = null;
  timelineVisualizerLevels = [];
  timelineVisualizerTrackKey = trackKey;
  const controller = new AbortController();
  timelineVisualizerAbortController = controller;

  try {
    const bytes = await currentBeatmapAudioBuffer(controller.signal);
    const audioBuffer = await decodeAudioBuffer(bytes, 0, controller.signal);
    if (controller.signal.aborted || currentTrackKey !== trackKey || timelineVisualizerTrackKey !== trackKey) return;
    timelineVisualizerAudioBuffer = audioBuffer;
  } catch {
    // Keep the dot-style progress indicator when source audio is unavailable.
  } finally {
    if (timelineVisualizerAbortController === controller) timelineVisualizerAbortController = null;
  }
}

function timelineVisualizerFft(real, imaginary) {
  const length = real.length;
  for (let index = 1, reverse = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reverse & bit; bit >>= 1) reverse ^= bit;
    reverse ^= bit;
    if (index < reverse) {
      [real[index], real[reverse]] = [real[reverse], real[index]];
      [imaginary[index], imaginary[reverse]] = [imaginary[reverse], imaginary[index]];
    }
  }

  for (let size = 2; size <= length; size <<= 1) {
    const half = size >> 1;
    const angle = -2 * Math.PI / size;
    const stepCos = Math.cos(angle);
    const stepSin = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let currentCos = 1;
      let currentSin = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd] * currentCos - imaginary[odd] * currentSin;
        const oddImaginary = real[odd] * currentSin + imaginary[odd] * currentCos;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextCos = currentCos * stepCos - currentSin * stepSin;
        currentSin = currentCos * stepSin + currentSin * stepCos;
        currentCos = nextCos;
      }
    }
  }
}

function timelineVisualizerSpectrum(channel, start, sampleRate, count) {
  // 2048 samples give the low bands enough frequency resolution to avoid
  // treating the same bass bin as several independent bars. The arrays are
  // reused for every frame, so the larger FFT does not create per-frame
  // garbage.
  const sampleCount = 2048;
  if (!channel || !sampleRate || !count) return new Float32Array(count);
  if (!timelineVisualizerFftReal || timelineVisualizerFftReal.length !== sampleCount) {
    timelineVisualizerFftReal = new Float64Array(sampleCount);
    timelineVisualizerFftImaginary = new Float64Array(sampleCount);
    timelineVisualizerFftWindow = new Float64Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      timelineVisualizerFftWindow[index] = 0.5
        - 0.5 * Math.cos((2 * Math.PI * index) / (sampleCount - 1));
    }
  }

  const real = timelineVisualizerFftReal;
  const imaginary = timelineVisualizerFftImaginary;
  const window = timelineVisualizerFftWindow;
  const channels = channel?.[0] && typeof channel[0].length === "number"
    ? channel
    : [channel];
  real.fill(0);
  imaginary.fill(0);
  let inputEnergy = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sampleIndex = start + index;
    let sample = 0;
    if (sampleIndex >= 0) {
      for (const source of channels) {
        if (sampleIndex < source.length) sample += source[sampleIndex] || 0;
      }
      sample /= channels.length;
    }
    inputEnergy += sample * sample;
    real[index] = sample * window[index];
  }

  // Decoder padding and genuinely silent sections should settle to the
  // baseline instead of being stretched to full height by normalization.
  const inputRms = Math.sqrt(inputEnergy / sampleCount);
  if (inputRms < 0.0007) {
    if (!timelineVisualizerSpectrumOutput || timelineVisualizerSpectrumOutput.length !== count) {
      timelineVisualizerSpectrumOutput = new Float32Array(count);
    }
    timelineVisualizerSpectrumOutput.fill(0);
    return timelineVisualizerSpectrumOutput;
  }
  timelineVisualizerFft(real, imaginary);

  const nyquist = Math.floor(sampleCount / 2);
  const minFrequency = 55;
  const maxFrequency = Math.min(sampleRate * 0.45, 14000);
  const minBin = Math.max(1, Math.ceil(minFrequency * sampleCount / sampleRate));
  const maxBin = Math.min(nyquist - 1, Math.max(minBin + 1, Math.floor(maxFrequency * sampleCount / sampleRate)));
  const logMin = Math.log(minBin);
  const logMax = Math.log(maxBin);
  if (!timelineVisualizerSpectrumEnergies || timelineVisualizerSpectrumEnergies.length !== count) {
    timelineVisualizerSpectrumEnergies = new Float64Array(count);
    timelineVisualizerSpectrumBinCounts = new Uint32Array(count);
    timelineVisualizerSpectrumBandFrequencies = new Float64Array(count);
  }
  const energies = timelineVisualizerSpectrumEnergies;
  const binCounts = timelineVisualizerSpectrumBinCounts;
  const bandFrequencies = timelineVisualizerSpectrumBandFrequencies;
  energies.fill(0);
  binCounts.fill(0);
  bandFrequencies.fill(0);

  // Assign every FFT bin to exactly one logarithmic band. The old
  // inclusive low/high loops overlapped the first few bins, which made
  // low-frequency bars rise together even when only one bin was active.
  let cursor = minBin;
  for (let band = 0; band < count; band += 1) {
    const edge = Math.exp(logMin + ((band + 1) / count) * (logMax - logMin));
    const end = band === count - 1
      ? maxBin + 1
      : Math.min(maxBin + 1, Math.max(cursor + 1, Math.round(edge)));
    bandFrequencies[band] = Math.exp(logMin + ((band + 0.5) / count) * (logMax - logMin))
      * sampleRate / sampleCount;
    for (let bin = cursor; bin < end; bin += 1) {
      energies[band] += real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
      binCounts[band] += 1;
    }
    cursor = end;
  }

  if (!timelineVisualizerSpectrumOutput || timelineVisualizerSpectrumOutput.length !== count) {
    timelineVisualizerSpectrumOutput = new Float32Array(count);
  }

  // Map absolute band energy to a fixed dB window. A fixed window keeps a
  // loud bass band from becoming the denominator for every other band;
  // quiet sections can therefore fall naturally instead of always showing
  // a full-height bar.
  const floorDb = -78;
  const ceilingDb = -16;
  for (let band = 0; band < count; band += 1) {
    if (!binCounts[band]) {
      timelineVisualizerSpectrumOutput[band] = 0;
      continue;
    }
    const power = energies[band] / Math.max(1, binCounts[band] * sampleCount * sampleCount);
    let db = 10 * Math.log10(power + 1e-12);
    // A small low-frequency shelf compensates for the natural bass bias in
    // mastered music without flattening the real spectral shape.
    const lowShelf = 7 * clamp(
      Math.log(450 / Math.max(55, bandFrequencies[band])) / Math.log(450 / 55),
      0,
      1,
    );
    db -= lowShelf;
    const normalized = clamp((db - floorDb) / (ceilingDb - floorDb), 0, 1);
    timelineVisualizerSpectrumOutput[band] = Math.pow(normalized, 0.72);
  }
  return timelineVisualizerSpectrumOutput;
}

function renderTimelineVisualizer(liveTime, progress) {
  const supportedLayout = overlayEl?.classList.contains("layout-dashboard");
  if (!timelineVisualizerEl || !CONFIG.timelineVisualizerEnabled || !supportedLayout) return;
  const now = performance.now();
  const previousRenderAt = timelineVisualizerLastRenderAt;
  if (now - previousRenderAt < 15) return;
  const rect = timelineVisualizerEl.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  timelineVisualizerLastRenderAt = now;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(rect.width * pixelRatio);
  const pixelHeight = Math.round(rect.height * pixelRatio);
  if (timelineVisualizerEl.width !== pixelWidth || timelineVisualizerEl.height !== pixelHeight) {
    timelineVisualizerEl.width = pixelWidth;
    timelineVisualizerEl.height = pixelHeight;
  }

  const context = timelineVisualizerEl.getContext("2d");
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const count = Math.round(clamp(Number(CONFIG.timelineVisualizerBarCount), 12, 72));
  const sensitivity = clamp(Number(CONFIG.timelineVisualizerSensitivity), 0.2, 4);
  const fallSpeed = clamp(Number(CONFIG.timelineVisualizerFallSpeed), 0.4, 12);
  const deltaSeconds = previousRenderAt ? Math.min(0.12, (now - previousRenderAt) / 1000) : 1 / 30;
  const audio = timelineVisualizerAudioBuffer;
  const channelCount = Math.max(0, Number(audio?.numberOfChannels) || 0);
  const channels = [];
  for (let index = 0; index < channelCount; index += 1) {
    const data = audio?.getChannelData?.(index);
    if (data) channels.push(data);
  }
  const channel = channels.length > 1 ? channels : channels[0];
  const sampleRate = audio?.sampleRate || 0;
  const sampleCenter = Math.floor((Math.max(0, Number(liveTime) || 0) / 1000) * sampleRate);
  const start = sampleCenter - 1024;
  const targets = timelineVisualizerSpectrum(channel, start, sampleRate, count);
  const nextLevels = timelineVisualizerLevels.length === count ? timelineVisualizerLevels : new Array(count);

  for (let bar = 0; bar < count; bar += 1) {
    const target = clamp((targets[bar] || 0) * sensitivity, 0, 1);
    const previous = timelineVisualizerLevels[bar] || 0;
    const rising = previous + Math.min(1, deltaSeconds * 15);
    nextLevels[bar] = target >= previous
      ? Math.min(target, rising)
      : Math.max(target, previous - fallSpeed * deltaSeconds);
  }
  timelineVisualizerLevels = nextLevels;

  const topColor = getComputedStyle(document.documentElement).getPropertyValue("--timeline-top").trim() || "#84f4d0";
  const bottomColor = getComputedStyle(document.documentElement).getPropertyValue("--timeline-bottom").trim() || "#7ca8ff";
  const gradient = context.createLinearGradient(0, 0, rect.width, 0);
  gradient.addColorStop(0, topColor);
  gradient.addColorStop(1, bottomColor);
  const dot = clamp((rect.width / Math.max(1, count)) * 0.42, 2, 4.5);
  const edgeInset = dot + 1;
  const step = (rect.width - edgeInset * 2) / Math.max(1, count - 1);
  const baseY = rect.height - dot - 1;
  const maxHeight = Math.max(dot, rect.height - dot - 2);
  context.lineCap = "round";

  for (let bar = 0; bar < count; bar += 1) {
    const x = count === 1 ? rect.width / 2 : edgeInset + bar * step;
    const height = dot + nextLevels[bar] * (maxHeight - dot);
    const played = count === 1 || bar / (count - 1) <= progress;
    context.strokeStyle = played ? gradient : "rgba(255, 255, 255, 0.2)";
    context.globalAlpha = played ? 0.96 : 0.72;
    context.lineWidth = dot * 2;
    context.beginPath();
    const rise = Math.max(0, height - dot);
    if (rise < 0.01) {
      // A zero-length stroke is not a reliable circle in embedded browsers.
      // Keep every band visible, even in silence or without source audio.
      context.fillStyle = context.strokeStyle;
      context.arc(x, baseY, dot, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(x, baseY);
      context.lineTo(x, baseY - rise);
      context.stroke();
    }
  }
  context.globalAlpha = 1;
}

function audioMatchSamples(audioBuffer, startSeconds, durationSeconds) {
  const sampleRate = audioBuffer.sampleRate || 8000;
  const channel = audioBuffer.getChannelData(0);
  const start = Math.max(0, Math.floor(startSeconds * sampleRate));
  const count = Math.max(sampleRate, Math.floor(durationSeconds * sampleRate));
  const end = Math.min(channel.length, start + count);
  if (end <= start) throw new Error("audio match sample range is outside current audio");
  return new Float32Array(channel.subarray(start, end));
}

function audioMatchWindow(audioBuffer, configuredStartSeconds, configuredDurationSeconds, speed) {
  const totalSeconds = audioBuffer.duration || audioBuffer.length / (audioBuffer.sampleRate || 8000);
  const safeSpeed = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1;
  const targetTotalSeconds = totalSeconds * safeSpeed;
  const useMiddleWindow = Number(configuredStartSeconds) < 0;
  const targetDurationSeconds = useMiddleWindow ? 15 : configuredDurationSeconds;
  const safeTargetDurationSeconds = clamp(targetDurationSeconds, 3, 30);
  const targetStartSeconds = useMiddleWindow
    ? Math.max(0, targetTotalSeconds / 2 - safeTargetDurationSeconds / 2)
    : Math.max(0, configuredStartSeconds);
  const actualDurationSeconds = Math.min(totalSeconds, Math.max(1, safeTargetDurationSeconds / safeSpeed));
  let actualStartSeconds = Math.max(0, targetStartSeconds / safeSpeed);

  if (actualStartSeconds + actualDurationSeconds > totalSeconds) {
    actualStartSeconds = Math.max(0, totalSeconds - actualDurationSeconds);
  }

  return {
    actualStartSeconds,
    actualDurationSeconds,
    targetStartSeconds: actualStartSeconds * safeSpeed,
    targetDurationSeconds: actualDurationSeconds * safeSpeed,
    useMiddleWindow,
    totalSeconds,
  };
}

function audioMatchWindowAtFraction(audioBuffer, fraction, durationSeconds, speed) {
  const totalSeconds = audioBuffer.duration || audioBuffer.length / (audioBuffer.sampleRate || 8000);
  const safeSpeed = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1;
  const targetTotalSeconds = totalSeconds * safeSpeed;
  const requestedDuration = clamp(Number(durationSeconds) || 15, 3, 30);
  const actualDurationSeconds = Math.min(totalSeconds, Math.max(1, requestedDuration / safeSpeed));
  const targetDurationSeconds = actualDurationSeconds * safeSpeed;
  const center = clamp(Number(fraction), 0, 1) * targetTotalSeconds;
  const targetStartSeconds = clamp(center - targetDurationSeconds / 2, 0, Math.max(0, targetTotalSeconds - targetDurationSeconds));

  return {
    actualStartSeconds: targetStartSeconds / safeSpeed,
    actualDurationSeconds,
    targetStartSeconds,
    targetDurationSeconds,
    totalSeconds,
    fraction: clamp(Number(fraction), 0, 1),
  };
}

function stretchSamplesForSpeed(samples, speed) {
  const safeSpeed = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1;
  if (Math.abs(safeSpeed - 1) < 0.01) return samples;

  const length = Math.max(1, Math.round(samples.length * safeSpeed));
  const output = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const sourceIndex = index / safeSpeed;
    const left = Math.floor(sourceIndex);
    const right = Math.min(samples.length - 1, left + 1);
    const ratio = sourceIndex - left;
    output[index] = samples[left] * (1 - ratio) + samples[right] * ratio;
  }

  return output;
}

function resampleSamples(samples, sourceSampleRate, targetSampleRate = 8000) {
  const sourceRate = Number(sourceSampleRate) || targetSampleRate;
  if (sourceRate === targetSampleRate) return samples;

  const outputLength = Math.max(1, Math.round(samples.length * targetSampleRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetSampleRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(samples.length - 1, left + 1);
    const amount = sourceIndex - left;
    output[index] = samples[left] * (1 - amount) + samples[right] * amount;
  }
  return output;
}

async function stretchSamplesPreservePitch(samples, sourceSampleRate, speed, signal) {
  const safeSpeed = Number(speed);
  if (!Number.isFinite(safeSpeed) || Math.abs(safeSpeed - 1) < 0.01) return samples;

  soundTouchRuntimePromise ||= import(new URL("js/soundtouch.js?v=20260717-1", document.baseURI).href);
  const { SoundTouch, SimpleFilter } = await soundTouchRuntimePromise;
  throwIfAudioMatchAborted(signal);

  const targetLength = Math.max(1, Math.round(samples.length * safeSpeed));
  const tailFrames = Math.max(Math.round(sourceSampleRate * 2), 16384);
  const totalFrames = samples.length + tailFrames;
  const source = {
    extract(target, frameCount, position) {
      const available = Math.max(0, Math.min(frameCount, totalFrames - position));
      for (let index = 0; index < available; index += 1) {
        const sourceIndex = position + index;
        const value = sourceIndex < samples.length ? samples[sourceIndex] : 0;
        target[index * 2] = value;
        target[index * 2 + 1] = value;
      }
      return available;
    },
  };
  const processor = new SoundTouch();
  processor.stretch.setParameters(sourceSampleRate, 0, 0, 0);
  processor.tempo = 1 / safeSpeed;
  const filter = new SimpleFilter(source, processor);
  const frameBuffer = new Float32Array(4096 * 2);
  const chunks = [];
  let outputLength = 0;

  const maxPasses = Math.ceil((totalFrames * Math.max(1, safeSpeed)) / 4096) + 16;
  for (let passes = 0; passes < maxPasses; passes += 1) {
    throwIfAudioMatchAborted(signal);
    if (passes && passes % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const extracted = filter.extract(frameBuffer, 4096);
    if (!extracted) break;
    const chunk = new Float32Array(extracted);
    for (let index = 0; index < extracted; index += 1) chunk[index] = frameBuffer[index * 2];
    chunks.push(chunk);
    outputLength += extracted;
  }

  if (outputLength < targetLength) throw new Error("pitch-preserving stretch ended before target duration");
  const output = new Float32Array(targetLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= targetLength) break;
    const count = Math.min(chunk.length, targetLength - offset);
    output.set(chunk.subarray(0, count), offset);
    offset += count;
  }
  return output;
}
