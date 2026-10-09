(function attachAudioReferenceAlignment(global) {
  "use strict";

  const DEFAULTS = {
    sampleRate: 8000,
    frameSize: 1024,
    hopSize: 512,
    featureStride: 2,
    bandCount: 16,
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function safeSpeed(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 1;
  }

  function stretchSamples(samples, speed) {
    const multiplier = safeSpeed(speed);
    if (Math.abs(multiplier - 1) < 0.01) return samples;

    const output = new Float32Array(Math.max(1, Math.round(samples.length * multiplier)));
    for (let index = 0; index < output.length; index += 1) {
      const sourceIndex = index / multiplier;
      const left = Math.min(samples.length - 1, Math.floor(sourceIndex));
      const right = Math.min(samples.length - 1, left + 1);
      const amount = sourceIndex - left;
      output[index] = samples[left] * (1 - amount) + samples[right] * amount;
    }
    return output;
  }

  function fft(real, imaginary) {
    const length = real.length;
    for (let i = 1, j = 0; i < length; i += 1) {
      let bit = length >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
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

  function spectralFeatures(samples, sampleRate, options = {}) {
    const frameSize = options.frameSize || DEFAULTS.frameSize;
    const hopSize = options.hopSize || DEFAULTS.hopSize;
    const featureStride = options.featureStride || DEFAULTS.featureStride;
    const bandCount = options.bandCount || DEFAULTS.bandCount;
    if (!samples?.length) return { values: new Float32Array(0), frames: 0, bandCount };

    const frameCount = Math.max(1, Math.floor(Math.max(0, samples.length - frameSize) / hopSize) + 1);
    const keptFrameCount = Math.ceil(frameCount / featureStride);
    const values = new Float32Array(keptFrameCount * bandCount);
    const real = new Float64Array(frameSize);
    const imaginary = new Float64Array(frameSize);
    const window = new Float64Array(frameSize);
    for (let index = 0; index < frameSize; index += 1) {
      window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, frameSize - 1));
    }

    const nyquist = frameSize >> 1;
    const minBin = 2;
    const maxBin = Math.max(minBin + bandCount, Math.floor(nyquist * 0.92));
    const logMin = Math.log(minBin);
    const logMax = Math.log(maxBin);
    const bandEnergy = new Float64Array(bandCount);
    let outputFrame = 0;

    for (let frame = 0; frame < frameCount; frame += featureStride) {
      real.fill(0);
      imaginary.fill(0);
      const start = frame * hopSize;
      let energy = 0;
      for (let index = 0; index < frameSize; index += 1) {
        const sample = samples[Math.min(samples.length - 1, start + index)] || 0;
        const value = sample * window[index];
        real[index] = value;
        energy += value * value;
      }
      fft(real, imaginary);

      bandEnergy.fill(0);
      for (let bin = minBin; bin <= maxBin; bin += 1) {
        const position = (Math.log(bin) - logMin) / Math.max(0.0001, logMax - logMin);
        const band = clamp(Math.floor(position * bandCount), 0, bandCount - 1);
        bandEnergy[band] += real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
      }

      let norm = 0;
      for (let band = 0; band < bandCount; band += 1) {
        const value = Math.log1p(bandEnergy[band] / Math.max(1e-9, energy));
        bandEnergy[band] = value;
        norm += value * value;
      }
      // Remove the common positive spectral floor. A cosine of raw positive
      // energies can exceed .9 even for an unrelated recording.
      const mean = bandEnergy.reduce((sum, value) => sum + value, 0) / bandCount;
      norm = 0;
      for (let band = 0; band < bandCount; band += 1) {
        bandEnergy[band] -= mean;
        norm += bandEnergy[band] * bandEnergy[band];
      }
      norm = Math.sqrt(norm) || 1;
      const base = outputFrame * bandCount;
      for (let band = 0; band < bandCount; band += 1) values[base + band] = energy > 1e-8 ? bandEnergy[band] / norm : 0;
      outputFrame += 1;
    }

    const combined = new Float32Array(outputFrame * bandCount * 2);
    for (let frame = 0; frame < outputFrame; frame++) {
      const left = Math.max(0, frame - 2), right = Math.min(outputFrame - 1, frame + 2);
      let deltaNorm = 0;
      for (let band = 0; band < bandCount; band++) {
        const delta = values[right * bandCount + band] - values[left * bandCount + band];
        deltaNorm += delta * delta;
      }
      deltaNorm = Math.sqrt(deltaNorm);
      for (let band = 0; band < bandCount; band++) {
        const base = frame * bandCount * 2;
        const delta = values[right * bandCount + band] - values[left * bandCount + band];
        combined[base + band] = values[frame * bandCount + band] * Math.sqrt(0.4);
        combined[base + bandCount + band] = deltaNorm > 0.05 ? delta / deltaNorm * Math.sqrt(0.6) : 0;
      }
      const base = frame * bandCount * 2;
      let combinedNorm = 0;
      for (let band = 0; band < bandCount * 2; band++) combinedNorm += combined[base + band] ** 2;
      combinedNorm = Math.sqrt(combinedNorm) || 1;
      for (let band = 0; band < bandCount * 2; band++) combined[base + band] /= combinedNorm;
    }
    return { values: combined, frames: outputFrame, bandCount: bandCount * 2, samples, sampleRate };
  }

  function alignPrepared(querySamples, referenceFeatures, sampleRate, speed = 1, options = {}) {
    const query = stretchSamples(querySamples, speed);
    const featureOptions = { ...DEFAULTS, ...options };
    const queryFeatures = spectralFeatures(query, sampleRate, featureOptions);
    const queryFrames = queryFeatures.frames;
    const referenceFrames = referenceFeatures.frames;
    const bandCount = queryFeatures.bandCount;
    if (queryFrames < 8 || referenceFrames < queryFrames) {
      return { score: 0, startMs: null, queryFrames, referenceFrames };
    }

    const maxStart = referenceFrames - queryFrames;
    let bestScore = -Infinity;
    let bestStart = 0;
    const scores = new Float32Array(maxStart + 1);
    for (let start = 0; start <= maxStart; start += 1) {
      let score = 0;
      for (let frame = 0; frame < queryFrames; frame += 1) {
        const queryBase = frame * bandCount;
        const referenceBase = (start + frame) * bandCount;
        let similarity = 0;
        for (let band = 0; band < bandCount; band += 1) {
          similarity += queryFeatures.values[queryBase + band] * referenceFeatures.values[referenceBase + band];
        }
        score += similarity;
      }
      score /= queryFrames;
      scores[start] = score;
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
      }
    }

    const frameDurationMs = featureOptions.hopSize * featureOptions.featureStride * 1000 / sampleRate;
    // Adjacent frames belong to the same peak. Compare against independent
    // locations, otherwise a precise match always appears ambiguous.
    const exclusionFrames = Math.ceil(2000 / frameDurationMs);
    let secondScore = -1;
    for (let index = 0; index < scores.length; index += 1) {
      if (Math.abs(index - bestStart) > exclusionFrames) secondScore = Math.max(secondScore, scores[index]);
    }
    const peaks = [];
    const ordered = Array.from(scores, (score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
    for (const candidate of ordered) {
      if (peaks.some(peak => Math.abs(peak.index - candidate.index) <= exclusionFrames)) continue;
      peaks.push(candidate);
      if (peaks.length >= (options.fineSearch === false ? 1 : 5)) break;
    }
    let hypotheses = peaks.map(peak => ({ score: peak.score, startMs: Math.round(peak.index * frameDurationMs),
      margin: peak.score - Math.max(-1, secondScore) }));
    if (Number.isFinite(options.hintStartMs) && options.hintStartMs >= 0
      && !hypotheses.some(peak => Math.abs(peak.startMs - options.hintStartMs) < frameDurationMs)) {
      hypotheses.push({ startMs: options.hintStartMs, score: 0 });
    }
    if (options.fineSearch !== false && referenceFeatures.samples?.length) {
      hypotheses = hypotheses.map(peak => {
        const radius = frameDurationMs * 2;
        const start = Math.max(0, Math.round((peak.startMs - radius) * sampleRate / 1000));
        const end = Math.min(referenceFeatures.samples.length, Math.round((peak.startMs + radius) * sampleRate / 1000) + query.length);
        const fineOptions = { ...featureOptions, hopSize: 128, featureStride: 1, fineSearch: false };
        const local = spectralFeatures(referenceFeatures.samples.subarray(start, end), sampleRate, fineOptions);
        const refined = alignPrepared(query, local, sampleRate, 1, fineOptions);
        return Number.isFinite(refined.startMs) ? { score: refined.score, startMs: start * 1000 / sampleRate + refined.startMs } : peak;
      }).sort((a, b) => b.score - a.score);
      for (const peak of hypotheses) peak.margin = peak.score - (hypotheses.find(other => Math.abs(other.startMs - peak.startMs) > 2000)?.score ?? -1);
    }
    const best = hypotheses[0];
    return {
      score: best?.score ?? bestScore,
      margin: best?.margin ?? bestScore - Math.max(-1, secondScore),
      startMs: best?.startMs ?? Math.round(bestStart * frameDurationMs),
      hypotheses,
      queryFrames,
      referenceFrames,
    };
  }

  function align(querySamples, referenceSamples, sampleRate, speed = 1, options = {}) {
    const featureOptions = { ...DEFAULTS, ...options };
    return alignPrepared(
      querySamples,
      spectralFeatures(referenceSamples, sampleRate, featureOptions),
      sampleRate,
      speed,
      featureOptions,
    );
  }

  global.AudioReferenceAlignment = {
    align,
    alignPrepared,
    prepare: spectralFeatures,
  };
}(typeof window !== "undefined" ? window : self));
