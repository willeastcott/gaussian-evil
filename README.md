# gaussian-evil

A Gaussian splat capture of two people, in the dark and the rain, relit in real time by a torch that you hold. Built with PlayCanvas.

It opens on a title card. Enter, and the scene plays by itself: darkness and rain; lightning shows the two of them for an instant; the torch clicks on at their feet and climbs to their faces; then a 36-second film of five shots, which loops. Click or tap at any moment and the torch is yours.

| | Mouse | Touch |
|---|---|---|
| Aim the torch | move the pointer | turn the phone, or tap |
| Look around | drag | drag |
| Zoom | scroll | pinch |

In the top corner, a button (I) opens a panel that says how it is done. Along the bottom: three shots (Both, Him, Her), the film (D), lightning now (L), the capture as it was shot, without the torch (Space), sound, and full screen (F). P switches the post effects off and on. Lightning also strikes by itself every 7 to 16 seconds. Leave it alone for 25 seconds and the camera and the torch drift by themselves; leave it for 35 more and the film plays, until you touch something.

## How it works

Splats carry their capture lighting baked in, and have no usable normals of their own. So the lighting comes from a stand-in:

1. `tools/bake-proxy.mjs` builds two closed, solid meshes of the figures from the splats (`public/proxy.glb`): their real surface, and a smooth envelope of it.
2. At run time the engine's `GSplatRelighting` script renders that mesh, lit by ordinary lights with shadow maps, into an offscreen texture.
3. Every splat fragment is multiplied by the lighting at its own pixel.

The torch is a shadow-casting spot light. It lights the proxy mesh and the floor.

The two meshes have different jobs (`src/shadow-caster.js`). The real surface casts the shadows, on the figures and on the ground. The envelope receives the light, grown outwards by 0.4 cm first: a splat reaches a little past the surface it sits on. The envelope casts nothing, because a limb that is too thick throws a shadow that is too wide.

### Light from the right depth

The lighting texture holds one surface per pixel, the nearest, and the envelope is a little bigger than the splats it stands in for. So where an arm passes in front of a face, the arm's mesh overhangs the face by a centimetre or so, and that strip of face was lit as the arm: by its dim, side-on rim. From close to, the outline of the mesh showed through on whatever was behind it.

`src/relight-depth.js` makes the lookup aware of depth. The proxy writes its distance from the camera into the texture's alpha. Each frame a half-size texture is made from that, holding for every pixel the lighting of the furthest mesh surface within 2 cm on screen: what is behind an overhang, carried in under it. A third texture is the first again with its depth negated wherever the second found something further off. A splat fragment reads that one, and only where the pixel is marked does it read the second and take whichever was lit at a depth closer to its own. It costs about 1.5 to 2 ms a frame. The same texture carries lighting out past the edge of the mesh, so the envelope is grown by only 0.4 cm.

### The mesh

A capture of a person is a thin, hollow shell of splats, and it has real openings where nothing was photographed: up under the hem of a jacket, under a dress, the soles of the shoes. Where the cameras saw little, such as between two people standing back to back, the shell is only a few faint splats. `tools/bake-proxy.mjs` therefore works from what the splats cover, and from the outside in:

1. Every splat is drawn into a 5 mm voxel grid as the ellipsoid it is, with its own rotation and scale. A voxel holds how opaque the splats make that point. (Treating splats as points leaves holes wherever a smooth surface is made of a few large ones.)
2. Voxels that are at all opaque are the shell, and the floor is sealed under it.
3. The outside is found by line of sight: a voxel is outside if it can be seen from somewhere in the sky, from the horizon to straight overhead. Everything else is the body. Flooding in from the edges of the grid is not enough, because it finds the openings and hollows the body out.
4. The solid is smoothed and turned into a mesh with surface nets, with normals from the gradient of the solid, so they always point outwards.

The surface is one closed piece with no open edges, 78,535 vertices, sitting about 1 cm from the nearest opaque splat centre (`tools/proxy-girth.mjs` measures this).

