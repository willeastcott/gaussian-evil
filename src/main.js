// gaussian-evil: a Gaussian splat capture relit in real time by a hand-held torch.
//
// The splats carry their capture lighting baked in. To relight them, a proxy mesh baked from the
// same splats (tools/bake-proxy.mjs) is lit by ordinary engine lights and rendered to an offscreen
// texture by the engine's GSplatRelighting script; every splat fragment is then tinted by the
// lighting at its own pixel. The same spot light also lights the ground, and a slimmer copy of
// the proxy mesh casts the figures' shadows, on them and onto the ground.
//
// Query: ?device=webgl2|webgpu  ?proxy=1 (draw the envelope that receives light over the splats)  ?proxy=2 (draw the surface that casts the shadows)  ?debug (stats)
//        ?wet=0 (no reflection, and no life motion)  ?rain=0  ?splash=0  ?lightning=0  ?sound=0  ?post=0  ?life=0 (the figures as captured)
//        ?intro=0 (no title card and no opening: straight to the torch)  ?idle=N (seconds before the scene drifts by itself; 0 for never)  ?mist=0
import * as pc from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { GSplatRelighting } from 'playcanvas/scripts/esm/gsplat/gsplat-relighting.mjs';

import { createAim } from './aim.js';
import { createSoundscape } from './audio.js';
import { createDirector } from './director.js';
import { createGround } from './ground.js';
import { createLightning } from './lightning.js';
import { createMist } from './mist.js';
import { createPost } from './post.js';
import { createRain } from './rain.js';
import { createDepthAwareRelighting } from './relight-depth.js';
import { createSplashes } from './splash.js';
import { createCasterEntity, createGrownMesh, wrapLight } from './shadow-caster.js';
import { createTitle } from './title.js';
import { createWetFloor } from './wet-floor.js';

const query = new URLSearchParams(location.search);
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('app'));
const title = createTitle();

// PLY space is y-down and roughly 13 units to the metre: flip it and bring it to metres, feet on y = 0
const SCALE = 0.072;
const PLY_FLOOR_Y = 0.094;
const PLY_CENTRE = [0.5, -1.0];        // x, z of the middle of the pair
const CAMERA_MIN_HEIGHT = 0.12;        // metres: the camera stays this far above the ground
const FOV = 40;                        // degrees, top to bottom
const FOV_ACROSS = 30;                 // at least this many degrees side to side, up to...
const FOV_TALLEST = 62;                // ...this many top to bottom, on a screen held upright
const PITCH_DOWN = -80, PITCH_UP = 10; // degrees the orbit may look down and up
const TORCH_INTENSITY = 1.6;          // of the torch when it is on (a lightning bolt peaks at 2.6)
const PROXY_WRAP = 0.3;                // how far light reaches round the far side of the figures (src/shadow-caster.js)
const RECEIVER_GROW = 0.004;           // metres the mesh that receives light is grown beyond the baked envelope

// head centres in PLY space (tools/find-heads.mjs), the direction each close-up is shot from, and
// where the torch is held (right, up, forward of the camera, at full reach). She aims a pistol
// past her face with her arm across her chest: a torch to the right puts the shadow of her hands
// on her face, one to the left throws the shadow of her forearm up over her neck and chin. Held
// above the lens, both shadows fall downwards, out of sight behind the arm.
const HEADS = {
    him: { head: [6.3, -23.43, -3.73], facing: [0.96, 0, -0.29], hand: [0.6, -0.28, 0.1] },
    her: { head: [-3.78, -20.48, -2.33], facing: [-0.5, 0, 0.87], hand: [0, 0.7, 0.1] }
};

const device = await pc.createGraphicsDevice(canvas, {
    deviceTypes: query.get('device') ? [query.get('device')] : ['webgpu', 'webgl2'],
    antialias: false
}).catch((err) => {
    title.fail('This needs WebGPU or WebGL 2, and this browser offers neither');
    throw err;
});
device.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);

