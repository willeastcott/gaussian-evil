// The ground: wet asphalt with standing puddles.
//
// A StandardMaterial, so it is lit and shadowed by the torch like anything else, with four of its
// shader chunks replaced by procedural ones that work from the world position:
//
//   - the lie of the ground is a few octaves of slow noise, with a shallow dip under the figures.
//     Water stands wherever the ground is below the water level: that is a puddle
//   - asphalt is two sizes of stone in dark binder: it sets the colour, how glossy each point is
//     and, through the noise's gradient, the normal, so the torch rakes across a rough surface
//   - a puddle is flat, nearly black, mirror-glossy and mostly see-through
//
// Wet ground is mostly what it mirrors, and that is worked out for every pixel:
//
//   - how much it mirrors goes by the angle it is seen at: almost nothing looking straight down
//     into it, nearly everything along the ground. The angle is taken to the surface as it lies
//     at that point, ripples and stones and all, so moving water shows as moving light
//   - what it mirrors is the sky where the mirrored line of sight meets it, and the sky is darkest
//     overhead and lighter towards the horizon. So water far off is lighter than water at your
//     feet, and a ripple, which tips the mirror, shows as a band of lighter or darker sky
//   - wet asphalt has a film of water on it, and mirrors too: less, and roughly, and most where a
//     stone's face catches it. Seen from low down it is not a black shape beside the water
//   - water deepens little by little. At its edge it is a film with the stones standing out of
//     it, so the waterline follows the stones and is never a clean curve
//   - ripples too small to see from where the camera is are left out of the surface, where they
//     would only flicker, and blur what the water mirrors instead
//   - the lamp behind the pair (src/lamp.js) is mirrored as well. It is a small bright thing, and
//     wet ground is not quite a mirror: every ripple and every stone tips its own bit of surface,
//     so the lamp's image is drawn out into a streak towards whoever is looking. On still water
//     it is short and bright, on rough wet asphalt long and faint
//
// See-through is what makes the reflection. The reflected figures (src/wet-floor.js) are drawn
// first, on a layer under this one; the ground is drawn over them, opaque where it is asphalt and
// thin where it is water; the real figures are drawn last. So the reflection shows in the puddles
// and nowhere else, with the puddle's own outline, per pixel.
//
// Detail finer than a pixel is faded out by distance, otherwise the stones shimmer as you orbit.
import * as pc from 'playcanvas';

// The lie of the ground, and so where the puddles are. Exported because the rain's splashes
// (src/splash.js) need to know whether a drop landed in water.
export const GROUND_LIE_GLSL = /* glsl */`
uniform vec4 uGroundPuddle;     // water level, opacity of standing water, radius (m) and depth of the dip under the figures

float groundHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// value noise: x is the value (0..1), yz its gradient
vec3 groundNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
    float a = groundHash(i), b = groundHash(i + vec2(1.0, 0.0)), c = groundHash(i + vec2(0.0, 1.0)), d = groundHash(i + vec2(1.0, 1.0));
    float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
    return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}

// x: the height of the ground at p (0..1; water stands where it is below uGroundPuddle.x);
// y: its finest octave, reused for tone
vec2 groundLie(vec2 p) {
    float n0 = groundNoise(p * 0.55 + 3.7).x;
    float n1 = groundNoise(p * 1.3 - 8.1).x;
    float n2 = groundNoise(p * 3.1 + 1.9).x;
    float lie = n0 * 0.6 + n1 * 0.28 + n2 * 0.12;
    lie -= uGroundPuddle.w * exp(-dot(p, p) / (2.0 * uGroundPuddle.z * uGroundPuddle.z));
    return vec2(lie, n2);
}
`;

