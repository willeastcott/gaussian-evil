# splat-resident-evil

A Gaussian splat capture of two people, relit in real time by a hand-held torch. Prototype, built with PlayCanvas.

Move the pointer to aim the torch, drag to orbit, scroll to zoom. Space (or the Relighting button) switches the relighting off to show the capture as shot. Lightning strikes every 7 to 16 seconds; L fires a strike at once. Sound starts with your first click or key press, and the Sound button turns it off. The Effects button (or P) switches the post effects off and on.

## How it works

Splats carry their capture lighting baked in, and have no usable normals of their own. So the lighting comes from a stand-in:

1. `tools/bake-proxy.mjs` builds a closed, solid mesh of the figures' real surface from the splats (`public/proxy.glb`).
2. At run time the engine's `GSplatRelighting` script renders that mesh, lit by ordinary lights with shadow maps, into an offscreen texture.
3. Every splat fragment is multiplied by the lighting at its own pixel.

The torch is a shadow-casting spot light. It lights the proxy mesh and the floor.

The baked mesh casts the shadows, on the figures and on the ground. The mesh that receives light is a copy of it grown outwards by 1.2 cm (`src/shadow-caster.js`): lighting is looked up per pixel, and a splat reaches a little past the surface it sits on, so without the margin a few pixels at each silhouette would find no mesh behind them. The grown copy casts nothing, because a limb that much too thick throws a shadow that much too wide.

### The mesh

A capture of a person is a thin, hollow shell of splats, and it has real openings where nothing was photographed: up under the hem of a jacket, under a dress, the soles of the shoes. Where the cameras saw little, such as between two people standing back to back, the shell is only a few faint splats. `tools/bake-proxy.mjs` therefore works from what the splats cover, and from the outside in:

1. Every splat is drawn into a 5 mm voxel grid as the ellipsoid it is, with its own rotation and scale. A voxel holds how opaque the splats make that point. (Treating splats as points leaves holes wherever a smooth surface is made of a few large ones.)
2. Voxels that are at all opaque are the shell, and the floor is sealed under it.
3. The outside is found by line of sight: a voxel is outside if it can be seen from somewhere in the sky, from the horizon to straight overhead. Everything else is the body. Flooding in from the edges of the grid is not enough, because it finds the openings and hollows the body out.
4. The solid is smoothed and turned into a mesh with surface nets, with normals from the gradient of the solid, so they always point outwards.

The result is one closed piece with no open edges, 78,535 vertices and 3.8 MB, sitting about 1 cm from the nearest opaque splat centre (`tools/proxy-girth.mjs` measures this). Drawn on its own, it covers 99.4% to 99.95% of the pixels the splats cover, depending on the view; the grown copy covers all of them.

### The ground

Wet asphalt with standing puddles (`src/ground.js`). It is a StandardMaterial, so the torch lights and shadows it like anything else, with four shader chunks replaced by procedural ones that work from the world position. A few octaves of slow noise give the lie of the ground, and water stands wherever that is below the water level. Asphalt is two sizes of stone in dark binder, which sets its colour, gloss and normal. A puddle is flat, nearly black, mirror-glossy and mostly see-through. Detail finer than a pixel fades out with distance so the stones do not shimmer.

### The reflection

The reflection is made of splats too; there is no reflection pass. `tools/mirror-ply.mjs` writes a copy of the capture mirrored in the floor plane, thinned to 35% (`public/mirror.sog`). A vertex hook (`src/wet-floor.js`) treats every splat below the floor as a reflection: it fades with depth and viewing angle, grows so that it blurs with distance from the surface, and slides sideways in slow ripples. A mirrored proxy mesh under a mirrored torch, on its own layer, lights it to match the real figures.

Three layers are drawn in order: the reflected figures, then the ground over them, then everything else. The ground is opaque where it is asphalt and thin where it is water, so the reflection shows in the puddles and nowhere else, cut to each puddle's outline per pixel.

### Time runs

Rain falls, so the figures cannot be statues. `src/life.js` gives them small motions without a rig: each is a smooth displacement field in world space (a lean about the feet, a swelling chest, wind in the hem of her dress and the hair down her back), applied in the same vertex hook, and mirrored for the reflections. The fields are placed from `tools/body-profile.mjs`. The lighting proxy does not move, so the amplitudes stay around a centimetre.

The rain (`src/rain.js`) is one mesh of thin quads rather than splats, lit in its vertex shader against the torch cone, so only the beam shows it.