const options = new pc.AppOptions();
options.graphicsDevice = device;
options.mouse = new pc.Mouse(canvas);
options.touch = new pc.TouchDevice(canvas);
options.keyboard = new pc.Keyboard(window);
options.componentSystems = [
    pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem,
    pc.ScriptComponentSystem, pc.GSplatComponentSystem
];
options.resourceHandlers = [pc.TextureHandler, pc.ContainerHandler, pc.ScriptHandler, pc.GSplatHandler, pc.JsonHandler];

const app = new pc.AppBase(canvas);
app.init(options);
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());

const assets = {
    splat: new pc.Asset('scene', 'gsplat', { url: 'scene.sog' }),
    proxy: new pc.Asset('proxy', 'container', { url: 'proxy.glb' }),
    mirror: new pc.Asset('mirror', 'gsplat', { url: 'mirror.sog' })
};
// the bar on the title card: the splats say how many bytes have arrived, the mesh only that it
// has. Sizes in bytes, near enough, for a server that does not give them
const SIZES = { splat: 11.1e6, proxy: 4.7e6, mirror: 2.9e6 };
const arrived = { splat: 0, proxy: 0, mirror: 0 };
const report = () => title.progress(Object.keys(SIZES).reduce((sum, k) => sum + arrived[k] * SIZES[k], 0) / Object.values(SIZES).reduce((a, b) => a + b));
for (const [name, asset] of Object.entries(assets)) {
    asset.on('progress', (received, total) => {
        arrived[name] = Math.min(1, received / (total || SIZES[name]));
        report();
    });
    asset.once('load', () => {
        arrived[name] = 1;
        report();
    });
}
await new Promise((resolve, reject) => new pc.AssetListLoader(Object.values(assets), app.assets).load((err) => {
    if (!err) return resolve();
    title.fail('The scene did not load. Check the connection and try again');
    reject(new Error(`could not load: ${err}`));
}));
app.start();

// darkness: a little cold ambient so the figures never vanish completely
app.scene.ambientLight = new pc.Color(0.24, 0.27, 0.34);

// the ground fades into black rather than ending at a horizon
app.scene.fog.type = pc.FOG_EXP2;
app.scene.fog.color = new pc.Color(0, 0, 0);
app.scene.fog.density = 0.09;

// ---- the capture: splats and their proxy mesh share one transform ----
const stage = new pc.Entity('stage');
stage.setLocalEulerAngles(0, 0, 180);
stage.setLocalScale(SCALE, SCALE, SCALE);
stage.setLocalPosition(PLY_CENTRE[0] * SCALE, PLY_FLOOR_Y * SCALE, -PLY_CENTRE[1] * SCALE);
app.root.addChild(stage);

const splat = new pc.Entity('splat');
splat.addComponent('gsplat', { asset: assets.splat, unified: true });
stage.addChild(splat);

/** @param {number[]} p - point in PLY space */
const toWorld = p => stage.getWorldTransform().transformPoint(new pc.Vec3(p[0], p[1], p[2]));
/** @param {number[]} d - direction in PLY space */
const dirToWorld = d => stage.getWorldTransform().transformVector(new pc.Vec3(d[0], d[1], d[2])).normalize();

// ---- camera ----
// framed low enough to take in the reflection under their feet
const WIDE = { focus: new pc.Vec3(0, 0.78, 0), position: new pc.Vec3(0.65, 1.2, 4.3), hand: new pc.Vec3(0.6, -0.28, 0.1) };
const camera = new pc.Entity('camera');
camera.addComponent('camera', { clearColor: new pc.Color(0, 0, 0), fov: FOV, nearClip: 0.05, farClip: 60 });
// A phone held upright sees a narrow slice of the scene, and the two of them stand side by side:
// from the same place his elbow and her pistol are out of the frame. So on a tall screen the lens
// widens, to keep the same width in view.
const frameLens = () => {
    const across = Math.tan(FOV_ACROSS * 0.5 * pc.math.DEG_TO_RAD) * canvas.clientHeight / Math.max(canvas.clientWidth, 1);
    camera.camera.fov = pc.math.clamp(2 * Math.atan(across) * pc.math.RAD_TO_DEG, FOV, FOV_TALLEST);
};
frameLens();
window.addEventListener('resize', frameLens);
camera.setPosition(WIDE.position);
camera.lookAt(WIDE.focus);
app.root.addChild(camera);
camera.addComponent('script');

