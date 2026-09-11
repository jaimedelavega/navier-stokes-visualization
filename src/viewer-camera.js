import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createCameraControls(camera, viewport) {
  const controls = new OrbitControls(camera, viewport);
  controls.enableDamping = true;
  controls.dampingFactor = .08;
  controls.enablePan = false;
  controls.rotateSpeed = .65;
  controls.minZoom = .6;
  controls.maxZoom = 3;
  // OrbitControls retains a microscopic pole epsilon to keep the camera stable.
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;
  controls.saveState();
  return controls;
}

export function resetCameraControls(controls) {
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update(); // Consume any remaining drag momentum before restoring.
  controls.reset();
  controls.enableDamping = damping;
}