The envelope is the same solid with its hollows filled in: every crease and overhang narrower than 4 cm is bridged, the way cling film would lie over the figure, and it is meshed at half the resolution (18,860 vertices). Its normals come from a smoother field still. It exists because lighting is taken from the nearest mesh surface in front of each pixel, and should follow the broad form of a head or a limb. On the real surface, a fringe of hair hangs over the forehead and a brow over the eye, and the normal swings round at each such rim. With the lighting carried out past its edge (see above), at most 0.2% of the pixels the splats cover are left without lighting, in any of six views.

Light also wraps a little way round the far side of the figures (`wrapLight` in `src/shadow-caster.js`). The torch is held beside the lens, not on it, so wherever one part of a figure overlaps another, the camera sees a sliver of the nearer part that has already turned away from the torch. With plain diffuse lighting and nothing to fill it, that sliver is black: a line along a fringe, a patch beside a nose. Skin, hair and cloth scatter light, so on them the edge of the light is soft.

Both meshes are in one 4.7 MB file.

### The ground

Wet asphalt with standing puddles (`src/ground.js`). It is a StandardMaterial, so the torch lights and shadows it like anything else, with four shader chunks replaced by procedural ones that work from the world position. A few octaves of slow noise give the lie of the ground, and water stands wherever that is below the water level. Asphalt is two sizes of stone in dark binder, which sets its colour, gloss and normal. A puddle is flat, nearly black, mirror-glossy and mostly see-through. Detail finer than a pixel fades out with distance so the stones do not shimmer.

Wet ground is mostly what it mirrors, and seen from near the ground a flat fill of sky colour inside a clean outline looked like paint. So what each pixel mirrors is worked out:

- How much it mirrors goes by the angle it is seen at: almost nothing looking straight down, nearly everything along the ground. The angle is taken to the surface as it lies at that point, ripples and stones included, so moving water shows as moving light.
- What it mirrors is the sky where the mirrored line of sight meets it, darkest overhead and lighter towards the horizon. Water far off is lighter than water at your feet.
- Wet asphalt has a film of water on it and mirrors too: less, roughly, and most on the face of a stone. From low down it is no longer a black shape beside the water.
- Water deepens little by little. At its edge the stones stand out of it, so the waterline follows them and is never a clean curve.
- Ripples too small to see from where the camera is are left out of the surface, where they would only flicker, and blur what the water mirrors instead.
- The lamp is mirrored as a streak towards whoever is looking: short and bright on water, long and faint on asphalt. A lamp is far brighter than a screen can show, so how thinly its image is spread is weighed up before its brightness is capped.

### The reflection

The reflection is made of splats too; there is no reflection pass. `tools/mirror-ply.mjs` writes a copy of the capture mirrored in the floor plane, thinned to 35% (`public/mirror.sog`). A vertex hook (`src/wet-floor.js`) treats every splat below the floor as a reflection: it fades with depth and viewing angle, grows so that it blurs with distance from the surface, and slides sideways in slow ripples. A mirrored proxy mesh under a mirrored torch, on its own layer, lights it to match the real figures.

Three layers are drawn in order: the reflected figures, then the ground over them, then everything else. The ground is opaque where it is asphalt and thin where it is water, so the reflection shows in the puddles and nowhere else, cut to each puddle's outline per pixel.

### Time runs

Rain falls, so the figures cannot be statues. `src/life.js` gives them small motions without a rig: each is a smooth displacement field in world space (a lean about the feet, breathing, wind in the hem of her dress and the hair down her back), applied in the same vertex hook, and mirrored for the reflections. Breathing swells the ribs only, between the waist and the collarbone; the shoulders, neck and head ride up on them as one piece, so a face in close-up rises and falls by 4 mm but does not change shape. The fields are placed from `tools/body-profile.mjs`. The lighting proxy does not move, so the amplitudes stay around a centimetre.

The rain (`src/rain.js`) is one mesh of thin quads rather than splats, lit in its vertex shader against the torch cone, so only the beam shows it.

Each drop splashes where it lands (`src/splash.js`). Nothing is simulated on the CPU: a drop's path is a pure function of its seed and the time, so the place and moment it hits the ground are too, and the splash shaders work them out for the same drops. A landing throws up a few droplets on ballistic arcs, a small crown in a puddle and a lower, shorter spray on asphalt. A landing in a puddle also sends out a ring, cut off at the puddle's edge. A ring is seen mostly by what it does to the reflection: it is drawn after the engine's scene colour grab, and re-draws the water under it from that picture at a point shifted by the wave's slope. Its crests also catch a glint of the torch.