const controls = /** @type {CameraControls} */ (camera.script.create(CameraControls));
Object.assign(controls, {
    enableFly: false,
    enablePan: false,
    focusPoint: WIDE.focus,
    pitchRange: new pc.Vec2(PITCH_DOWN, PITCH_UP),
    zoomRange: new pc.Vec2(0.35, 7)
});

// The orbit may look up a little, but must not take the camera under the ground: from there the
// ground is seen from behind and vanishes, and the reflection stands as a second pair of figures.
// So how far it may pitch up depends on how far out it is. The limit acts on where the orbit is
// heading, and the camera eases towards that, so the camera itself is held above ground as well.
const pitchRange = new pc.Vec2(PITCH_DOWN, PITCH_UP);
app.on('update', () => {
    const eye = camera.getPosition(), focus = controls.focusPoint;
    const reach = Math.max(eye.distance(focus), 0.01);
    const up = Math.asin(pc.math.clamp((focus.y - CAMERA_MIN_HEIGHT) / reach, -1, 1)) * pc.math.RAD_TO_DEG;
    pitchRange.y = Math.min(PITCH_UP, up);
    controls.pitchRange = pitchRange;
    if (eye.y < CAMERA_MIN_HEIGHT) camera.setPosition(eye.x, CAMERA_MIN_HEIGHT, eye.z);
});

// Whoever is directing the scene (src/director.js, made further down) moves the camera and the
// torch's aim before anything else this frame reads them.
let direct = null;
app.on('update', dt => direct?.(dt));

// ---- relighting: the proxy mesh, lit by standard lights, tints the splats per pixel ----
const relighting = /** @type {GSplatRelighting} */ (camera.script.create(GSplatRelighting, {
    // brightness 1 with a white proxy: the lighting texture is then the light itself
    properties: { blend: 1, brightness: 1, background: 0.08 }
}));
const relightLayer = relighting.layer;

const proxyMaterial = new pc.StandardMaterial();
proxyMaterial.diffuse = new pc.Color(1, 1, 1);
wrapLight(proxyMaterial, PROXY_WRAP);
relighting.configureMaterial(proxyMaterial);
// each splat takes its light from the mesh surface at its own depth (src/relight-depth.js)
const relightDepth = createDepthAwareRelighting({ app, camera, relighting, proxyMaterial });

// the bake holds two meshes (tools/bake-proxy.mjs). 'surface' is the figures' real surface, and
// casts the shadows. 'envelope' is the same shape with its small hollows and overhangs smoothed
// over; grown a little, so that it covers every splat, it receives the light
// (src/shadow-caster.js)
const baked = assets.proxy.resource.instantiateRenderEntity();
const bakedMesh = name => baked.findComponents('render').find(r => r.entity.name === name).meshInstances[0].mesh;
const surfaceMesh = bakedMesh('surface');
const receiverMesh = createGrownMesh(device, bakedMesh('envelope'), RECEIVER_GROW / SCALE);
const proxy = new pc.Entity('proxy');
proxy.addComponent('render', {
    meshInstances: [new pc.MeshInstance(receiverMesh, proxyMaterial)],
    layers: query.get('proxy') === '1' ? [relightLayer.id, pc.LAYERID_WORLD] : [relightLayer.id],
    castShadows: false,
    receiveShadows: true
});
stage.addChild(proxy);

