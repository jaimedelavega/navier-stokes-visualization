import * as THREE from 'three';
import { selectedPaths, PARTICLES_PER_PATH } from './flow-data.js';

// Display grading only: retain the angular-rate swatches and emphasize the
// orange end under the browser's different lighting and tone mapping.
const warmColor = `
  float warmth = smoothstep(0.05, 0.45, diffuseColor.r - diffuseColor.b);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.0, 0.78, 0.52), warmth);
`;

// Transport the frame through EVERY original sample before thinning rings.
// This preserves ribbon twist and width at both surface detail levels.
export function createRibbonGeometry(flow, step = 2) {
  const positions = [], colors = [], travel = [], curveIndices = [], indices = [], ranges = [];
  const tangent = new THREE.Vector3(), normal = new THREE.Vector3(), binormal = new THREE.Vector3();
  const palette = [[.035, .65, .62], [.12, .31, .82], [.93, .43, .09]];
  let vertexOffset = 0;
  for (const curve of flow.curves) {
    const start = indices.length;
    const points = curve.samples;
    const count = points.length / 5;
    let rings = 0;
    const width = .042 + .045 * (.5 + .5 * Math.sin(curve.index * 13.4));
    for (let j = 0; j < count; j++) {
      const before = Math.max(0, j - 1) * 5, after = Math.min(count - 1, j + 1) * 5;
      tangent.set(points[after] - points[before], points[after + 1] - points[before + 1], points[after + 2] - points[before + 2]).normalize();
      if (j === 0) {
        normal.crossVectors(tangent, new THREE.Vector3(0, 0, 1));
        if (normal.length() < 1e-5) normal.crossVectors(tangent, new THREE.Vector3(1, 0, 0));
        normal.normalize();
      }
      normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
      if (j % step !== 0 && j !== count - 1) continue;
      binormal.crossVectors(tangent, normal);
      const taper = Math.max(.025, Math.max(0, Math.sin(Math.PI * (j / (count - 1)))) ** .45);
      // Map angular rate to 32 swatches in linear RGB.
      const swatch = Math.max(0, Math.min(31, Math.round((points[j * 5 + 4] - 3.8) / 4.2 * 31)));
      const t = swatch / 31 * 2, band = Math.min(1, Math.floor(t)), mix = t - band;
      for (let k = 0; k < 8; k++) {
        const angle = k * Math.PI / 4;
        for (let axis = 0; axis < 3; axis++) {
          positions.push(points[j * 5 + axis] + width * taper * (Math.cos(angle) * normal.getComponent(axis) + .3 * Math.sin(angle) * binormal.getComponent(axis)));
          colors.push(palette[band][axis] * (1 - mix) + palette[band + 1][axis] * mix);
        }
        travel.push(points[j * 5 + 3] + curve.release * flow.metadata.flowUnitsPerSecond);
        curveIndices.push(curve.index);
      }
      if (rings > 0) {
        for (let k = 0; k < 8; k++) {
          const a = vertexOffset + (rings - 1) * 8 + k;
          const b = vertexOffset + (rings - 1) * 8 + (k + 1) % 8;
          indices.push(a, b, b + 8, a, b + 8, a + 8);
        }
      }
      rings++;
    }
    vertexOffset += rings * 8;
    ranges.push({ start, count: indices.length - start });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('flowTravel', new THREE.Float32BufferAttribute(travel, 1));
  geometry.setAttribute('curveIndex', new THREE.Float32BufferAttribute(curveIndices, 1));
  geometry.setIndex(indices);
  // Retain a master index so selection changes do not rebuild the surfaces.
  geometry.userData.ribbonRanges = ranges;
  geometry.userData.fullIndex = geometry.index.array.slice();
  geometry.index.setUsage(THREE.DynamicDrawUsage);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function setRibbonSelection(geometry, count) {
  const { fullIndex, ribbonRanges } = geometry.userData;
  let offset = 0;
  for (const index of selectedPaths(count, ribbonRanges.length)) {
    const range = ribbonRanges[index];
    geometry.index.array.set(fullIndex.subarray(range.start, range.start + range.count), offset);
    offset += range.count;
  }
  geometry.setDrawRange(0, offset);
  geometry.index.needsUpdate = true;
}

export function createRibbonMaterial() {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .2, roughness: .34 });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      `#include <color_fragment>\n${warmColor}\ndiffuseColor.rgb *= 0.72;`);
  };
  material.customProgramCacheKey = () => 'warm-static-ribbon-v3';
  return material;
}

export function createParticleTrails(sourceGeometry, metadata) {
  // Share immutable vertex attributes, but keep an independent index buffer:
  // hiding a base ribbon must not hide a particle's attached surface trail.
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(sourceGeometry.attributes)) geometry.setAttribute(name, attribute);
  geometry.setIndex(new THREE.BufferAttribute(sourceGeometry.userData.fullIndex.slice(), 1));
  geometry.index.setUsage(THREE.DynamicDrawUsage);
  geometry.boundingSphere = sourceGeometry.boundingSphere.clone();
  geometry.userData.ribbonRanges = sourceGeometry.userData.ribbonRanges;
  geometry.userData.fullIndex = sourceGeometry.userData.fullIndex;
  const samples = new Float32Array(metadata.curves * PARTICLES_PER_PATH * 4);
  const texture = new THREE.DataTexture(samples, metadata.curves, PARTICLES_PER_PATH, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, polygonOffset: true,
    polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.particleState = { value: texture };
    shader.vertexShader = `attribute float flowTravel; attribute float curveIndex;
      varying float vFlowTravel; varying float vCurveIndex;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlowTravel = flowTravel; vCurveIndex = curveIndex;');
    shader.fragmentShader = `uniform sampler2D particleState;
      varying float vFlowTravel; varying float vCurveIndex;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${warmColor}
        float strength = 0.0;
        for (int slot = 0; slot < ${PARTICLES_PER_PATH}; slot++) {
          vec2 uv = vec2((vCurveIndex + 0.5) / ${metadata.curves.toFixed(1)}, (float(slot) + 0.5) / ${PARTICLES_PER_PATH.toFixed(1)});
          vec2 particle = texture2D(particleState, uv).rg;
          float age = particle.x - vFlowTravel;
          float tailLength = ${(metadata.trailDecay * 1.5).toFixed(8)};
          if (particle.y > 0.0 && age >= 0.0 && age < tailLength) {
            float tail = pow(1.0 - age / tailLength, 2.0);
            strength = max(strength, particle.y * tail * smoothstep(0.0, 0.006, age));
          }
        }
        if (strength < 0.002) discard;
        diffuseColor.rgb *= 1.5;
        diffuseColor.a *= strength;
      `);
  };
  material.customProgramCacheKey = () => 'attached-particle-trails-v3';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  return { mesh, texture, samples };
}

export function setTrailSelection(geometry, count) {
  const { fullIndex, ribbonRanges } = geometry.userData;
  let offset = 0;
  // After one complete population, every original curve carries a tracer.
  for (let id = 0; id < Math.min(count, ribbonRanges.length); id++) {
    const range = ribbonRanges[(id * 37) % ribbonRanges.length];
    geometry.index.array.set(fullIndex.subarray(range.start, range.start + range.count), offset);
    offset += range.count;
  }
  geometry.setDrawRange(0, offset);
  geometry.index.needsUpdate = true;
}

export function writeParticleTrail(trails, metadata, curve, q, fade, slot) {
  const offset = (slot * metadata.curves + curve.index) * 4;
  trails.samples[offset] = q + curve.release * metadata.flowUnitsPerSecond;
  trails.samples[offset + 1] = fade;
}
