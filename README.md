# Navier–Stokes ribbon visualization

A standalone, mobile-friendly Three.js animation of a swirling local flow.
Ribbons show paths through a frozen velocity field. Bright particles and their
attached trails move along those paths; color shows turning rate around the axis.

## Run locally

Install Node.js 22.12 or newer and npm, then run from this folder:

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. A browser with WebGL 2 is required.
No API keys, backend, Python, or rendering software are needed.

```sh
npm test
npm run build
npm run preview
```

The build creates a static `dist/` folder with relative asset URLs. Serve it
through an HTTP server; opening the HTML directly from disk will not load the
modules and flow data. Generated builds are not checked into this repository.

## Explore

- Drag to orbit, including direct top and bottom views. Pinch or scroll to zoom.
- Change particle velocity, Path Count, and Particle Count independently.
- Reset restores the camera, 1× velocity, 116 paths, and 58 particles.
- Collapse Controls for more space, or use Full screen to show only the model.
  Double-tap/double-click the model or press Escape to return.
- With the model focused, arrow keys rotate, +/− zoom, and Home resets.
- Reduced-motion preferences keep the particles still.

## Code and data

| File | Purpose |
| --- | --- |
| `src/main.js` | Scene, lighting, animation loop, and interface |
| `src/ribbons.js` | Ribbon meshes, colors, and attached particle trails |
| `src/flow-data.js` | Data decoding, travel-time interpolation, and particle motion |
| `src/viewer-camera.js` | Orbit limits and camera reset |
| `src/viewer-presentation.js` | Fullscreen with a full-window fallback |
| `src/style.css`, `index.html` | Responsive interface |
| `public/flow/` | Required precomputed samples and their format metadata |
| `tests/` | Data integrity, geometry, motion, camera, and fullscreen checks |

The dataset contains 116 paths with 720 samples each. `ribbons.bin` stores
little-endian float32 values in path/sample order, with five values per sample:
`x, y, z, travel, omega`. It is 1,670,400 bytes. Positions use normalized display
coordinates; `travel` is the increasing path travel coordinate and `omega` is
the turning-rate value used for color. Metadata includes a SHA-256 digest,
fixed particle offsets (`releaseSeconds`), a global motion scale
(`flowUnitsPerSecond`), and a trail parameter (`trailDecay`). The displayed
trail spans 1.5 times that parameter. Path lengths come from the final samples.

Particles interpolate by travel time, not equal distance. Stable identities keep
existing particles in place when their count changes. At a path boundary a
particle fades out and returns to that path's entry. This recycling is a display
convention, not a physical connection between endpoints. Ribbon thickness and
trail length are visual aids.

## Scientific scope

These samples come from a numerical reconstruction of a small local patch of
the leading flow described in Appendix B of the
[OpenAI Navier–Stokes paper](https://cdn.openai.com/pdf/32d9f210-8b73-45e0-91bc-82a30aef8a9a/navier-stokes.pdf).
The viewer holds the field fixed. It does not solve Navier–Stokes in the browser
or display the complete evolving construction. Tests check the bundled data and
animation behavior; they are not a mathematical proof.

This repository contains the viewer and its required samples. It does not
include the numerical reconstruction or data-generation pipeline, so the sample
dataset cannot be regenerated here. The paper is a scientific reference, not a
runtime dependency.

## License

Project code and bundled flow samples use the [MIT license](LICENSE).
Three.js and Vite retain their own licenses, included with their npm packages.
