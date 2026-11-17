// The ground: wet asphalt with standing puddles.
//
// A StandardMaterial, so it is lit and shadowed by the torch like anything else, with four of its
// shader chunks replaced by procedural ones that work from the world position:
//
//   - the lie of the ground is a few octaves of slow noise, with a shallow dip under the figures.
//     Water stands wherever the ground is below the water level: that is a puddle
//   - asphalt is two sizes of stone in dark binder: it sets the colour, how glossy each point is
//     and, through the noise's gradient, the normal, so the torch rakes across a rough surface
//   - a puddle is flat, nearly black, mirror-glossy and mostly see-through. It mirrors the sky,
//     which is black until lightning lights it
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
uniform vec3 uGroundSky;        // the sky the puddles mirror: black, but for lightning
uniform float uGroundTime;
uniform vec4 uGroundStone;      // fine stones per metre, coarse stones per metre, height of the relief (m), ripple slope

float gPuddle;      // 1 in standing water
float gDamp;        // 1 where the asphalt is soaked, around a puddle
float gGrain;       // 0 binder .. 1 stone
float gTone;        // slow variation in how dark the surface is
float gMirror;      // how much of the sky water reflects at this angle
vec3 gNormal;

void groundEval() {
    vec2 p = vPositionW.xz;
    vec3 toEye = uGroundEye - vPositionW;
    float dist = length(toEye);
    gMirror = 0.04 + 0.96 * pow(1.0 - clamp(toEye.y / dist, 0.0, 1.0), 5.0);
    // the size of a pixel on the ground (m), averaged over its long and short sides
    float pixel = dist * 0.0005 * sqrt(dist / max(toEye.y, 0.02));

    vec2 lay = groundLie(p);
    float lie = lay.x;
    float soft = 0.006 + pixel * 0.6;
    gPuddle = 1.0 - smoothstep(uGroundPuddle.x - soft, uGroundPuddle.x + soft, lie);
    gDamp = 1.0 - smoothstep(uGroundPuddle.x, uGroundPuddle.x + 0.07, lie);
    gTone = 0.75 + 0.5 * lay.y;

    // the stones
    float fine = 1.0 - smoothstep(0.3, 1.0, pixel * uGroundStone.x);
    float coarse = 1.0 - smoothstep(0.3, 1.0, pixel * uGroundStone.y);
    vec3 s0 = groundNoise(p * uGroundStone.x);
    vec3 s1 = groundNoise(p * uGroundStone.y + 17.3);
    gGrain = mix(0.5, s0.x, fine) * 0.45 + mix(0.5, s1.x, coarse) * 0.55;
    vec2 slope = (s0.yz * (uGroundStone.x * 0.4 * fine) + s1.yz * (uGroundStone.y * 0.6 * coarse)) * uGroundStone.z;

    // water lies flat, but for the rain keeping its surface moving
    vec3 r0 = groundNoise(p * 5.0 + vec2(0.35, 0.22) * uGroundTime);
    vec3 r1 = groundNoise(p * 11.0 - vec2(0.5, -0.3) * uGroundTime);
    slope = mix(slope, (r0.yz + r1.yz * 0.6) * uGroundStone.w, gPuddle);

    gNormal = normalize(vec3(-slope.x, 1.0, -slope.y));
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
    dGlossiness = mix(dGlossiness, 0.97, gPuddle);
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
    dEmission = uGroundSky * (gMirror * gPuddle / max(dAlpha, 0.05));
}
`;

const COMMON_WGSL = /* wgsl */`
uniform uGroundEye: vec3f;
uniform uGroundSky: vec3f;        // the sky the puddles mirror: black, but for lightning
uniform uGroundTime: f32;
uniform uGroundStone: vec4f;      // fine stones per metre, coarse stones per metre, height of the relief (m), ripple slope

var<private> gPuddle: f32;      // 1 in standing water
var<private> gDamp: f32;        // 1 where the asphalt is soaked, around a puddle
var<private> gGrain: f32;       // 0 binder .. 1 stone
var<private> gTone: f32;        // slow variation in how dark the surface is
var<private> gMirror: f32;      // how much of the sky water reflects at this angle
var<private> gNormal: vec3f;

fn groundEval() {
    let p = vPositionW.xz;
    let toEye = uniform.uGroundEye - vPositionW;
    let dist = length(toEye);
    gMirror = 0.04 + 0.96 * pow(1.0 - clamp(toEye.y / dist, 0.0, 1.0), 5.0);
    // the size of a pixel on the ground (m), averaged over its long and short sides
    let pixel = dist * 0.0005 * sqrt(dist / max(toEye.y, 0.02));
    let puddle = uniform.uGroundPuddle;
    let stone = uniform.uGroundStone;

    let lay = groundLie(p);
    let lie = lay.x;
    let soft = 0.006 + pixel * 0.6;
    gPuddle = 1.0 - smoothstep(puddle.x - soft, puddle.x + soft, lie);
    gDamp = 1.0 - smoothstep(puddle.x, puddle.x + 0.07, lie);
    gTone = 0.75 + 0.5 * lay.y;

    // the stones
    let fine = 1.0 - smoothstep(0.3, 1.0, pixel * stone.x);
    let coarse = 1.0 - smoothstep(0.3, 1.0, pixel * stone.y);
    let s0 = groundNoise(p * stone.x);
    let s1 = groundNoise(p * stone.y + 17.3);
    gGrain = mix(0.5, s0.x, fine) * 0.45 + mix(0.5, s1.x, coarse) * 0.55;
    var slope = (s0.yz * (stone.x * 0.4 * fine) + s1.yz * (stone.y * 0.6 * coarse)) * stone.z;

    // water lies flat, but for the rain keeping its surface moving
    let r0 = groundNoise(p * 5.0 + vec2f(0.35, 0.22) * uniform.uGroundTime);
    let r1 = groundNoise(p * 11.0 - vec2f(0.5, -0.3) * uniform.uGroundTime);
    slope = mix(slope, (r0.yz + r1.yz * 0.6) * stone.w, gPuddle);

    gNormal = normalize(vec3f(-slope.x, 1.0, -slope.y));
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
    dGlossiness = mix(dGlossiness, 0.97, gPuddle);
}
`;

const EMISSIVE_WGSL = /* wgsl */`
fn getEmission() {
    // water is thin (see getOpacity), so what it mirrors is scaled up to survive the blend
    dEmission = uniform.uGroundSky * (gMirror * gPuddle / max(dAlpha, 0.05));
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
        ripple: 0.02,           // slope of the water's surface
        sky: [0, 0, 0]          // what the puddles mirror; src/lightning.js sets it
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
    });

    return { settings, entity, material };
}