### Mist

`src/mist.js` lays a low mist over the ground: a few dozen wide, soft sheets a little above it, each turned to face the camera, drifting with the wind. Like the rain it is dark until lit. Every pixel of a sheet is lit from its own place against the torch's cone, so the beam shows as a soft shaft where it crosses the mist, and a lightning flash lifts all of it at once. Slow noise breaks the sheets into wisps, and a sheet fades out as the camera nears it. Splats write no depth, so mist behind a figure would glow through it; each pixel of mist therefore looks up the distance to the figures' proxy mesh, which the lighting texture already carries, and goes dark where a figure is nearer. `?mist=0` leaves it out.

### The visit

`src/director.js` gives a visit its shape: title card, opening, the torch handed over, a drift when nobody is steering, and the film. Two things change hands between the script and the visitor.

The camera. While the script has it, the engine's orbit controls are switched off and the camera is placed directly; handing it back is `controls.focusPoint = ...`, which makes the controls take up the camera from wherever it stands, so there is never a jump. Moves between the three shots are flown the same way, round whatever the camera is looking at, over a second or two. (The controls' own move is over in a fifth of a second: with fly mode off they ignore `focusDamping` and use the damping meant for drags.)

The torch. The point on screen it aims at is a mix of where the script points it and where the visitor does, and the mix slides from one to the other. `src/aim.js` supplies the visitor's half: the pointer under a mouse; the last tap on a touch screen, since a drag there turns the camera; and on a phone that reports its orientation, the direction its back is facing, as a torch held in the hand would point. That direction is worked out from all three angles together, which keeps it steady with the phone upright, where two of them fight over the same turn. A turn of the phone moves the beam 1.6 times as far across the view, and a beam held against the edge of the screen does not wind up. When a mouse leaves the scene, for a button or off the page, nobody is aiming the torch: left where the pointer crossed the edge it would light the ground and leave the two of them dark, so the script takes it and brings it to rest on whatever the camera is looking at, swaying a little, until the mouse comes back.

The title card (`src/title.js`) is there for more than looks. A browser will not play sound, nor an iPhone report its orientation, until something has been clicked, so the way in is a button and both are started from it. The scene is already drawing behind the card, dark, so the first frames, which build shaders and sort the splats, are over before anything is seen. The bar shows bytes: the splat loader reports its progress.

On a screen held upright the lens widens from 40° to as much as 62° top to bottom, to keep the same width in view: the two of them stand side by side, and from the same place a phone would cut off his elbow and her pistol.

### The film

`src/demo.js` is the scene playing by itself: five shots cut together, 36.5 seconds, looping. Dark, and lightning shows the pair from behind; the torch comes on at their feet and climbs. Her, close. Him, cut to on a flash, from further back and lit from the side: the shortest shot. Down by the water, the longest, where the beam comes across the puddles and lightning fills them with sky. Then up and back until the torch goes out. It ends and begins in the dark, so the loop has no seam, and a line there says how to take the torch.

It is for three things: a clip to share, which is how a demo like this travels; a screen left running; and the visitor who would sooner watch than steer. So there are four ways in: Enter on the title card (`?demo=0` makes Enter a short opening that hands the torch straight over), the play button or D once inside, `?demo` (no title card, and so no sound until somebody clicks), and the idle drift, which hands over to it after 35 seconds. Asked for, it runs until a click, a tap, Space, Enter or Escape; started by itself, moving the mouse is enough. Either way the camera is handed back where it stands. F still works, for a recording, and the pointer is hidden until the mouse moves.

While the film plays the picture is letterboxed to 2.39:1, by two bars that slide in and out. The lens widens to match, so the band between them takes in, top to bottom, what the whole screen did: the bars add picture at the sides and crop nothing. When the torch is taken they slide away, the lens closes in, and the picture grows to fill the screen. A screen held upright has no bars, and the rendered video has none.

