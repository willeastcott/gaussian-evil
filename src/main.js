// gaussian-evil: a Gaussian splat capture relit in real time by a hand-held torch.
//
// The splats carry their capture lighting baked in. To relight them, a proxy mesh baked from the
// same splats (tools/bake-proxy.mjs) is lit by ordinary engine lights and rendered to an offscreen
// texture by the engine's GSplatRelighting script; every splat fragment is then tinted by the
// lighting at its own pixel. The same spot light also lights the ground, and a slimmer copy of
// the proxy mesh casts the figures' shadows, on them and onto the ground.
//
// Query: ?device=webgl2|webgpu  ?proxy=1 (draw the envelope that receives light over the splats)  ?proxy=2 (draw the surface that casts the shadows)  ?debug (stats)  ?contact=0 (the ground without what the figures hide from it)
//        ?wet=0 (no reflection, and no life motion)  ?rain=0  ?splash=0  ?lightning=0  ?sound=0  ?post=0  ?life=0 (the figures as captured)
//        ?intro=0 (no title card and no opening: straight to the torch)  ?idle=N (seconds before the scene drifts by itself; 0 for never)  ?mist=0
//        ?lamp=0 (no lamp behind them)  ?spray=0 (no rain bursting off the two of them)
//        ?demo (no title card: the scene plays by itself, as a film, until somebody clicks)  ?demo=0 (Enter hands the torch over after a short opening, with no film)
import * as pc from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { GSplatRelighting } from 'playcanvas/scripts/esm/gsplat/gsplat-relighting.mjs';

