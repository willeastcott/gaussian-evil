// Splashes: what each rain drop does when it reaches the ground.
//
// Nothing is simulated on the CPU. A drop's path is a pure function of its seed and the time
// (src/rain.js), so the place and moment it lands are too, and these shaders work them out for
// the very same drops. Every splash is where a streak just ended.
//
//   - droplets: each landing throws up a few beads of water on ballistic arcs. In a puddle they
//     make a small crown; on asphalt the drop mostly shatters, so they are lower and shorter-lived
//   - rings: a landing in a puddle (src/ground.js says where the water is) also sends out a ring,
//     a short train of waves that spreads and dies away, cut off at the puddle's edge. A wave is
//     seen mostly by what it does to the reflection: each ring re-draws the water under it, taken
//     from the picture so far (the engine's scene colour grab) at a point shifted by its slope.
//     The crests also catch a glint of the torch
//
// The droplets are lit like the rain, only by the torch and only inside its beam, and are drawn
// with the rain, over everything. The rings lie on the water: they are drawn after the ground has
// been grabbed and before the figures, which then stand in front of them.
import * as pc from 'playcanvas';

import { GROUND_LIE_GLSL, GROUND_LIE_WGSL } from './ground.js';
import {
    RAIN_LANDING_GLSL, RAIN_LANDING_WGSL, STREAK_FRAG_GLSL, STREAK_FRAG_WGSL, TORCH_GLSL, TORCH_WGSL,
    createGlowMaterial, createSeededQuads
} from './rain.js';

const DROPLETS = 4;     // per landing

const DROPLET_VERT_GLSL = /* glsl */`
attribute vec4 vertex_position;     // the rain drop's seed
attribute vec3 vertex_normal;       // per drop: speed factor, brightness factor; then which droplet
attribute vec2 vertex_texCoord0;    // corner of the bead: across (-1..1), along (0..1)

uniform mat4 matrix_viewProjection;
uniform vec3 uRainEye;
uniform vec4 uSplash;       // speed up (m/s), speed outwards (m/s), shutter time (s), width (m)
uniform vec4 uSplashOn;     // size on asphalt relative to water, brightness, brightness on asphalt, spare
${RAIN_LANDING_GLSL}
${TORCH_GLSL}
${GROUND_LIE_GLSL}
varying vec4 vShade;        // across, along, brightness from the torch, and from a flash

void main(void) {
    vec4 land = rainLanding(vertex_position.xyz, vertex_normal.x);
    float tau = land.z, k = vertex_normal.z;
    float water = step(groundLie(land.xy).x, uGroundPuddle.x);
    float size = mix(uSplashOn.x, 1.0, water);

    // each landing, and each droplet of it, is thrown differently
    vec2 key = vertex_position.xz * 53.1 + vec2(land.w * 3.7 + k * 11.3, k * 5.9 - land.w * 1.3);
    float h0 = groundHash(key), h1 = groundHash(key + 19.19), h2 = groundHash(key + 47.7);
    float angle = 6.2832 * h0;
    // the first droplet is the rebound from the middle, nearly straight up
    float outward = uSplash.y * (0.3 + h1) * (k < 0.5 ? 0.2 : 1.0);
    vec3 vel = vec3(cos(angle) * outward, uSplash.x * (0.55 + 0.45 * h2), sin(angle) * outward) * size;

    vec3 base = vec3(land.x, 0.0, land.y) + vel * tau;
    base.y -= 4.9 * tau * tau;
    vec3 v = vel - vec3(0.0, 9.8 * tau, 0.0);

    // a bead smeared along its path by the shutter; at the top of its arc it is nearly a dot
    float len = max(length(v) * uSplash.z, uSplash.w * 2.0);
    vec3 along = normalize(v);
    vec3 across = normalize(cross(along, uRainEye - base));
    vec3 pos = base - along * (len * vertex_texCoord0.y) + across * (uSplash.w * vertex_texCoord0.x);

    // gone once it has fallen back
    float alive = step(0.0, base.y);
    pos = mix(base, pos, alive);

    gl_Position = matrix_viewProjection * vec4(pos, 1.0);
    float bright = vertex_normal.y * uSplashOn.y * mix(uSplashOn.z, 1.0, water) * alive;
    vShade = vec4(vertex_texCoord0, torchLight(base) * bright, bright);
}
`;

