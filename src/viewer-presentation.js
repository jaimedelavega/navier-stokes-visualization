// Native fullscreen when available; the same model-only layout is the fallback.
export function createFullscreenView(element, document, onChange) {
  let active = false;
  let generation = 0;
  const setActive = (value) => {
    if (active === value) return;
    active = value;
    onChange(value);
  };
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement !== element && active) {
      generation++;
      setActive(false);
    }
  });
  return {
    get active() { return active; },
    async enter() {
      const request = ++generation;
      setActive(true);
      if (!element.requestFullscreen || document.fullscreenEnabled === false) return;
      try {
        await element.requestFullscreen();
        // A user may exit while the browser is still accepting the request.
        if (request !== generation && document.fullscreenElement === element) await document.exitFullscreen();
      } catch {
        // Rejected/unsupported fullscreen keeps the usable full-window view.
      }
    },
    async exit() {
      generation++;
      if (document.fullscreenElement === element) {
        try { await document.exitFullscreen(); } catch { return; }
      }
      setActive(false);
    },
  };
}