const casterLayer = new pc.Layer({ name: 'RelightingCasters' });
app.scene.layers.push(casterLayer);
const caster = createCasterEntity(surfaceMesh, proxyMaterial, query.get('proxy') === '2' ? [casterLayer.id, pc.LAYERID_WORLD] : [casterLayer.id]);
stage.addChild(caster);

// ---- ground: wet asphalt with puddles (src/ground.js). Three things are drawn in order: the
// reflected figures, then the ground over them, see-through only where water stands, then
// everything else. The first two get layers of their own ahead of the world ----
const reflectionLayer = new pc.Layer({ name: 'Reflection' });
const groundLayer = new pc.Layer({ name: 'Ground' });
const ringLayer = new pc.Layer({ name: 'GroundRings' });
app.scene.layers.insert(reflectionLayer, 0);
app.scene.layers.insert(groundLayer, 2);
// rain rings lie on the water. They bend what it reflects, so they are drawn after the engine has
// grabbed the picture so far (at the Depth layer) and just before the figures (the world's
// transparent sub-layer, where splats are drawn)
app.scene.layers.insert(ringLayer, app.scene.layers.getTransparentIndex(app.scene.layers.getLayerById(pc.LAYERID_WORLD)));
camera.camera.layers = [...camera.camera.layers, reflectionLayer.id, groundLayer.id, ringLayer.id];
const ground = createGround({ app, camera, layer: groundLayer });

// ---- the torch: a shadow-casting spot light held beside the camera, aimed by the pointer ----
const torch = new pc.Entity('torch');
torch.addComponent('light', {
    type: 'spot',
    color: new pc.Color(1, 0.94, 0.84),
    intensity: 0,
    range: 14,
    innerConeAngle: 12,
    outerConeAngle: 25,
    castShadows: true,
    shadowType: pc.SHADOW_PCF3_32F,
    shadowResolution: 2048,
    shadowBias: 0.2,
    normalOffsetBias: 0.05,
    layers: [relightLayer.id, casterLayer.id, groundLayer.id, pc.LAYERID_WORLD]
});
app.root.addChild(torch);

const state = {
    pointer: new pc.Vec2(0.5, 0.36),       // where the torch points, as a fraction of the canvas
    power: 0,                              // 0 off .. 1 on
    hand: WIDE.hand.clone(),               // torch offset from the camera: right, up, forward (m)
    handTarget: WIDE.hand.clone(),
    aim: new pc.Vec3().copy(WIDE.focus),
    smoothing: 12
};
// where the visitor points it: mouse, tap, or the way a phone is turned (src/aim.js)
const aim = createAim({ canvas, camera, start: [0.5, 0.36] });

const HAND_FULL_DISTANCE = 3;      // metres from the subject at which the torch is held out fully

const tmpA = new pc.Vec3(), tmpB = new pc.Vec3(), tmpC = new pc.Vec3();
function updateTorch(dt) {
    const eye = camera.getPosition();
    // aim at the point under the pointer, at the distance of whatever the camera is looking at
    const depth = tmpA.sub2(controls.focusPoint, eye).dot(camera.forward);
    const r = canvas.getBoundingClientRect();
    camera.camera.screenToWorld(state.pointer.x * r.width, state.pointer.y * r.height, Math.max(0.3, depth), tmpB);
    state.aim.lerp(state.aim, tmpB, 1 - Math.exp(-state.smoothing * dt));
    state.hand.lerp(state.hand, state.handTarget, 1 - Math.exp(-4 * dt));

    // The torch is held out to one side for modelling. Up close that same offset becomes a steep
    // raking light, which blacks out the far side of a nose, so the offset shrinks with the
    // distance to the subject: the beam always arrives from about the same angle off the lens.
    const side = pc.math.clamp(depth / HAND_FULL_DISTANCE, 0.12, 1);
    tmpC.copy(eye)
        .add(tmpA.copy(camera.right).mulScalar(state.hand.x * side))
        .add(tmpA.copy(camera.up).mulScalar(state.hand.y * side))
        .add(tmpA.copy(camera.forward).mulScalar(state.hand.z));
    tmpC.y = Math.max(0.08, tmpC.y);
    torch.setPosition(tmpC);
    torch.light.intensity = TORCH_INTENSITY * state.power;
    torch.lookAt(state.aim);
    torch.rotateLocal(90, 0, 0);       // a spot light shines down its -Y axis
}
app.on('update', updateTorch);