const DROPLET_VERT_WGSL = /* wgsl */`
attribute vertex_position: vec4f;     // the rain drop's seed
attribute vertex_normal: vec3f;       // per drop: speed factor, brightness factor; then which droplet
attribute vertex_texCoord0: vec2f;    // corner of the bead: across (-1..1), along (0..1)

uniform matrix_viewProjection: mat4x4f;
uniform uRainEye: vec3f;
uniform uSplash: vec4f;       // speed up (m/s), speed outwards (m/s), shutter time (s), width (m)
uniform uSplashOn: vec4f;     // size on asphalt relative to water, brightness, brightness on asphalt, spare
${RAIN_LANDING_WGSL}
${TORCH_WGSL}
${GROUND_LIE_WGSL}
varying vShade: vec4f;        // across, along, brightness from the torch, and from a flash

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    let splash = uniform.uSplash;
    let on = uniform.uSplashOn;
    let land = rainLanding(vertex_position.xyz, vertex_normal.x);
    let tau = land.z;
    let k = vertex_normal.z;
    let water = step(groundLie(land.xy).x, uniform.uGroundPuddle.x);
    let size = mix(on.x, 1.0, water);

    // each landing, and each droplet of it, is thrown differently
    let key = vertex_position.xz * 53.1 + vec2f(land.w * 3.7 + k * 11.3, k * 5.9 - land.w * 1.3);
    let h0 = groundHash(key);
    let h1 = groundHash(key + 19.19);
    let h2 = groundHash(key + 47.7);
    let angle = 6.2832 * h0;
    // the first droplet is the rebound from the middle, nearly straight up
    let outward = splash.y * (0.3 + h1) * select(1.0, 0.2, k < 0.5);
    let vel = vec3f(cos(angle) * outward, splash.x * (0.55 + 0.45 * h2), sin(angle) * outward) * size;

    var base = vec3f(land.x, 0.0, land.y) + vel * tau;
    base.y = base.y - 4.9 * tau * tau;
    let v = vel - vec3f(0.0, 9.8 * tau, 0.0);

    // a bead smeared along its path by the shutter; at the top of its arc it is nearly a dot
    let len = max(length(v) * splash.z, splash.w * 2.0);
    let along = normalize(v);
    let across = normalize(cross(along, uniform.uRainEye - base));
    var pos = base - along * (len * vertex_texCoord0.y) + across * (splash.w * vertex_texCoord0.x);

    // gone once it has fallen back
    let alive = step(0.0, base.y);
    pos = mix(base, pos, alive);

    output.position = uniform.matrix_viewProjection * vec4f(pos, 1.0);
    let bright = vertex_normal.y * on.y * mix(on.z, 1.0, water) * alive;
    output.vShade = vec4f(vertex_texCoord0, torchLight(base) * bright, bright);
    return output;
}
`;

const RING_VERT_GLSL = /* glsl */`
attribute vec4 vertex_position;     // the rain drop's seed
attribute vec3 vertex_normal;       // per drop: speed factor, brightness factor, spare
attribute vec2 vertex_texCoord0;    // corner of the patch of water the ring spreads over (-1..1)

uniform mat4 matrix_viewProjection;
uniform vec4 uRing;         // largest radius (m), speed it spreads at (m/s), how long it lasts (s), brightness
${RAIN_LANDING_GLSL}
${TORCH_GLSL}
${GROUND_LIE_GLSL}
varying vec4 vRing;         // corner, seconds since the drop landed, brightness
varying vec2 vRingAt;       // where on the ground

void main(void) {
    vec4 land = rainLanding(vertex_position.xyz, vertex_normal.x);
    // only a drop that lands in water makes a ring, and only for a while
    float alive = step(groundLie(land.xy).x, uGroundPuddle.x) * step(land.z, uRing.z);
    vec2 at = land.xy + vertex_texCoord0 * (uRing.x * alive);

    gl_Position = matrix_viewProjection * vec4(at.x, 0.003, at.y, 1.0);
    vRing = vec4(vertex_texCoord0, land.z, torchLight(vec3(land.x, 0.0, land.y)) * vertex_normal.y * uRing.w * alive);
    vRingAt = at;
}
`;