A shot is a run from one camera to another at a steady speed, so the camera is already moving when a shot is cut to and still moving when it is cut from. A camera is written as the point it looks at and its bearing from that point, which makes the run an arc round the subject. The torch is written as the point in the world it lights; the director turns that into the point on screen that the torch is aimed through, and the distance, every frame. After a cut the beam is put on its mark at once. Up close the torch is turned down, or it burns a face out. Lightning comes on cue, so every run is the same.

One cut goes right round to the far side of the pair. With WebGL 2 the splats are sorted off the main thread, and the first frame after a jump like that is still drawn in the old order: measured, 7% of the picture is wrong for one frame (WebGPU shows nothing). So that shot opens on 80 milliseconds of black, and the lightning that follows is what shows him.

### Lightning

Every so often the whole scene is lit from somewhere else (`src/lightning.js`). A strike is a shadow-casting directional light from a new point of the sky each time, with a mirrored twin for the reflection. Its brightness follows real lightning: two or three strokes a tenth of a second apart, each at full strength at once and then dying away. The same level drives the sky (clear colour and fog), the ambient light, the sky mirrored in the puddles, and the rain and splashes, which are otherwise lit only by the torch. The lights run dark for the first few frames so their shaders are built during loading, not at the first flash.

Flashing stays within the usual photosensitivity limit of three flashes a second, and with `prefers-reduced-motion` a strike is one slow swell.

### The lamp, and the night

Two lit figures in a black void say nothing about where they are, and when the torch is elsewhere nothing shows at all. So there is a lamp on a short mast a few metres behind them (`src/lamp.js`). It is an ordinary spot light on the same layers as the torch: cold where the torch is warm, and from behind, so it draws an edge of light round the pair and throws their shadows towards the camera. Its shadow map is drawn once, because neither it nor the mesh that casts the shadows ever moves; it costs about a millisecond a frame. A mirrored twin lights the reflections, and the ground mirrors the lamp itself as a streak of light. Rain and mist are lit in their own shaders, so they are told where the lamp is and the rain in its beam can always be seen. It stands that close because the rain is a box 8 m square about the pair. It flickers: mostly steady, with a short stutter every few seconds (never with `prefers-reduced-motion`). A soft halo, turned to the camera, keeps the lens from looking like a lit sign.

The night itself is no longer quite black either: the sky is just light enough for the ground to end against, standing water shows as water, and every drop of rain carries a trace of light. Measured over the film, the picture had sat about 3% above black between flashes.

### Post effects

`src/post.js` adds a glow around what is bright, a colour grade, a touch of lens and film grain. The engine's own effects (`CameraFrame`) are not used: they draw the scene into a linear-light target, so splats blend in linear light, which turns dark cloth grey. Here the camera draws exactly as it would to the screen, only into an 8-bit texture, and a second camera that owns no geometry runs full-screen passes over it: keep what is brighter than a threshold at a quarter of the size, blur that tightly, again at an eighth of the size for a wide halo and again at a sixteenth for a haze, then a finishing pass. The finish parts red and blue slightly towards the edges as a lens would, adds the three glows back as light, grades the picture (cool shadows, warm highlights, a faint cold veil so the dark is never quite black), and applies the vignette and grain. It costs about two milliseconds a frame.

The scene is mostly black, so effects that only touch bright areas or corners are close to invisible: the first version changed the picture by 1.5 levels in 255 on average. The veil, the lower glow threshold and the haze are what make the effects register.

### Sound

`src/audio.js` plays rain, wind and thunder through Web Audio.

