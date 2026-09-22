// Estimate smooth paper shading from OUTSIDE the edited box. Never copy pixels
// from the words being covered into the replacement. Unsupported backgrounds
// decline to the existing flat fill; this is not texture reconstruction.
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

function fit(samples) {
  const m = Array.from({ length: 3 }, () => Array(6).fill(0));
  for (const { x, y, rgb } of samples) {
    const v = [1, x, y];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) m[i][j] += v[i] * v[j];
      for (let ch = 0; ch < 3; ch += 1) m[i][ch + 3] += v[i] * rgb[ch];
    }
  }
  for (let i = 0; i < 3; i += 1) {
    let pivot = i;
    for (let j = i + 1; j < 3; j += 1) if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    if (Math.abs(m[i][i]) < 1e-8) return null;
    const divisor = m[i][i];
    for (let k = i; k < 6; k += 1) m[i][k] /= divisor;
    for (let j = 0; j < 3; j += 1) {
      if (j === i) continue;
      const factor = m[j][i];
      for (let k = i; k < 6; k += 1) m[j][k] -= factor * m[i][k];
    }
  }
  return [0, 1, 2].map((ch) => m.map((row) => row[ch + 3]));
}

export function paperAt(plane, x, y) {
  return plane.map(([a, b, c]) => Math.max(0, Math.min(255, a + b * x + c * y)));
}

export function estimatePaper(samples) {
  if (samples.length < 24 || samples.some((s) => ![s.x, s.y, ...s.rgb].every(Number.isFinite))) return null;
  let kept = samples;
  let plane;
  // Refit after rejecting ink on the sampling ring. The final support check
  // requires clean paper on all four sides, so a nearby rule cannot silently
  // become a one-sided extrapolation through the edit.
  for (let pass = 0; pass < 4; pass += 1) {
    plane = fit(kept);
    if (!plane) return null;
    const errors = kept.map((s) => Math.max(...paperAt(plane, s.x, s.y).map((c, ch) => Math.abs(c - s.rgb[ch]))));
    const cutoff = Math.max(5, median(errors) * 2.5);
    kept = kept.filter((_, i) => errors[i] <= cutoff);
    if (kept.length < samples.length * 0.7) return null;
  }
  plane = fit(kept);
  if (!plane) return null;
  if (![s => s.x < 0, s => s.x > 1, s => s.y < 0, s => s.y > 1]
    .every((side) => kept.filter(side).length >= 4)) return null;
  const error = Math.sqrt(kept.reduce((sum, s) => sum + paperAt(plane, s.x, s.y)
    .reduce((n, c, ch) => n + (c - s.rgb[ch]) ** 2, 0), 0) / (kept.length * 3));
  if (error > 5) return null;
  return plane;
}