const RING_FRAG_GLSL = /* glsl */`
uniform sampler2D uSceneColorMap;   // everything drawn so far: the ground, with the reflection in its puddles
uniform vec4 screen_size;
uniform vec3 uTorchColor;
uniform vec4 uRing;
uniform vec4 uRingLook;     // how far a slope shifts what the water reflects (m), strength of the glint, spare
${GROUND_LIE_GLSL}
varying vec4 vRing;
varying vec2 vRingAt;

void main(void) {
    // how the ground moves under one pixel, to turn a shift on the water into a shift on screen
    vec2 dx = dFdx(vRingAt), dy = dFdy(vRingAt);

    float reach = length(vRing.xy);
    float r = reach * uRing.x, tau = vRing.z;

    // a short train of waves behind a front that moves outwards
    float d = r - (0.008 + uRing.y * tau);
    float life = 1.0 - tau / uRing.z;
    float inside = 1.0 - smoothstep(0.8, 1.0, reach);
    // the ring stops where the water does
    float water = 1.0 - smoothstep(uGroundPuddle.x - 0.012, uGroundPuddle.x, groundLie(vRingAt).x);
    float train = exp(-d * d / (2.0 * 0.016 * 0.016)) * inside * water;

    // A wave tilts the water, and tilted water reflects something else: what an undisturbed
    // surface would show a little further out or further in. So look there instead.
    float slope = sin(d * 230.0) * train * life;
    vec2 shift = vRing.xy / max(reach, 1.0e-4) * (slope * uRingLook.x);
    float det = dx.x * dy.y - dy.x * dx.y;
    det = det < 0.0 ? min(det, -1.0e-12) : max(det, 1.0e-12);
    vec2 pixels = vec2(shift.x * dy.y - dy.x * shift.y, dx.x * shift.y - shift.x * dx.y) / det;
    vec3 seen = texture2DLod(uSceneColorMap, (gl_FragCoord.xy + pixels) * screen_size.zw, 0.0).rgb;

    // and the crests facing the torch catch a little of it
    float glint = max(0.0, cos(d * 230.0)) * train * life * life * vRing.w * uRingLook.y;

    float cover = clamp(train * life * 4.0, 0.0, 1.0);
    gl_FragColor = vec4(seen * cover + uTorchColor * glint, cover);
}
`;

const RING_VERT_WGSL = /* wgsl */`
attribute vertex_position: vec4f;     // the rain drop's seed
attribute vertex_normal: vec3f;       // per drop: speed factor, brightness factor, spare
attribute vertex_texCoord0: vec2f;    // corner of the patch of water the ring spreads over (-1..1)

uniform matrix_viewProjection: mat4x4f;
uniform uRing: vec4f;         // largest radius (m), speed it spreads at (m/s), how long it lasts (s), brightness
${RAIN_LANDING_WGSL}
${TORCH_WGSL}
${GROUND_LIE_WGSL}
varying vRing: vec4f;         // corner, seconds since the drop landed, brightness
varying vRingAt: vec2f;       // where on the ground

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    let ring = uniform.uRing;
    let land = rainLanding(vertex_position.xyz, vertex_normal.x);
    // only a drop that lands in water makes a ring, and only for a while
    let alive = step(groundLie(land.xy).x, uniform.uGroundPuddle.x) * step(land.z, ring.z);
    let at = land.xy + vertex_texCoord0 * (ring.x * alive);

    output.position = uniform.matrix_viewProjection * vec4f(at.x, 0.003, at.y, 1.0);
    output.vRing = vec4f(vertex_texCoord0, land.z, torchLight(vec3f(land.x, 0.0, land.y)) * vertex_normal.y * ring.w * alive);
    output.vRingAt = at;
    return output;
}
`;

const RING_FRAG_WGSL = /* wgsl */`
var uSceneColorMap: texture_2d<f32>;    // everything drawn so far: the ground, with the reflection in its puddles
var uSceneColorMapSampler: sampler;
uniform screen_size: vec4f;
uniform uTorchColor: vec3f;
uniform uRing: vec4f;
uniform uRingLook: vec4f;     // how far a slope shifts what the water reflects (m), strength of the glint, spare
${GROUND_LIE_WGSL}
varying vRing: vec4f;
varying vRingAt: vec2f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // how the ground moves under one pixel, to turn a shift on the water into a shift on screen
    let dx = dpdx(input.vRingAt);
    let dy = dpdy(input.vRingAt);

    let ring = uniform.uRing;
    let look = uniform.uRingLook;
    let reach = length(input.vRing.xy);
    let r = reach * ring.x;
    let tau = input.vRing.z;

    // a short train of waves behind a front that moves outwards
    let d = r - (0.008 + ring.y * tau);
    let life = 1.0 - tau / ring.z;
    let inside = 1.0 - smoothstep(0.8, 1.0, reach);
    // the ring stops where the water does
    let water = 1.0 - smoothstep(uniform.uGroundPuddle.x - 0.012, uniform.uGroundPuddle.x, groundLie(input.vRingAt).x);
    let train = exp(-d * d / (2.0 * 0.016 * 0.016)) * inside * water;

    // A wave tilts the water, and tilted water reflects something else: what an undisturbed
    // surface would show a little further out or further in. So look there instead.
    let slope = sin(d * 230.0) * train * life;
    let shift = input.vRing.xy / max(reach, 1.0e-4) * (slope * look.x);
    var det = dx.x * dy.y - dy.x * dx.y;
    det = select(max(det, 1.0e-12), min(det, -1.0e-12), det < 0.0);
    let pixels = vec2f(shift.x * dy.y - dy.x * shift.y, dx.x * shift.y - shift.x * dx.y) / det;
    let seen = textureSampleLevel(uSceneColorMap, uSceneColorMapSampler, (pcPosition.xy + pixels) * uniform.screen_size.zw, 0.0).rgb;

    // and the crests facing the torch catch a little of it
    let glint = max(0.0, cos(d * 230.0)) * train * life * life * input.vRing.w * look.y;

    let cover = clamp(train * life * 4.0, 0.0, 1.0);
    output.color = vec4f(seen * cover + uniform.uTorchColor * glint, cover);
    return output;
}
`;