const COMMON_GLSL = /* glsl */`
uniform vec3 uGroundEye;
uniform vec3 uGroundSky;        // the sky that wet ground mirrors: dark, but for lightning
uniform float uGroundTime;
uniform vec4 uGroundStone;      // fine stones per metre, coarse stones per metre, height of the relief (m), ripple slope
uniform vec4 uGroundLamp;       // where the lamp is, and how strongly its image shows: 0 for no lamp
uniform vec3 uGroundLampGlow;   // the brightest that image gets, by colour

float gPuddle;      // 0 dry .. 1 standing water, deep enough to lie flat
float gDamp;        // 1 where the asphalt is soaked, around a puddle
float gGrain;       // 0 binder .. 1 stone
float gTone;        // slow variation in how dark the surface is
float gBlur;        // 0 .. 1: how much of the water's ripple is too fine to see from here
vec3 gMirror;       // the sky, as this point mirrors it
vec3 gNormal;

void groundEval() {
    vec2 p = vPositionW.xz;
    vec3 toEye = uGroundEye - vPositionW;
    float dist = length(toEye);
    vec3 view = toEye / dist;
    // the size of a pixel on the ground (m), averaged over its long and short sides
    float pixel = dist * 0.0005 * sqrt(dist / max(toEye.y, 0.02));

    vec2 lay = groundLie(p);
    gTone = 0.75 + 0.5 * lay.y;

    // the stones
    float fine = 1.0 - smoothstep(0.3, 1.0, pixel * uGroundStone.x);
    float coarse = 1.0 - smoothstep(0.3, 1.0, pixel * uGroundStone.y);
    vec3 s0 = groundNoise(p * uGroundStone.x);
    vec3 s1 = groundNoise(p * uGroundStone.y + 17.3);
    gGrain = mix(0.5, s0.x, fine) * 0.45 + mix(0.5, s1.x, coarse) * 0.55;
    vec2 stones = (s0.yz * (uGroundStone.x * 0.4 * fine) + s1.yz * (uGroundStone.y * 0.6 * coarse)) * uGroundStone.z;

    // The shore. Depth is in the units of the lie of the ground: 0.03 of it is some five
    // centimetres of shore. The stones stand out of the shallowest water, so they shift the
    // waterline, each by its own height.
    float depth = uGroundPuddle.x - lay.x + (0.5 - gGrain) * 0.014;
    float soft = 0.004 + pixel * 0.6;
    gPuddle = smoothstep(-soft, 0.03 + soft, depth);
    gDamp = 1.0 - smoothstep(0.0, 0.07, -depth);

    // rain keeps the water moving: two sizes of ripple, sliding past each other. Each is left
    // out as it gets too small to see, and counted as blur
    float seen0 = 1.0 - smoothstep(0.2, 0.8, pixel * 5.0);
    float seen1 = 1.0 - smoothstep(0.2, 0.8, pixel * 11.0);
    vec3 r0 = groundNoise(p * 5.0 + vec2(0.35, 0.22) * uGroundTime);
    vec3 r1 = groundNoise(p * 11.0 - vec2(0.5, -0.3) * uGroundTime);
    vec2 ripple = (r0.yz * seen0 + r1.yz * (0.6 * seen1)) * uGroundStone.w;
    gBlur = 1.0 - (seen0 + 0.6 * seen1) / 1.6;

    vec2 slope = mix(stones, ripple, gPuddle);
    gNormal = normalize(vec3(-slope.x, 1.0, -slope.y));

    // how much is mirrored, by the angle to the surface as it lies here
    float facing = clamp(dot(gNormal, view), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
    // what is mirrored: the sky, where the mirrored line of sight meets it
    float up = clamp(reflect(-view, gNormal).y, 0.0, 1.0);
    vec3 sky = uGroundSky * mix(1.7, 0.55, smoothstep(0.0, 0.45, up));
    // water mirrors it whole; the film on wet asphalt a part of it, more where it is soaked and
    // on the face of a stone
    float film = mix(0.1, 0.3, gDamp) * (0.55 + 0.9 * gGrain);
    gMirror = sky * (fresnel * mix(film, 1.0, gPuddle));

    // The lamp, mirrored. How far its image is drawn out goes by how rough the surface is:
    // water in the rain a good way (it is never still), more where its ripples are too fine to
    // see, and the film on asphalt further again. The rougher, the more thinly the light is spread.
    vec3 toLamp = uGroundLamp.xyz - vPositionW;
    float reach = dot(toLamp, toLamp);
    vec3 between = normalize(toLamp / sqrt(reach) + view);
    float rough = mix(mix(0.22, 0.15, gDamp), mix(0.075, 0.13, gBlur), gPuddle);
    float r2 = rough * rough;
    float tip = clamp(dot(gNormal, between), 0.0, 1.0);
    float lobe = r2 / (tip * tip * (r2 - 1.0) + 1.0);
    float spread = uGroundLamp.w / (reach * 3.1416 * r2);
    float glance = 0.02 + 0.98 * pow(1.0 - clamp(dot(view, between), 0.0, 1.0), 5.0);
    // A lamp is far brighter than anything it lights, and brighter than a screen can show. So
    // its image is still as bright as the lamp looks when it is spread a little, and only fades
    // when it is spread a lot: the spreading is weighed up first, and the cap put on after.
    float image = lobe * lobe * spread * glance * mix(0.35 + 0.65 * gDamp, 1.0, gPuddle);
    gMirror += uGroundLampGlow * (1.0 - exp(-image));
}
`;

