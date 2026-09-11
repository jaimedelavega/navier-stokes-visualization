// Presentation helpers only: interpolation of precomputed local flow samples.
export function decodeFlow(metadata, buffer) {
  if (metadata.version !== 1 || metadata.curves !== 116 || metadata.samples !== 720 || metadata.stride !== 5) {
    throw new Error('Unsupported ribbon data format.');
  }
  if (buffer.byteLength !== metadata.curves * metadata.samples * 20 || buffer.byteLength !== metadata.byteLength) {
    throw new Error('The ribbon download is incomplete.');
  }
  const view = new DataView(buffer);
  const values = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < values.length; i++) {
    values[i] = view.getFloat32(i * 4, true);
    if (!Number.isFinite(values[i])) throw new Error('Invalid ribbon sample.');
  }
  if (metadata.releaseSeconds?.length !== metadata.curves ||
      !metadata.releaseSeconds.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('Invalid particle release schedule.');
  }
  const curves = Array.from({ length: metadata.curves }, (_, index) => {
    const samples = values.subarray(index * metadata.samples * 5, (index + 1) * metadata.samples * 5);
    for (let i = 1; i < metadata.samples; i++) {
      if (samples[i * 5 + 3] <= samples[(i - 1) * 5 + 3]) throw new Error('Nonmonotone travel time.');
    }
    return { index, samples, length: samples[(metadata.samples - 1) * 5 + 3], release: metadata.releaseSeconds[index] };
  });
  return { metadata, curves };
}

export function samplePosition(curve, q, target) {
  if (q < 0 || q > curve.length) return false;
  const points = curve.samples;
  let low = 0;
  let high = points.length / 5 - 1;
  while (high - low > 1) {
    const middle = (high + low) >> 1;
    if (points[middle * 5 + 3] <= q) low = middle;
    else high = middle;
  }
  const a = low * 5;
  const b = high * 5;
  const fraction = (q - points[a + 3]) / (points[b + 3] - points[a + 3]);
  for (let axis = 0; axis < 3; axis++) target[axis] = points[a + axis] + fraction * (points[b + axis] - points[a + axis]);
  return true;
}

export function selectedPaths(count, total = 116) {
  count = Math.max(0, Math.min(total, Math.round(count)));
  return Array.from({ length: count }, (_, index) => Math.floor(index * total / count));
}

export function wrapPhase(phase, period) {
  return ((phase % period) + period) % period;
}

export const PARTICLES_PER_PATH = 3;

export function createParticleClocks(flow) {
  return Float64Array.from(flow.curves, (curve) => wrapPhase(.27, curve.length));
}

export function advanceParticleClocks(flow, clocks, delta, velocity) {
  const distance = Math.max(0, delta) * velocity * flow.metadata.flowUnitsPerSecond;
  for (const curve of flow.curves) clocks[curve.index] = wrapPhase(clocks[curve.index] + distance, curve.length);
}

export function forEachParticle(flow, clocks, count, phaseOffset, visit) {
  const { metadata, curves } = flow;
  count = Math.max(0, Math.min(curves.length * PARTICLES_PER_PATH, Math.round(count)));
  for (let id = 0; id < count; id++) {
    // 37 is coprime to the 116 original paths. A stable prefix means changing
    // particle count never relocates any surviving particle or its trail.
    const curve = curves[(id * 37) % curves.length];
    const offset = (id * .618033988749895) % 1;
    const q = wrapPhase(clocks[curve.index] + (offset + phaseOffset) * curve.length
      - curve.release * metadata.flowUnitsPerSecond, curve.length);
    const fadeDistance = .1 * metadata.flowUnitsPerSecond;
    const fade = Math.max(0, Math.min(1, q / fadeDistance, (curve.length - q) / fadeDistance));
    visit(curve, q, fade, id, Math.floor(id / curves.length));
  }
}