// ---- wet floor: the figures reflected in it ----
const wet = query.get('wet') === '0' ? null : createWetFloor({
    app, stage, plyFloorY: PLY_FLOOR_Y, mirrorAsset: assets.mirror, proxyMaterial,
    receiverMesh, casterMesh: surfaceMesh, camera, relightLayer, reflectionLayer, torch, aim: state.aim
});
if (wet && query.get('life') === '0') wet.settings.life = 0;

// ---- rain, caught in the torch beam ----
const rain = query.get('rain') === '0' ? null : createRain({ app, camera, torch, aim: state.aim });
const splashes = !rain || query.get('splash') === '0' ? null : createSplashes({ app, camera, rain, ground, ringLayer });
// ---- a low mist over the ground, shown up by the torch and by lightning (src/mist.js) ----
const mist = !rain || query.get('mist') === '0' ? null : createMist({ app, rain, relighting });

// ---- lightning: now and then, light from somewhere else in the sky (L fires one) ----
const lightning = query.get('lightning') === '0' ? null : createLightning({
    app, camera, ground, rain,
    layers: [relightLayer.id, casterLayer.id, groundLayer.id, pc.LAYERID_WORLD],
    mirrorLayers: wet ? [wet.mirrorLayer.id, wet.mirrorCasterLayer.id] : null
});

// ---- sound: rain, wind and thunder, started by the way in or the first click or key ----
const $ = id => document.getElementById(id);
const soundButton = $('sound');
const sound = query.get('sound') === '0' ? null : createSoundscape({ app, camera, rain: !!rain, button: soundButton });
if (!sound) soundButton.hidden = true;

// ---- post effects: glow, vignette and grain over the finished picture ----
// (P switches them off and on; ?post=0 starts with them off)
const post = createPost({ app, camera });
const setPost = on => post.setEnabled(on);
setPost(query.get('post') !== '0');

// ---- views ----
const views = { wide: WIDE };
for (const [name, { head, facing, hand }] of Object.entries(HEADS)) {
    const h = toWorld(head), f = dirToWorld(facing);
    views[name] = { focus: h.clone().add(f.clone().mulScalar(0.07)), position: h.clone().add(f.clone().mulScalar(0.85)).add(new pc.Vec3(0, 0.03, 0)), hand: new pc.Vec3(...hand) };
}
function setView(name) {
    const v = views[name];
    director.glide(v.focus, v.position);
    state.handTarget.copy(v.hand);
}

// ---- the visit: title card, opening, the torch handed over, and a drift when left alone ----
const hint = $('hint');
let hintTimer = 0;
/**
 * @param {string} text - A line to show above the controls.
 * @param {number} [seconds] - How long for; 0 leaves it up.
 */
function showHint(text, seconds = 0) {
    clearTimeout(hintTimer);
    if (text) hint.textContent = text;
    hint.classList.toggle('on', !!text);
    if (text && seconds) hintTimer = setTimeout(() => hint.classList.remove('on'), seconds * 1000);
}
const HOW = {
    mouse: 'Move to aim the torch · drag to look around · scroll to zoom',
    touch: 'Tap to aim the torch · drag to look around · pinch to zoom',
    tilt: 'Turn your phone to aim the torch · drag to look around · pinch to zoom'
};