const OPACITY_GLSL = /* glsl */`
#ifdef FORWARD_PASS
${GROUND_LIE_GLSL}
${COMMON_GLSL}
void getOpacity() {
    groundEval();
    dAlpha = mix(1.0, uGroundPuddle.y, gPuddle);
}
#else
void getOpacity() {
    dAlpha = 1.0;
}
#endif
`;

const DIFFUSE_GLSL = /* glsl */`
void getAlbedo() {
    // dark binder and paler stones; darker where it is soaked, and the bed of a puddle darker still
    float tone = mix(0.018, 0.085, gGrain * gGrain) * gTone;
    tone *= mix(1.0, 0.55, gDamp) * mix(1.0, 0.5, gPuddle);
    dAlbedo = vec3(0.93, 0.97, 1.0) * tone;
}
`;

const NORMAL_GLSL = /* glsl */`
void getNormal() {
    dNormalW = gNormal;
}
`;

const GLOSS_GLSL = /* glsl */`
void getGlossiness() {
    dGlossiness = mix(mix(0.38, 0.6, gGrain), 0.72, gDamp);
    // still water is a mirror; ripples too fine to see blur it
    dGlossiness = mix(dGlossiness, mix(0.97, 0.84, gBlur), gPuddle);
}
`;

export const GROUND_LIE_WGSL = /* wgsl */`
uniform uGroundPuddle: vec4f;     // water level, opacity of standing water, radius (m) and depth of the dip under the figures

fn groundHash(p: vec2f) -> f32 {
    var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// value noise: x is the value (0..1), yz its gradient
fn groundNoise(p: vec2f) -> vec3f {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let du = 6.0 * f * (1.0 - f);
    let a = groundHash(i);
    let b = groundHash(i + vec2f(1.0, 0.0));
    let c = groundHash(i + vec2f(0.0, 1.0));
    let d = groundHash(i + vec2f(1.0, 1.0));
    let k1 = b - a;
    let k2 = c - a;
    let k4 = a - b - c + d;
    return vec3f(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2f(k1 + k4 * u.y, k2 + k4 * u.x));
}

// x: the height of the ground at p (0..1; water stands where it is below uGroundPuddle.x);
// y: its finest octave, reused for tone
fn groundLie(p: vec2f) -> vec2f {
    let puddle = uniform.uGroundPuddle;
    let n0 = groundNoise(p * 0.55 + 3.7).x;
    let n1 = groundNoise(p * 1.3 - 8.1).x;
    let n2 = groundNoise(p * 3.1 + 1.9).x;
    var lie = n0 * 0.6 + n1 * 0.28 + n2 * 0.12;
    lie = lie - puddle.w * exp(-dot(p, p) / (2.0 * puddle.z * puddle.z));
    return vec2f(lie, n2);
}
`;

const EMISSIVE_GLSL = /* glsl */`
void getEmission() {
    // water is thin (see getOpacity), so what it mirrors is scaled up to survive the blend
    dEmission = gMirror / max(dAlpha, 0.05);
}
`;