/**
 * @param {object} o - What the splashes need.
 * @param {pc.AppBase} o.app - The app.
 * @param {object} o.rain - From createRain: the drops to follow.
 * @param {object} o.ground - From createGround: where the water is.
 * @param {pc.Entity} o.camera - Main camera: it is asked to grab the picture so far for the rings.
 * @param {pc.Layer} o.ringLayer - Layer drawn after that grab and before the figures.
 * @returns {object} Settings and the entities made.
 */
export function createSplashes({ app, camera, rain, ground, ringLayer }) {
    const settings = {
        up: 1.5,            // m/s: how hard a droplet is thrown upwards, at most
        out: 0.6,           // m/s outwards
        shutter: 0.02,      // s: the smear of a moving droplet
        width: 0.0022,      // m
        onAsphalt: 0.45,    // size of a splash on asphalt, relative to one in water
        brightness: 0.9,    // relative to a rain streak
        asphaltBrightness: 0.6,
        ringRadius: 0.16,   // m: as far as a ring gets
        ringSpeed: 0.3,     // m/s
        ringLife: 0.5,      // s
        ringBend: 0.4,      // m: how far the reflection shifts per unit of the water's slope
        ringGlint: 0.35     // the torch on the crests, relative to a rain streak
    };
    const device = app.graphicsDevice;

    const droplets = new pc.Entity('splash-droplets');
    const dropletMaterial = createGlowMaterial('SplashDropletShader', {
        vertexGLSL: DROPLET_VERT_GLSL,
        fragmentGLSL: STREAK_FRAG_GLSL,
        vertexWGSL: DROPLET_VERT_WGSL,
        fragmentWGSL: STREAK_FRAG_WGSL
    });
    droplets.addComponent('render', {
        meshInstances: [new pc.MeshInstance(createSeededQuads(device, rain.seeds, DROPLETS, [[-1, 0], [1, 0], [1, 1], [-1, 1]], rain.aabb), dropletMaterial)],
        layers: [rain.layer.id],
        castShadows: false,
        receiveShadows: false
    });
    app.root.addChild(droplets);

    const rings = new pc.Entity('splash-rings');
    const ringMaterial = createGlowMaterial('SplashRingShader', {
        vertexGLSL: RING_VERT_GLSL,
        fragmentGLSL: RING_FRAG_GLSL,
        vertexWGSL: RING_VERT_WGSL,
        fragmentWGSL: RING_FRAG_WGSL
    });
    // not added to the picture but laid over it: each ring replaces the water under it
    ringMaterial.blendType = pc.BLEND_PREMULTIPLIED;
    ringMaterial.update();
    camera.camera.requestSceneColorMap(true);
    rings.addComponent('render', {
        meshInstances: [new pc.MeshInstance(createSeededQuads(device, rain.seeds, 1, [[-1, -1], [1, -1], [1, 1], [-1, 1]], rain.aabb), ringMaterial)],
        layers: [ringLayer.id],
        castShadows: false,
        receiveShadows: false
    });
    app.root.addChild(rings);

    // the rain hands both materials its own uniforms and the torch's
    rain.materials.push(dropletMaterial, ringMaterial);

    app.on('update', () => {
        const g = ground.settings;
        const puddle = [g.waterLevel, g.waterOpacity, g.dipRadius, g.dipDepth];
        dropletMaterial.setParameter('uGroundPuddle', puddle);
        ringMaterial.setParameter('uGroundPuddle', puddle);
        dropletMaterial.setParameter('uSplash', [settings.up, settings.out, settings.shutter, settings.width]);
        dropletMaterial.setParameter('uSplashOn', [settings.onAsphalt, settings.brightness, settings.asphaltBrightness, 0]);
        ringMaterial.setParameter('uRing', [settings.ringRadius, settings.ringSpeed, settings.ringLife, 1]);
        ringMaterial.setParameter('uRingLook', [settings.ringBend, settings.ringGlint, 0, 0]);
    });

    return { settings, droplets, rings, dropletMaterial, ringMaterial };
}