const director = createDirector({
    app, camera, controls, state, aim, lightning, sound, wide: WIDE, minHeight: CAMERA_MIN_HEIGHT,
    onPhase: (phase, from) => {
        document.body.dataset.phase = phase;
        // how to hold the torch is said once, when it is first handed over
        if (phase === 'live' && from === 'opening') setTimeout(() => showHint(HOW[aim.mode], 8), 1200);
    }
});
if (query.has('idle')) director.settings.idleAfter = Number(query.get('idle'));
direct = director.update;

// ---- on-screen controls ----
function setRelighting(on) {
    relighting.enabled = on;
    $('relight').setAttribute('aria-pressed', String(on));
    showHint(on ? '' : 'The capture as it was shot, without the torch');
}
const toggleFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
document.querySelectorAll('button[data-view]').forEach((b) => {
    b.addEventListener('click', () => setView(/** @type {HTMLElement} */ (b).dataset.view));
});
$('relight').addEventListener('click', () => setRelighting(!relighting.enabled));
// a strike that is asked for lands close by: bright, and the crack follows within a second.
// (One left to chance may be a kilometre off, its thunder a dull rumble three seconds later.)
const strikeNear = () => lightning?.strike({ near: 0.8 + Math.random() * 0.2 });
$('strike').addEventListener('click', strikeNear);
$('strike').hidden = !lightning;
$('fullscreen').addEventListener('click', toggleFullscreen);
$('fullscreen').hidden = !document.fullscreenEnabled;
// a button that keeps the focus would take the next press of Space for itself
$('hud').addEventListener('click', () => /** @type {HTMLElement} */ (document.activeElement)?.blur());
window.addEventListener('keydown', (e) => {
    if (director.phase !== 'live' || e.repeat || e.target instanceof HTMLButtonElement) return;
    if (e.code === 'Space') setRelighting(!relighting.enabled);
    if (e.code === 'KeyL') strikeNear();
    if (e.code === 'KeyP') setPost(!post.enabled);
    if (e.code === 'KeyF' && document.fullscreenEnabled) toggleFullscreen();
});

if (query.has('debug')) {
    const el = document.getElementById('stats');
    let frames = 0, t0 = performance.now();
    app.on('frameend', () => {
        frames++;
        const t = performance.now();
        if (t - t0 >= 500) {
            el.textContent = `${(frames * 1000 / (t - t0)).toFixed(0)} fps\n${device.isWebGPU ? 'WebGPU' : 'WebGL2'} ${device.width}x${device.height}`;
            frames = 0; t0 = t;
        }
    });
}

// ---- the way in ----
if (query.get('intro') === '0') {
    title.dismiss(true);
    director.skip();
} else {
    // the card stays up until a few frames have been drawn behind it: the first ones build shaders
    // and sort the splats, and are slow
    await new Promise((resolve) => {
        let frames = 0;
        const done = () => {
            app.off('frameend', count);
            resolve();
        };
        const count = () => {
            if (++frames >= 12) done();
        };
        app.on('frameend', count);
        setTimeout(done, 3000);
    });
    title.ready(aim.touch ? 'Sound on · turn your phone to aim' : 'Best with sound', () => {
        // inside the click: sound may start, and an iPhone may be asked which way it is facing
        const audible = sound ? sound.start().catch(() => {}) : Promise.resolve();
        aim.enableTilt();
        title.dismiss();
        // the opening waits for the sound to be decoded, but not for long: the thunder is part of it
        Promise.race([audible, new Promise(resolve => setTimeout(resolve, 2500))]).then(() => director.begin());
    });
}

if (import.meta.env.DEV) {
    window.__sr = { pc, app, device, camera, controls, relighting, relightDepth, torch, stage, splat, proxy, caster, ground, state, aim, director, title, views, setView, setRelighting, showHint, toWorld, wet, rain, splashes, mist, lightning, sound, post, setPost };
}
