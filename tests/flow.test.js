import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeFlow, samplePosition, selectedPaths, forEachParticle, createParticleClocks, advanceParticleClocks, wrapPhase } from '../src/flow-data.js';
import { createRibbonGeometry, setRibbonSelection, createParticleTrails, setTrailSelection, writeParticleTrail } from '../src/ribbons.js';

const metadata = JSON.parse(readFileSync(new URL('../public/flow/metadata.json', import.meta.url)));
const bytes = readFileSync(new URL('../public/flow/ribbons.bin', import.meta.url));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const flow = decodeFlow(metadata, buffer);

test('bundled flow data has the recorded digest and rejects truncation/corruption', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  assert.throws(() => decodeFlow(metadata, buffer.slice(0, -4)), /incomplete/);
  const corrupt = buffer.slice(0);
  new DataView(corrupt).setFloat32(0, NaN, true);
  assert.throws(() => decodeFlow(metadata, corrupt), /Invalid ribbon sample/);
  const nonmonotone = buffer.slice(0);
  new DataView(nonmonotone).setFloat32(8 * 4, -1, true);
  assert.throws(() => decodeFlow(metadata, nonmonotone), /Nonmonotone/);
});

test('interpolation uses travel time, including exact endpoints and unequal segment durations', () => {
  const curve = { samples: new Float32Array([0, 0, 0, 0, 5, 1, 2, 3, 1, 5, 9, 8, 7, 5, 5]), length: 5 };
  const point = [];
  assert.equal(samplePosition(curve, -1, point), false);
  assert.equal(samplePosition(curve, 6, point), false);
  for (const [time, expected] of [[0, [0, 0, 0]], [1, [1, 2, 3]], [3, [5, 5, 5]], [5, [9, 8, 7]]]) {
    assert.equal(samplePosition(curve, time, point), true);
    assert.deepEqual(point, expected);
  }
});

test('density selects every fourth path at 29 and never introduces a new curve', () => {
  assert.deepEqual(selectedPaths(29), Array.from({ length: 29 }, (_, i) => i * 4));
  assert.deepEqual(selectedPaths(0), []);
  for (let count = 1; count <= 116; count++) {
    const paths = selectedPaths(count);
    assert.equal(new Set(paths).size, count);
    assert.ok(paths.every((i) => i >= 0 && i < 116));
  }
});

function gatherParticles(phase, count, clocks = createParticleClocks(flow)) {
  const particles = [];
  forEachParticle(flow, clocks, count, phase, (curve, q, fade, id, slot) => {
    const p = [];
    assert.equal(samplePosition(curve, q, p), true);
    assert.ok(Math.hypot(p[0], p[1]) < 3.8 && Math.abs(p[2]) <= 9.000001);
    assert.ok(fade >= 0 && fade <= 1);
    particles.push([curve.index, q, ...p, id, slot]);
  });
  return particles;
}

test('particle count is exact, stable, and populated independently of the full paths', () => {
  assert.equal(gatherParticles(.27, 0).length, 0);
  for (const count of [1, 58, 116, 232, 348]) assert.equal(gatherParticles(.375, count).length, count);
  for (let percent = 0; percent <= 100; percent++) {
    assert.equal(gatherParticles(percent / 100, 58).length, 58);
  }
  const first = gatherParticles(.27, 29);
  gatherParticles(.6, 29);
  assert.deepEqual(gatherParticles(.27, 29), first);
  assert.deepEqual(gatherParticles(.27, 348).slice(0, 29), first);
});

test('phase endpoints coincide, while advection respects each path travel time at every velocity', () => {
  const start = gatherParticles(0, 116), end = gatherParticles(1, 116);
  assert.equal(start.length, end.length);
  for (let i = 0; i < start.length; i++) {
    start[i].forEach((value, axis) => assert.ok(Math.abs(value - end[i][axis]) < 1e-12));
  }
  const clocks = createParticleClocks(flow);
  for (const [delta, velocity] of [[.01, 1], [.01, 2], [0, .25], [30, 1], [1000000, 2]]) {
    const before = gatherParticles(.375, 348, clocks);
    advanceParticleClocks(flow, clocks, delta, velocity);
    const after = gatherParticles(.375, 348, clocks);
    before.forEach((particle, id) => {
      const length = flow.curves[particle[0]].length;
      const expected = wrapPhase(particle[1] + delta * velocity * metadata.flowUnitsPerSecond, length);
      assert.ok(Math.abs(after[id][1] - expected) < 1e-9);
    });
    flow.curves.forEach((curve) => assert.ok(clocks[curve.index] >= 0 && clocks[curve.index] < curve.length));
  }
});