import { createAim } from './aim.js';
import { createSoundscape } from './audio.js';
import { createDemo } from './demo.js';
import { createDirector } from './director.js';
import { createGround } from './ground.js';
import { createLamp } from './lamp.js';
import { createLightning } from './lightning.js';
import { createMist } from './mist.js';
import { createPost } from './post.js';
import { createRain } from './rain.js';
import { createDepthAwareRelighting } from './relight-depth.js';
import { createSplashes } from './splash.js';
import { createSpray } from './spray.js';
import { createCasterEntity, createGrownMesh, wrapLight } from './shadow-caster.js';
import { createContact } from './contact.js';
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
//
// While the film plays, the picture is letterboxed: two black bars (index.html) leave a band the
// shape of a cinema screen. The lens widens to match, so that the band takes in, top to bottom,
// what the whole screen did: the bars add picture at the sides, they do not crop it. When the
// torch is taken the bars slide away and the lens closes in again, and the picture grows to fill
// the screen. A screen held upright has no bars: there is no width to spare.
const BAND = 2.39;              // how wide the band is for its height
const BAR_MOST = 0.13;          // the most of the screen's height that one bar takes
const BARS_TAKE = 0.9;          // seconds they take to slide in or out
let bars = 1;                   // 0 out .. 1 in: the page opens on the title card, behind which they are in
const barShare = () => {
    const w = canvas.clientWidth, h = Math.max(canvas.clientHeight, 1);
    return w <= h || document.body.classList.contains('capturing') ? 0 : pc.math.clamp((1 - w / h / BAND) / 2, 0, BAR_MOST);
};
const frameLens = () => {
    const across = Math.tan(FOV_ACROSS * 0.5 * pc.math.DEG_TO_RAD) * canvas.clientHeight / Math.max(canvas.clientWidth, 1);
    const fov = pc.math.clamp(2 * Math.atan(across) * pc.math.RAD_TO_DEG, FOV, FOV_TALLEST);
    const share = barShare();
    camera.camera.fov = 2 * Math.atan(Math.tan(fov * 0.5 * pc.math.DEG_TO_RAD) / (1 - 2 * share * bars)) * pc.math.RAD_TO_DEG;
    document.documentElement.style.setProperty('--bar', `${(share * canvas.clientHeight).toFixed(1)}px`);
    document.documentElement.style.setProperty('--bars', bars.toFixed(4));
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
    reach: 0,                              // metres to what it lights, when a script says so; 0: as far as the camera's subject
    snap: false,                           // set to put the beam on its mark at once: after a cut
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
    const depth = state.reach || tmpA.sub2(controls.focusPoint, eye).dot(camera.forward);
    const r = canvas.getBoundingClientRect();
    camera.camera.screenToWorld(state.pointer.x * r.width, state.pointer.y * r.height, Math.max(0.3, depth), tmpB);
    // (the beam follows its mark as a hand would; after a cut it is simply there)
    state.aim.lerp(state.aim, tmpB, state.snap ? 1 : 1 - Math.exp(-state.smoothing * dt));
    state.hand.lerp(state.hand, state.handTarget, state.snap ? 1 : 1 - Math.exp(-4 * dt));
    state.snap = false;

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
const rain = query.get('rain') === '0' ? null : createRain({ app, camera, torch, aim: state.aim, relighting });
const splashes = !rain || query.get('splash') === '0' ? null : createSplashes({ app, camera, rain, ground, ringLayer });
// ---- and where it lands on the two of them (src/spray.js) ----
const spray = !rain || query.get('spray') === '0' ? null : createSpray({ app, camera, rain, mesh: surfaceMesh, transform: stage.getWorldTransform() });
// ---- a low mist over the ground, shown up by the torch and by lightning (src/mist.js) ----
const mist = !rain || query.get('mist') === '0' ? null : createMist({ app, rain, relighting });

// ---- lightning: now and then, light from somewhere else in the sky (L fires one) ----
const lightning = query.get('lightning') === '0' ? null : createLightning({
    app, camera, ground, rain,
    layers: [relightLayer.id, casterLayer.id, groundLayer.id, pc.LAYERID_WORLD],
    mirrorLayers: wet ? [wet.mirrorLayer.id, wet.mirrorCasterLayer.id] : null
});

// ---- a lamp behind them, always on ----
const lamp = query.get('lamp') === '0' ? null : createLamp({
    app, rain, ground,
    layers: [relightLayer.id, casterLayer.id, groundLayer.id, pc.LAYERID_WORLD],
    mirrorLayers: wet ? [wet.mirrorLayer.id] : null,
    camera, glowLayer: ringLayer
});

// ---- what the two of them hide from the ground they stand on (src/contact.js) ----
const contact = query.get('contact') === '0' ? null : createContact({
    device, mesh: surfaceMesh, transform: stage.getWorldTransform(), ground, lamp: lamp?.head ?? null
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
const subjects = {};        // the two of them, in world space: for the demo's close-ups
for (const [name, { head, facing, hand }] of Object.entries(HEADS)) {
    const h = toWorld(head), f = dirToWorld(facing);
    subjects[name] = { head: h, facing: f, hand: new pc.Vec3(...hand) };
    views[name] = { focus: h.clone().add(f.clone().mulScalar(0.07)), position: h.clone().add(f.clone().mulScalar(0.85)).add(new pc.Vec3(0, 0.03, 0)), hand: new pc.Vec3(...hand) };
}
function setView(name) {
    const v = views[name];
    director.glide(v.focus, v.position);
    state.handTarget.copy(v.hand);
}

// ---- the visit: title card, opening, the torch handed over, a drift when left alone, and a
// film that the scene plays by itself (src/demo.js) ----
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

const demo = createDemo({ wide: WIDE, him: subjects.him, her: subjects.her });
const invite = () => showHint(aim.touch ? 'Tap to take the torch' : 'Click to take the torch', 3);
let told = false;
let demoBegan = 0;

const director = createDirector({
    app, camera, controls, state, aim, lightning, sound, demo, wide: WIDE, minHeight: CAMERA_MIN_HEIGHT,
    onPhase: (phase, from) => {
        document.body.dataset.phase = phase;
        // the film is of the torch: it does not play over the capture as it was shot
        if (phase === 'demo') {
            setRelighting(true);
            demoBegan = performance.now();
        }
        if (from === 'demo') showHint('');
        if (phase !== 'live') setInfo(false);
        // how to hold the torch is said once, when it is first handed over
        if (phase === 'live' && !told && (from === 'opening' || from === 'demo')) {
            told = true;
            setTimeout(() => director.phase === 'live' && showHint(HOW[aim.mode], 8), 1200);
        }
    },
    onInvite: invite
});

// While the film plays for somebody who asked for it, there is no pointer on it and moving the
// mouse changes nothing. But it does bring the pointer back, and with it how to take over.
// (Not in the first moments: the mouse is still on its way from the button.)
let nudged = 0;
canvas.addEventListener('pointermove', (e) => {
    if (director.phase !== 'demo' || director.byItself || e.pointerType === 'touch' || performance.now() - demoBegan < 2000) return;
    invite();
    document.body.classList.add('nudged');
    clearTimeout(nudged);
    nudged = setTimeout(() => document.body.classList.remove('nudged'), 3000);
});
if (query.has('idle')) director.settings.idleAfter = Number(query.get('idle'));
direct = director.update;

// the bars are in while the script has the picture, and out while the visitor does. (By the
// clock on the wall, not the scene's: they are part of the page.)
let barsAt = 1, barsThen = performance.now();
const setBars = (at) => {
    barsAt = at;
    bars = at * at * (3 - 2 * at);
    frameLens();
};
app.on('update', () => {
    const now = performance.now(), dt = Math.min(0.1, (now - barsThen) / 1000);
    barsThen = now;
    const want = ['title', 'opening', 'demo'].includes(director.phase) ? 1 : 0;
    if (barsAt !== want) setBars(want > barsAt ? Math.min(1, barsAt + dt / BARS_TAKE) : Math.max(0, barsAt - dt / BARS_TAKE));
});

// ---- the panel that says how it is done ----
const info = $('info');
function setInfo(open) {
    if (info.classList.contains('open') === open) return;
    info.classList.toggle('open', open);
    info.inert = !open;
    $('about').setAttribute('aria-expanded', String(open));
    // nobody who is reading wants the scene to wander off, or the controls to fade
    director.settings.hold = open;
    if (open) {
        info.scrollTop = 0;
        $('info-close').focus({ preventScroll: true });
    } else {
        // (a button that keeps the focus would take the next press of Space for itself)
        /** @type {HTMLElement} */ (document.activeElement)?.blur();
    }
}
$('about').addEventListener('click', () => setInfo(true));
$('info-close').addEventListener('click', () => setInfo(false));

// ---- on-screen controls ----
function setRelighting(on) {
    relighting.enabled = on;
    $('relight').setAttribute('aria-pressed', String(on));
    showHint(on ? '' : 'The capture as it was shot, without the torch');
}
// Full screen is offered only where the browser can do it: an iPhone cannot, nor can a page in a
// frame that has not been allowed to. And a browser that says it can and then will not (some
// embedded ones) is taken at its deed: the button goes the first time it is refused.
const canFullscreen = () => document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === 'function';
let fullscreenRefused = false;
const toggleFullscreen = () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (!canFullscreen() || fullscreenRefused) return undefined;
    return document.documentElement.requestFullscreen().catch(() => {
        fullscreenRefused = true;
        $('fullscreen').hidden = true;
    });
};
document.querySelectorAll('button[data-view]').forEach((b) => {
    b.addEventListener('click', () => setView(/** @type {HTMLElement} */ (b).dataset.view));
});
$('relight').addEventListener('click', () => setRelighting(!relighting.enabled));
// a strike that is asked for lands close by: bright, and the crack follows within a second.
// (One left to chance may be a kilometre off, its thunder a dull rumble three seconds later.)
const strikeNear = () => lightning?.strike({ near: 0.8 + Math.random() * 0.2 });
$('strike').addEventListener('click', strikeNear);
$('strike').hidden = !lightning;
$('play').addEventListener('click', () => director.watch());
$('fullscreen').addEventListener('click', toggleFullscreen);
$('fullscreen').hidden = !canFullscreen();
// a button that keeps the focus would take the next press of Space for itself
// (but not the one that opens the panel: the focus has gone to the panel's own button)
$('hud').addEventListener('click', () => info.classList.contains('open') || /** @type {HTMLElement} */ (document.activeElement)?.blur());
window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && info.classList.contains('open')) {
        setInfo(false);
        return;
    }
    if (e.repeat || e.target instanceof HTMLButtonElement) return;
    const phase = director.phase;
    // (the film is worth the whole screen, so F works while it plays)
    if (e.code === 'KeyF' && (phase === 'live' || phase === 'demo') && canFullscreen()) toggleFullscreen();
    if (phase !== 'live') return;
    if (e.code === 'Space') setRelighting(!relighting.enabled);
    if (e.code === 'KeyL') strikeNear();
    if (e.code === 'KeyP') setPost(!post.enabled);
    if (e.code === 'KeyD') director.watch();
    if (e.code === 'KeyI') setInfo(!info.classList.contains('open'));
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
if (query.has('demo') && query.get('demo') !== '0') {
    // nobody has clicked anything, so there is no sound until somebody does
    title.dismiss(true);
    director.watch();
} else if (query.get('intro') === '0') {
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
    // Enter plays the film: the scene shows what it can do before it asks anything of the
    // visitor. A click or a tap at any moment takes the torch, and a line says so once the torch
    // is on. (?demo=0 is the older way in: a short opening, and the torch is handed over.)
    const film = query.get('demo') !== '0';
    title.ready(aim.touch ? 'Sound on · tap to take the torch' : 'Best with sound · click to take the torch', () => {
        // inside the click: sound may start, and an iPhone may be asked which way it is facing
        sound?.start().catch(() => {});
        aim.enableTilt();
        // everything but the name leaves the card at once: the click has been heard
        title.speak();
        // The boom and the voice are decoded first, and that, with the machine's sound output
        // opening (a few tenths of a second on some), is all this waits for: a moment.
        // (The rain and the thunder are ready long before the voice has finished.)
        Promise.race([sound ? sound.primed : Promise.resolve(), new Promise(resolve => setTimeout(resolve, 2500))]).then(() => {
            // One ominous boom, and then the name is said aloud over the title, as the series says
            // its own on its title screen. The card stays up until the last word is nearly out.
            // (With no sound, it goes at once.)
            const lead = sound?.hit() ?? 0;
            setTimeout(() => {
                const said = sound?.announce() ?? 0;
                setTimeout(() => {
                    title.dismiss();
                    if (!film) return director.begin();
                    director.watch();
                    setTimeout(() => director.phase === 'demo' && invite(), (demo.torchOn + 2.5) * 1000);
                }, Math.max(0, said - 0.3) * 1000);
            }, lead * 1000);
        });
    });
}

// straight to the torch, there were never any bars
if (director.phase === 'live') setBars(0);

if (import.meta.env.DEV) {
    // rendering the film to a video file (src/capture.js): __sr.capture.run()
    const { createCapture } = await import('./capture.js');
    const capture = createCapture({ pc, app, director, demo, sound, relens: frameLens });
    window.__sr = { capture, contact, lamp, spray, pc, app, device, camera, controls, relighting, relightDepth, torch, stage, splat, proxy, caster, ground, state, aim, director, title, demo, subjects, views, setView, setRelighting, showHint, toWorld, wet, rain, splashes, mist, lightning, sound, post, setPost };
}