- Rain is three recorded textures at once: drops on asphalt, drops in puddles, and the wash of rain further off. Each loops with a crossfade made on the decoded samples, starts at its own point, runs at a slightly different speed and drifts a couple of decibels on its own cycle. The puddles come forward when the camera is down near the water.
- Wind is synthesised from filtered noise and follows the same gusts that move her hair and dress.
- The torch clicks when it comes on: a tick of filtered noise with a short thump under it, synthesised.
- Very occasionally something groans, a long way off: four recorded voices, never the same one twice running, one or two minutes apart. Each is slowed, dulled, set off to one side and given a late echo off the wet ground. The film asks for two of its own.
- The title is said aloud when Enter is pressed, as the series says its own on its title screen: the card drops everything but the name and holds while a deep voice says it, then the film begins. It is text-to-speech (ElevenLabs), dropped three semitones, slowed a tenth and given a short echo by `tools/build-audio.mjs`. Three takes are kept, and the second is the one used; `TITLE_TAKE=a npm run audio` switches to another. The rendered video says it under its closing title, timed to end as the lightning strikes.
- Thunder follows each lightning strike. Every strike has a distance, which sets how bright the flash is, how long the thunder takes to arrive (0.2 to 3.2 seconds), how loud and how dull it is, and which recording is used. It is panned to the side of the sky the bolt came from.

The recordings come from the ElevenLabs sound-generation API through `npm run audio` (`tools/build-audio.mjs`). Raw takes are cached in `tools/audio-raw/`, so a rebuild needs no key. These generations often carry a steady buzz at 200 Hz and its harmonics, so the tool looks for any steady tone in each take, notches it out and checks again. A generated wind was buzz from 400 Hz to 13 kHz, which is why the wind is synthesised.

## Run

```
npm install
npm run dev
```

Query options: `?device=webgl2` or `?device=webgpu` to force a device, `?proxy=1` to draw the envelope that receives light over the splats, `?proxy=2` to draw the surface that casts the shadows, `?debug` for a frame-rate readout, `?wet=0` to leave out the reflection (and the life motion; the puddles are then just dark), `?life=0` for the figures as captured, `?rain=0` for no rain, `?splash=0` for rain without splashes, `?lightning=0` for no lightning, `?sound=0` for no sound, `?post=0` to start with the post effects off, `?intro=0` to skip the title card and the opening, `?idle=N` to drift after N seconds left alone (0 for never, which also means the film never starts by itself), `?demo` to open on the film with no title card, `?lamp=0` for no lamp.

## Render the film to a video

A screen recording drops frames, so the film is rendered instead (`src/capture.js`, dev server only). Open `http://localhost:5173/?demo` and run `__sr.capture.run()` in the console; `__sr.capture.state` says how far it has got. Every frame is stepped by exactly 1/60 s, drawn at 1920 x 1080 and encoded by the browser (WebCodecs H.264). The sound is rendered, not recorded: the same audio code runs on an `OfflineAudioContext`, and whatever would have been played is scheduled at the moment the film has reached. Both land in `captures/`. Then:

```
npm run film
```

joins them into `captures/gaussian-evil-film.mp4` (x264 CRF 18, AAC, sound brought to -18 LUFS by one fixed gain). The video runs 5.8 seconds past the end of the film, into the lightning that opens its loop: the title comes up low in the picture, the flash shows the pair above it, and the credit for the capture is on screen.

`__sr.capture.still()` makes that last flash into `captures/share.jpg`, the 1200 x 630 picture a shared link shows (`public/share.jpg`), and `__sr.capture.icons()` makes the page's icons. `run({ width: 1080, height: 1920 })` renders it upright.

## Rebuild the data

The source PLY is not in the repo. Put it at `raw/scene.ply`, then:

```
npx splat-transform -w raw/scene.ply public/scene.sog
npm run bake
node tools/mirror-ply.mjs raw/scene.ply raw/mirror.ply
npx splat-transform -w raw/mirror.ply --decimate 35% raw/mirror-dec.ply
npx splat-transform -w raw/mirror-dec.ply public/mirror.sog
```

`npm run bake` takes `VOXEL`, `OCCUPIED`, `CLOSE`, `VIEWS`, `SMOOTH`, `ENVELOPE`, `FLOOR` and `MIN_ISLAND` environment variables; see the top of the tool. It prints each figure's volume, which shows at once whether a body came out solid, and `SLICE=0.7` prints a plan of the solid cut at that fraction of the height.

## Credit

Capture: ["Resident Evil - (Video in description)"](https://superspl.at/scene/67841e9d) by Adrian Cuesta, Dymensium volumetric capture, on SuperSplat, licensed CC BY 4.0. The performers are Mike Galeck and Beatriz Olcina.