const COMMON_WGSL = /* wgsl */`
uniform uGroundEye: vec3f;
uniform uGroundSky: vec3f;        // the sky that wet ground mirrors: dark, but for lightning
uniform uGroundTime: f32;
uniform uGroundStone: vec4f;      // fine stones per metre, coarse stones per metre, height of the relief (m), ripple slope
uniform uGroundLamp: vec4f;       // where the lamp is, and how strongly its image shows: 0 for no lamp
uniform uGroundLampGlow: vec3f;   // the brightest that image gets, by colour

var<private> gPuddle: f32;      // 0 dry .. 1 standing water, deep enough to lie flat
var<private> gDamp: f32;        // 1 where the asphalt is soaked, around a puddle
var<private> gGrain: f32;       // 0 binder .. 1 stone
var<private> gTone: f32;        // slow variation in how dark the surface is
var<private> gBlur: f32;        // 0 .. 1: how much of the water's ripple is too fine to see from here
var<private> gMirror: vec3f;    // the sky, as this point mirrors it
var<private> gNormal: vec3f;

fn groundEval() {
    let p = vPositionW.xz;
    let toEye = uniform.uGroundEye - vPositionW;
    let dist = length(toEye);
    let view = toEye / dist;
    // the size of a pixel on the ground (m), averaged over its long and short sides
    let pixel = dist * 0.0005 * sqrt(dist / max(toEye.y, 0.02));
    let puddle = uniform.uGroundPuddle;
    let stone = uniform.uGroundStone;

    let lay = groundLie(p);
    gTone = 0.75 + 0.5 * lay.y;

    // the stones
    let fine = 1.0 - smoothstep(0.3, 1.0, pixel * stone.x);
    let coarse = 1.0 - smoothstep(0.3, 1.0, pixel * stone.y);
    let s0 = groundNoise(p * stone.x);
    let s1 = groundNoise(p * stone.y + 17.3);
    gGrain = mix(0.5, s0.x, fine) * 0.45 + mix(0.5, s1.x, coarse) * 0.55;
    let stones = (s0.yz * (stone.x * 0.4 * fine) + s1.yz * (stone.y * 0.6 * coarse)) * stone.z;

    // The shore. Depth is in the units of the lie of the ground: 0.03 of it is some five
    // centimetres of shore. The stones stand out of the shallowest water, so they shift the
    // waterline, each by its own height.
    let depth = puddle.x - lay.x + (0.5 - gGrain) * 0.014;
    let soft = 0.004 + pixel * 0.6;
    gPuddle = smoothstep(-soft, 0.03 + soft, depth);
    gDamp = 1.0 - smoothstep(0.0, 0.07, -depth);

    // rain keeps the water moving: two sizes of ripple, sliding past each other. Each is left
    // out as it gets too small to see, and counted as blur
    let seen0 = 1.0 - smoothstep(0.2, 0.8, pixel * 5.0);
    let seen1 = 1.0 - smoothstep(0.2, 0.8, pixel * 11.0);
    let r0 = groundNoise(p * 5.0 + vec2f(0.35, 0.22) * uniform.uGroundTime);
    let r1 = groundNoise(p * 11.0 - vec2f(0.5, -0.3) * uniform.uGroundTime);
    let ripple = (r0.yz * seen0 + r1.yz * (0.6 * seen1)) * stone.w;
    gBlur = 1.0 - (seen0 + 0.6 * seen1) / 1.6;

    let slope = mix(stones, ripple, gPuddle);
    gNormal = normalize(vec3f(-slope.x, 1.0, -slope.y));

    // how much is mirrored, by the angle to the surface as it lies here
    let facing = clamp(dot(gNormal, view), 0.0, 1.0);
    let fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
    // what is mirrored: the sky, where the mirrored line of sight meets it
    let up = clamp(reflect(-view, gNormal).y, 0.0, 1.0);
    let sky = uniform.uGroundSky * mix(1.7, 0.55, smoothstep(0.0, 0.45, up));
    // water mirrors it whole; the film on wet asphalt a part of it, more where it is soaked and
    // on the face of a stone
    let film = mix(0.1, 0.3, gDamp) * (0.55 + 0.9 * gGrain);
    gMirror = sky * (fresnel * mix(film, 1.0, gPuddle));

    // The lamp, mirrored. How far its image is drawn out goes by how rough the surface is:
    // water in the rain a good way (it is never still), more where its ripples are too fine to
    // see, and the film on asphalt further again. The rougher, the more thinly the light is spread.
    let toLamp = uniform.uGroundLamp.xyz - vPositionW;
    let reach = dot(toLamp, toLamp);
    let between = normalize(toLamp / sqrt(reach) + view);
    let rough = mix(mix(0.22, 0.15, gDamp), mix(0.075, 0.13, gBlur), gPuddle);
    let r2 = rough * rough;
    let tip = clamp(dot(gNormal, between), 0.0, 1.0);
    let lobe = r2 / (tip * tip * (r2 - 1.0) + 1.0);
    let spread = uniform.uGroundLamp.w / (reach * 3.1416 * r2);
    let glance = 0.02 + 0.98 * pow(1.0 - clamp(dot(view, between), 0.0, 1.0), 5.0);
    // A lamp is far brighter than anything it lights, and brighter than a screen can show. So
    // its image is still as bright as the lamp looks when it is spread a little, and only fades
    // when it is spread a lot: the spreading is weighed up first, and the cap put on after.
    let image = lobe * lobe * spread * glance * mix(0.35 + 0.65 * gDamp, 1.0, gPuddle);
    gMirror = gMirror + uniform.uGroundLampGlow * (1.0 - exp(-image));
}
`;

const OPACITY_WGSL = /* wgsl */`
#ifdef FORWARD_PASS
${GROUND_LIE_WGSL}
${COMMON_WGSL}
fn getOpacity() {
    groundEval();
    dAlpha = mix(1.0, uniform.uGroundPuddle.y, gPuddle);
}
#else
fn getOpacity() {
    dAlpha = 1.0;
}
#endif
`;