test('both surface detail levels keep complete eight-sided ribbons centered on original samples', () => {
  for (const step of [2, 4]) {
    const geometry = createRibbonGeometry(flow, step);
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const times = geometry.getAttribute('flowTravel');
    let ring = 0;
    for (const curve of flow.curves) {
      for (let j = 0; j < metadata.samples; j++) {
        if (j % step !== 0 && j !== metadata.samples - 1) continue;
        const center = [0, 0, 0];
        for (let side = 0; side < 8; side++) {
          const v = ring * 8 + side;
          center[0] += positions.getX(v) / 8;
          center[1] += positions.getY(v) / 8;
          center[2] += positions.getZ(v) / 8;
          assert.ok(Math.abs(Math.hypot(normals.getX(v), normals.getY(v), normals.getZ(v)) - 1) < 1e-5);
          assert.ok(Math.abs(times.getX(v) - (curve.samples[j * 5 + 3] + curve.release * metadata.flowUnitsPerSecond)) < 2e-7);
          assert.equal(geometry.getAttribute('curveIndex').getX(v), curve.index);
        }
        for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(center[axis] - curve.samples[j * 5 + axis]) < 1e-6);
        ring++;
      }
    }
    assert.equal(positions.count, ring * 8);
    assert.ok(geometry.index.array.every((index) => index < positions.count));
    const fullIndex = geometry.index.array.slice();
    for (const count of [29, 1, 0, 58, 116]) {
      setRibbonSelection(geometry, count);
      const ringsPerCurve = ring / metadata.curves;
      const verticesPerCurve = ringsPerCurve * 8;
      const visible = new Set();
      for (let i = 0; i < geometry.drawRange.count; i++) {
        visible.add(Math.floor(geometry.index.array[i] / verticesPerCurve));
      }
      assert.deepEqual([...visible], selectedPaths(count));
      const expectedTriangles = count * (ringsPerCurve - 1) * 8 * 2;
      assert.equal(geometry.drawRange.count, expectedTriangles * 3);
    }
    assert.deepEqual(geometry.index.array, fullIndex);

    const trails = createParticleTrails(geometry, metadata);
    assert.equal(trails.mesh.geometry.getAttribute('position'), positions);
    // A particle trail uses the identical transported surface, even with no
    // corresponding full ribbon. Its index state cannot change the paths.
    setRibbonSelection(geometry, 0);
    setTrailSelection(trails.mesh.geometry, 58);
    assert.equal(geometry.drawRange.count, 0);
    assert.ok(trails.mesh.geometry.drawRange.count > 0);
    const clocks = createParticleClocks(flow);
    const occupied = new Set();
    forEachParticle(flow, clocks, 348, .375, (curve, q, fade, id, slot) => {
      writeParticleTrail(trails, metadata, curve, q, fade, slot);
      const cell = (slot * metadata.curves + curve.index) * 4;
      occupied.add(cell);
      assert.ok(Math.abs(trails.samples[cell] - (q + curve.release * metadata.flowUnitsPerSecond)) < 2e-7);
      assert.ok(Math.abs(trails.samples[cell + 1] - fade) < 1e-7);
    });
    assert.equal(occupied.size, 348);
    const beforeCountChange = gatherParticles(.375, 58, clocks);
    setRibbonSelection(geometry, 116);
    assert.deepEqual(gatherParticles(.375, 58, clocks), beforeCountChange);
    const fullPathCount = geometry.drawRange.count;
    setTrailSelection(trails.mesh.geometry, 0);
    trails.samples.fill(0);
    assert.equal(trails.mesh.geometry.drawRange.count, 0);
    assert.ok(trails.samples.every((value) => value === 0));
    assert.equal(geometry.drawRange.count, fullPathCount);
    assert.deepEqual(geometry.index.array, fullIndex);
    trails.mesh.geometry.dispose();
    trails.mesh.material.dispose();
    trails.texture.dispose();
    geometry.dispose();
  }
});
