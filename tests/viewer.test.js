import test from 'node:test';
import assert from 'node:assert/strict';
import { OrthographicCamera, Vector3 } from 'three';
import { createCameraControls, resetCameraControls } from '../src/viewer-camera.js';
import { createFullscreenView } from '../src/viewer-presentation.js';

test('orbit reaches both poles, leaves them, and resets without residual drift', () => {
  const camera = new OrthographicCamera(-10, 10, 10, -10, .1, 150);
  camera.up.set(0, 0, 1);
  camera.position.set(12, -22, 24.3);
  camera.lookAt(0, 0, 0);
  const start = camera.position.clone();
  const controls = createCameraControls(camera, null);
  const settle = () => { for (let i = 0; i < 400; i++) controls.update(); };
  controls.rotateUp(10);
  settle();
  assert.ok(camera.position.clone().normalize().dot(camera.up) > 1 - 1e-10);
  controls.rotateUp(-.3);
  settle();
  assert.ok(controls.getPolarAngle() > .2);
  controls.rotateUp(-10);
  settle();
  assert.ok(camera.position.clone().normalize().dot(camera.up) < -1 + 1e-10);
  assert.ok(camera.getWorldDirection(new Vector3()).toArray().every(Number.isFinite));
  controls.rotateUp(.3);
  camera.zoom = 2;
  resetCameraControls(controls);
  settle();
  assert.ok(camera.position.distanceTo(start) < 1e-10);
  assert.equal(camera.zoom, 1);
});

function fullscreenFixture(request) {
  const document = new EventTarget();
  document.fullscreenEnabled = true;
  document.fullscreenElement = null;
  document.exitFullscreen = async () => {
    document.fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  const element = {};
  if (request) element.requestFullscreen = () => request(document, element);
  const changes = [];
  return { document, element, changes, view: createFullscreenView(element, document, (value) => changes.push(value)) };
}

test('native fullscreen restores the page when the browser exits', async () => {
  const fixture = fullscreenFixture(async (document, element) => {
    document.fullscreenElement = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await fixture.view.enter();
  assert.equal(fixture.view.active, true);
  await fixture.document.exitFullscreen();
  assert.equal(fixture.view.active, false);
  assert.deepEqual(fixture.changes, [true, false]);
});

test('unsupported or rejected fullscreen keeps an escapable model-only view', async () => {
  for (const request of [null, async () => { throw new Error('Not permitted'); }]) {
    const { view, changes } = fullscreenFixture(request);
    await view.enter();
    assert.equal(view.active, true);
    await view.exit();
    assert.deepEqual(changes, [true, false]);
  }
});

test('exiting during a pending fullscreen request cannot trap the user', async () => {
  let accept;
  const fixture = fullscreenFixture((document, element) => new Promise((resolve) => {
    accept = () => {
      document.fullscreenElement = element;
      document.dispatchEvent(new Event('fullscreenchange'));
      resolve();
    };
  }));
  const pending = fixture.view.enter();
  await fixture.view.exit();
  accept();
  await pending;
  assert.equal(fixture.view.active, false);
  assert.equal(fixture.document.fullscreenElement, null);
});