Each drop splashes where it lands (`src/splash.js`). Nothing is simulated on the CPU: a drop's path is a pure function of its seed and the time, so the place and moment it hits the ground are too, and the splash shaders work them out for the same drops. A landing throws up a few droplets on ballistic arcs, a small crown in a puddle and a lower, shorter spray on asphalt. A landing in a puddle also sends out a ring, cut off at the puddle's edge. A ring is seen mostly by what it does to the reflection: it is drawn after the engine's scene colour grab, and re-draws the water under it from that picture at a point shifted by the wave's slope. Its crests also catch a glint of the torch.

### Lightning

Every so often the whole scene is lit from somewhere else (`src/lightning.js`). A strike is a shadow-casting directional light from a new point of the sky each time, with a mirrored twin for the reflection. Its brightness follows real lightning: two or three strokes a tenth of a second apart, each at full strength at once and then dying away. The same level drives the sky (clear colour and fog), the ambient light, the sky mirrored in the puddles, and the rain and splashes, which are otherwise lit only by the torch. The lights run dark for the first few frames so their shaders are built during loading, not at the first flash.

Flashing stays within the usual photosensitivity limit of three flashes a second, and with `prefers-reduced-motion` a strike is one slow swell.

### Post effects

`src/post.js` adds a glow around what is bright, a colour grade, a touch of lens and film grain. The engine's own effects (`CameraFrame`) are not used: they draw the scene into a linear-light target, so splats blend in linear light, which turns dark cloth grey. Here the camera draws exactly as it would to the screen, only into an 8-bit texture, and a second camera that owns no geometry runs full-screen passes over it: keep what is brighter than a threshold at a quarter of the size, blur that tightly, again at an eighth of the size for a wide halo and again at a sixteenth for a haze, then a finishing pass. The finish parts red and blue slightly towards the edges as a lens would, adds the three glows back as light, grades the picture (cool shadows, warm highlights, a faint cold veil so the dark is never quite black), and applies the vignette and grain. It costs about two milliseconds a frame.

The scene is mostly black, so effects that only touch bright areas or corners are close to invisible: the first version changed the picture by 1.5 levels in 255 on average. The veil, the lower glow threshold and the haze are what make the effects register.

### Sound

`src/audio.js` plays rain, wind and thunder through Web Audio.

- Rain is three recorded textures at once: drops on asphalt, drops in puddles, and the wash of rain further off. Each loops with a crossfade made on the decoded samples, starts at its own point, runs at a slightly different speed and drifts a couple of decibels on its own cycle. The puddles come forward when the camera is down near the water.
- Wind is synthesised from filtered noise and follows the same gusts that move her hair and dress.
- Thunder follows each lightning strike. Every strike has a distance, which sets how bright the flash is, how long the thunder takes to arrive (0.2 to 3.2 seconds), how loud and how dull it is, and which recording is used. It is panned to the side of the sky the bolt came from.

The recordings come from the ElevenLabs sound-generation API through `npm run audio` (`tools/build-audio.mjs`). Raw takes are cached in `tools/audio-raw/`, so a rebuild needs no key. These generations often carry a steady buzz at 200 Hz and its harmonics, so the tool looks for any steady tone in each take, notches it out and checks again. A generated wind was buzz from 400 Hz to 13 kHz, which is why the wind is synthesised.

## Run

```
npm install
npm run dev
```

Query options: `?device=webgl2` or `?device=webgpu` to force a device, `?proxy=1` to draw the mesh that receives light over the splats, `?proxy=2` to draw the baked mesh that casts the shadows, `?debug` for a frame-rate readout, `?wet=0` to leave out the reflection (and the life motion; the puddles are then just dark), `?life=0` for the figures as captured, `?rain=0` for no rain, `?splash=0` for rain without splashes, `?lightning=0` for no lightning, `?sound=0` for no sound, `?post=0` to start with the post effects off.

## Rebuild the data

The source PLY is not in the repo. Put it at `raw/scene.ply`, then:

```
npx splat-transform -w raw/scene.ply public/scene.sog
npm run bake
node tools/mirror-ply.mjs raw/scene.ply raw/mirror.ply
npx splat-transform -w raw/mirror.ply --decimate 35% raw/mirror-dec.ply
npx splat-transform -w raw/mirror-dec.ply public/mirror.sog
```

`npm run bake` takes `VOXEL`, `OCCUPIED`, `CLOSE`, `VIEWS`, `SMOOTH`, `FLOOR` and `MIN_ISLAND` environment variables; see the top of the tool. It prints each figure's volume, which shows at once whether a body came out solid, and `SLICE=0.7` prints a plan of the solid cut at that fraction of the height.

## Credit

Capture: "Resident Evil - (Video in description)" by Adrian Cuesta, Dymensium volumetric capture
(https://superspl.at/scene/67841e9d), licensed CC BY 4.0. The performers are Mike Galeck and Beatriz Olcina.
