// Frozen 1.7 colour treatment, retained solely for regression verification.
function readableAccent(color) {
  const boosted = {
    r: Math.min(255, color.r * 1.35 + 28),
    g: Math.min(255, color.g * 1.35 + 28),
    b: Math.min(255, color.b * 1.35 + 28),
  };
  return rgbToHex(blendColor(boosted, { r: 132, g: 244, b: 208 }, 0.35));
}
function separateGradientEnds(top, bottom) {
  if (colorDistance(top, bottom) >= 72) return { top, bottom };
  const cool = blendColor(top, { r: 112, g: 190, b: 255 }, 0.32);
  const warm = blendColor(bottom, { r: 255, g: 214, b: 112 }, 0.24);
  return { top: makeTimelineColor(cool), bottom: makeTimelineColor(warm) };
}
