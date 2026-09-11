import * as THREE from 'three';
import { createCameraControls, resetCameraControls } from './viewer-camera.js';
import { createFullscreenView } from './viewer-presentation.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { decodeFlow, samplePosition, forEachParticle, createParticleClocks, advanceParticleClocks, PARTICLES_PER_PATH } from './flow-data.js';
import { createRibbonGeometry, createRibbonMaterial, setRibbonSelection, createParticleTrails, setTrailSelection, writeParticleTrail } from './ribbons.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const parameterControls = [
  { id: 'velocity', key: 'velocity', suffix: '×', unit: 'times' },
  { id: 'paths', key: 'pathCount', suffix: '', unit: 'paths' },
  { id: 'particles', key: 'particleCount', suffix: '', unit: 'particles' },
];
const particlePhase = .375;
const state = { dirty: true };
let renderer, controls, camera, flow, clocks, markers, trails, ribbonMesh, scene, lightRig, initialOrientation;
let lastFrame, fullView;
const matrix = new THREE.Matrix4(), point = [0, 0, 0];

function paintRange(input) {
  input.style.setProperty('--fill', `${(Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
}
function updateParameter({ id, key, suffix, unit }) {
  const input = $(id);
  state[key] = Number(input.value);
  $(id + '-value').textContent = `${state[key]}${suffix}`;
  input.setAttribute('aria-valuetext', `${state[key]} ${unit}`);
  if (id === 'paths' && ribbonMesh) {
    setRibbonSelection(ribbonMesh.geometry, state.pathCount);
    ribbonMesh.visible = state.pathCount > 0;
    renderer.shadowMap.needsUpdate = true;
  } else if (id === 'particles' && trails) {
    setTrailSelection(trails.mesh.geometry, state.particleCount);
    trails.mesh.visible = state.particleCount > 0;
  }
  paintRange(input);
  state.dirty = true;
}
function resetViewAndControls() {
  if (controls) resetCameraControls(controls);
  for (const parameter of parameterControls) {
    // The HTML defaults are shared by initial setup and every reset.
    $(parameter.id).value = $(parameter.id).defaultValue;
    updateParameter(parameter);
  }
}
function showError(message) {
  $('loading').hidden = false;
  $('loading').classList.add('error');
  $('loading-text').textContent = message;
  $('retry').hidden = false;
  $('flow-controls').disabled = true;
  $('reset-view').disabled = true;
  $('fullscreen').disabled = true;
  void fullView?.exit();
  renderer?.setAnimationLoop(null);
}

function setupControls() {
  for (const parameter of parameterControls) {
    updateParameter(parameter);
    $(parameter.id).addEventListener('input', () => updateParameter(parameter));
  }
  $('reset-view').addEventListener('click', resetViewAndControls);
  $('toggle-controls').addEventListener('click', () => {
    const collapsed = !$('control-panel').hidden;
    $('control-panel').hidden = collapsed;
    $('toggle-controls').setAttribute('aria-expanded', String(!collapsed));
    $('toggle-controls').title = collapsed ? 'Show controls' : 'Hide controls';
  });
  let savedScroll = 0;
  fullView = createFullscreenView($('stage'), document, (active) => {
    if (active) savedScroll = window.scrollY;
    document.body.classList.toggle('model-only', active);
    if (active) $('viewport').focus({ preventScroll: true });
    else {
      $('fullscreen').focus({ preventScroll: true });
      window.scrollTo({ top: savedScroll, behavior: 'instant' });
    }
    state.dirty = true;
  });
  $('fullscreen').addEventListener('click', () => { void fullView.enter(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && fullView.active) {
      event.preventDefault();
      void fullView.exit();
    }
  });
  // Recognize two short, stationary taps; orbit drags and pinches never exit.
  const pointers = new Set();
  let tap, previousTap;
  $('viewport').addEventListener('pointerdown', (event) => {
    pointers.add(event.pointerId);
    if (!fullView.active || event.button !== 0 || pointers.size !== 1) {
      tap = previousTap = undefined;
      return;
    }
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
  });
  $('viewport').addEventListener('pointermove', (event) => {
    if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10) tap = previousTap = undefined;
  });
  $('viewport').addEventListener('pointerup', (event) => {
    pointers.delete(event.pointerId);
    if (!tap || tap.id !== event.pointerId || event.timeStamp - tap.time > 250) {
      tap = previousTap = undefined;
      return;
    }
    if (previousTap && event.timeStamp - previousTap.time < 350 && Math.hypot(tap.x - previousTap.x, tap.y - previousTap.y) < 24) {
      void fullView.exit();
      previousTap = undefined;
    } else previousTap = { ...tap, time: event.timeStamp };
    tap = undefined;
  });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    $('viewport').addEventListener(type, (event) => { pointers.delete(event.pointerId); tap = undefined; });
  }
  $('viewport').addEventListener('keydown', (event) => {
    if (!camera) return;
    const direction = { ArrowLeft: -.08, ArrowRight: .08, ArrowUp: -.08, ArrowDown: .08 };
    if (event.key in direction) {
      // OrbitControls uses Y-up internally. Map to/from the scene's Z-up frame.
      const rotation = new THREE.Quaternion().setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
      const offset = camera.position.clone().sub(controls.target).applyQuaternion(rotation);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') spherical.theta += direction[event.key];
      else spherical.phi = THREE.MathUtils.clamp(spherical.phi + direction[event.key], controls.minPolarAngle, controls.maxPolarAngle);
      camera.position.copy(controls.target).add(offset.setFromSpherical(spherical).applyQuaternion(rotation.invert()));
    } else if (event.key === '+' || event.key === '=' || event.key === '-') {
      camera.zoom = THREE.MathUtils.clamp(camera.zoom * (event.key === '-' ? .9 : 1.1), controls.minZoom, controls.maxZoom);
      camera.updateProjectionMatrix();
    } else if (event.key === 'Home') resetViewAndControls();
    else return;
    event.preventDefault();
    controls.update();
    state.dirty = true;
  });
  $('about-button').addEventListener('click', () => {
    $('about-dialog').showModal();
  });
  $('close-about').addEventListener('click', () => $('about-dialog').close());
  $('about-dialog').addEventListener('close', () => { lastFrame = undefined; });
  $('about-dialog').addEventListener('click', (event) => {
    if (event.target === $('about-dialog')) {
      const box = $('about-dialog').getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('about-dialog').close();
    }
  });
  $('retry').addEventListener('click', () => window.location.reload());
  reducedMotion.addEventListener('change', () => { lastFrame = undefined; });
  document.addEventListener('visibilitychange', () => {
    lastFrame = undefined;
    if (flow && renderer && !$('loading').classList.contains('error')) {
      renderer.setAnimationLoop(document.hidden ? null : frame);
    }
  });
}

function resize() {
  const { width, height } = $('viewport').getBoundingClientRect();
  if (!width || !height) return;
  const aspect = width / height;
  const verticalSpan = Math.max(21.5, 10.5 / aspect);
  camera.left = -verticalSpan * aspect / 2;
  camera.right = verticalSpan * aspect / 2;
  camera.top = verticalSpan / 2;
  camera.bottom = -verticalSpan / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  state.dirty = true;
}

function updateParticles() {
  trails.samples.fill(0);
  forEachParticle(flow, clocks, state.particleCount, particlePhase, (curve, q, fade, id, slot) => {
    if (!samplePosition(curve, q, point)) return;
    const radius = .069 * fade;
    matrix.makeScale(radius, radius, radius);
    matrix.setPosition(...point);
    markers.setMatrixAt(id, matrix);
    writeParticleTrail(trails, flow.metadata, curve, q, fade, slot);
  });
  trails.texture.needsUpdate = true;
  markers.count = state.particleCount;
  markers.instanceMatrix.needsUpdate = true;
}

function frame(now) {
  const delta = lastFrame === undefined ? 0 : Math.min((now - lastFrame) / 1000, .1);
  lastFrame = now;
  const moving = controls.update();
  if (!reducedMotion.matches && !$('about-dialog').open) {
    advanceParticleClocks(flow, clocks, delta, state.velocity);
    state.dirty ||= state.particleCount > 0;
  }
  if (!state.dirty && !moving) return;
  updateParticles();
  lightRig.quaternion.copy(camera.quaternion).multiply(initialOrientation);
  if (moving) renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
  state.dirty = false;
}

async function start() {
  setupControls();
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch {
    showError('This browser could not start the 3D view. Try a browser with WebGL 2 enabled.');
    return;
  }
  renderer.domElement.setAttribute('aria-hidden', 'true');
  $('viewport').appendChild(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    showError('The 3D view was interrupted. Reload it to continue.');
  });
  renderer.setClearColor('#080d13');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.matchMedia('(pointer: coarse)').matches ? 1.5 : 2));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 150);
  camera.up.set(0, 0, 1);
  // An elevated orthographic view keeps the full local flow in frame.
  camera.position.set(12, -22, 24.3);
  camera.lookAt(0, 0, 0);
  initialOrientation = camera.quaternion.clone().invert();
  controls = createCameraControls(camera, $('viewport'));
  controls.addEventListener('change', () => { state.dirty = true; renderer.shadowMap.needsUpdate = true; });
  controls.addEventListener('start', () => $('viewport').focus({ preventScroll: true }));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  const environmentMap = pmrem.fromScene(environment, .04);
  scene.environment = environmentMap.texture;
  // A restrained fill preserves amber/blue saturation and dark folds.
  scene.environmentIntensity = .12;
  environment.dispose();
  pmrem.dispose();
  lightRig = new THREE.Group();
  scene.add(lightRig);
  const light = (color, intensity, position) => {
    const result = new THREE.DirectionalLight(color, intensity);
    result.position.set(...position);
    lightRig.add(result);
    return result;
  };
  const key = light(0xffe2bf, 2.7, [-7, -9, 11]);
  light(0x4cb2ff, .95, [7, 4, 7]);
  light(0xff9a48, 1.8, [-3, 7, -4]);
  light(0xffecd6, .24, [4, -12, -3]);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: .1, far: 45 });
  key.shadow.bias = -.00015;
  key.shadow.normalBias = .025;
  key.shadow.camera.updateProjectionMatrix();
  new ResizeObserver(resize).observe($('viewport'));
  resize();
  try {
    const responses = await Promise.all(['metadata.json', 'ribbons.bin'].map((file) => fetch(`${import.meta.env.BASE_URL}flow/${file}`, { signal: AbortSignal.timeout(20000) })));
    if (responses.some((response) => !response.ok)) throw new Error('The flow data could not be downloaded.');
    const [metadata, buffer] = await Promise.all([responses[0].json(), responses[1].arrayBuffer()]);
    flow = decodeFlow(metadata, buffer);
    clocks = createParticleClocks(flow);
    $('loading-text').textContent = 'Shaping the light…';
    // Allow the loading message to paint before constructing the surface.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const mobile = window.matchMedia('(pointer: coarse)').matches;
    ribbonMesh = new THREE.Mesh(createRibbonGeometry(flow, mobile ? 4 : 2), createRibbonMaterial());
    setRibbonSelection(ribbonMesh.geometry, state.pathCount);
    ribbonMesh.castShadow = true;
    ribbonMesh.receiveShadow = true;
    scene.add(ribbonMesh);
    trails = createParticleTrails(ribbonMesh.geometry, metadata);
    setTrailSelection(trails.mesh.geometry, state.particleCount);
    scene.add(trails.mesh);
    markers = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshStandardMaterial({
      color: 0xc5e7f4, emissive: 0xaccfef, emissiveIntensity: 2, roughness: .26,
    }), metadata.curves * PARTICLES_PER_PATH);
    markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    markers.frustumCulled = false;
    scene.add(markers);
    // Surface shader errors are fatal: never replace scientific geometry with a decorative fallback.
    let shaderFailed = false;
    renderer.debug.onShaderError = () => { shaderFailed = true; };
    await renderer.compileAsync(scene, camera);
    updateParticles();
    renderer.render(scene, camera);
    if (shaderFailed) throw new Error('The ribbon shader is not supported by this device.');
    $('loading').hidden = true;
    $('flow-controls').disabled = false;
    $('reset-view').disabled = false;
    $('fullscreen').disabled = false;
    if (!document.hidden) renderer.setAnimationLoop(frame);
  } catch (error) {
    console.error('Ribbon viewer:', error);
    showError(`${error.message} Try reloading the view.`);
  }
}

start().catch((error) => {
  console.error('Ribbon viewer:', error);
  showError('The 3D view could not finish loading. Try reloading the view.');
});