const DIFFUSE_WGSL = /* wgsl */`
fn getAlbedo() {
    // dark binder and paler stones; darker where it is soaked, and the bed of a puddle darker still
    var tone = mix(0.018, 0.085, gGrain * gGrain) * gTone;
    tone = tone * mix(1.0, 0.55, gDamp) * mix(1.0, 0.5, gPuddle);
    dAlbedo = vec3f(0.93, 0.97, 1.0) * tone;
}
`;

const NORMAL_WGSL = /* wgsl */`
fn getNormal() {
    dNormalW = gNormal;
}
`;

const GLOSS_WGSL = /* wgsl */`
fn getGlossiness() {
    dGlossiness = mix(mix(0.38, 0.6, gGrain), 0.72, gDamp);
    // still water is a mirror; ripples too fine to see blur it
    dGlossiness = mix(dGlossiness, mix(0.97, 0.84, gBlur), gPuddle);
}
`;

const EMISSIVE_WGSL = /* wgsl */`
fn getEmission() {
    // water is thin (see getOpacity), so what it mirrors is scaled up to survive the blend
    dEmission = gMirror / max(dAlpha, 0.05);
}
`;

/**
 * @param {object} o - What the ground needs.
 * @param {pc.AppBase} o.app - The app.
 * @param {pc.Entity} o.camera - Main camera.
 * @param {pc.Layer} o.layer - The layer to draw it on: after the reflection, before the world.
 * @returns {object} Settings, the entity and its material.
 */
export function createGround({ app, camera, layer }) {
    const settings = {
        waterLevel: 0.45,       // of the ground's 0..1 lie: higher floods more of it
        waterOpacity: 0.22,     // how much standing water hides what is reflected in it
        dipRadius: 1.5,         // metres: a shallow dip under the figures, so they stand in a puddle
        dipDepth: 0.2,
        fineStones: 130,        // per metre
        coarseStones: 48,
        relief: 0.004,          // metres
        ripple: 0.045,          // slope of the water's surface
        sky: [0, 0, 0],         // what the wet ground mirrors, overhead; src/lightning.js sets it
        // the lamp it mirrors: where it is, how strongly its image shows, and the brightest that gets, by colour. src/lamp.js sets it
        lamp: { position: [0, 10, 0], strength: 0, glow: [0, 0, 0] }
    };

    const material = new pc.StandardMaterial();
    material.useMetalness = true;
    material.metalness = 0;
    material.blendType = pc.BLEND_NORMAL;
    material.opacityFadesSpecular = false;      // a highlight on water is not see-through
    material.depthWrite = false;
    material.shaderChunksVersion = '2.24';
    const glsl = material.getShaderChunks(pc.SHADERLANGUAGE_GLSL);
    glsl.set('opacityPS', OPACITY_GLSL);
    glsl.set('diffusePS', DIFFUSE_GLSL);
    glsl.set('normalMapPS', NORMAL_GLSL);
    glsl.set('glossPS', GLOSS_GLSL);
    glsl.set('emissivePS', EMISSIVE_GLSL);
    const wgsl = material.getShaderChunks(pc.SHADERLANGUAGE_WGSL);
    wgsl.set('opacityPS', OPACITY_WGSL);
    wgsl.set('diffusePS', DIFFUSE_WGSL);
    wgsl.set('normalMapPS', NORMAL_WGSL);
    wgsl.set('glossPS', GLOSS_WGSL);
    wgsl.set('emissivePS', EMISSIVE_WGSL);
    material.update();

    const entity = new pc.Entity('ground');
    entity.addComponent('render', { type: 'plane', material, layers: [layer.id], castShadows: false, receiveShadows: true });
    entity.setLocalScale(40, 1, 40);
    app.root.addChild(entity);

    let time = 0;
    app.on('update', (dt) => {
        time += dt;
        const eye = camera.getPosition();
        material.setParameter('uGroundEye', [eye.x, eye.y, eye.z]);
        material.setParameter('uGroundTime', time);
        material.setParameter('uGroundPuddle', [settings.waterLevel, settings.waterOpacity, settings.dipRadius, settings.dipDepth]);
        material.setParameter('uGroundSky', settings.sky);
        material.setParameter('uGroundStone', [settings.fineStones, settings.coarseStones, settings.relief, settings.ripple]);
        material.setParameter('uGroundLamp', [...settings.lamp.position, settings.lamp.strength]);
        material.setParameter('uGroundLampGlow', settings.lamp.glow);
    });

    return { settings, entity, material };
}
