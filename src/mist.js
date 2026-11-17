// Ground mist: a low haze that only shows where light falls on it.
//
// A few dozen wide, soft sheets of mist stand upright a little above the ground, each turned to
// face the camera, and drift with the wind across the same box the rain falls through. Like the
// rain they are dark until lit: every pixel of a sheet is lit from its own place in the world
// against the torch's cone, so the beam shows as a soft shaft where it crosses the mist, and a
// lightning flash lifts all of it at once. Slow noise breaks each sheet into wisps.
//
// Drawn additively on the rain's layer, after the splats. Splats write no depth, so nothing
// would stop a sheet behind a figure from glowing through it. The lighting texture already holds,
// for every pixel, how far off the figures' proxy mesh is (src/relight-depth.js puts it in the
// alpha), so each pixel of mist looks itself up there and goes dark if a figure is nearer.
// A sheet also fades out as the camera nears it, so none is ever a wall across the lens.
import * as pc from 'playcanvas';

import { TORCH_GLSL, TORCH_WGSL, createGlowMaterial, createSeededQuads } from './rain.js';

const VERT_GLSL = /* glsl */`
attribute vec4 vertex_position;     // where in the box the sheet starts (y is its height)
attribute vec3 vertex_normal;       // per sheet: speed factor, size and brightness factor, spare
attribute vec2 vertex_texCoord0;    // corner of the sheet, -1..1 both ways

uniform mat4 matrix_viewProjection;
uniform float uRainTime;
uniform vec3 uRainEye;
uniform vec4 uRainFall;     // wind x, fall speed (m/s), wind z, streak width (m)
uniform vec4 uMistBox;      // half width of the box, half width of a sheet, half height, drift (fraction of the wind)

varying vec3 vMistWorld;
varying vec4 vMistSheet;    // corner (-1..1 both ways), seed, how much of it there is

void main(void) {
    vec3 seed = vertex_position.xyz;
    vec2 at = seed.xz + uRainFall.xz * (uRainTime * uMistBox.w * vertex_normal.x);
    at = mod(at + uMistBox.x, 2.0 * uMistBox.x) - uMistBox.x;
    vec3 base = vec3(at.x, seed.y, at.y);

    vec3 toEye = uRainEye - base;
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toEye));
    float size = 0.7 + 0.6 * vertex_normal.y;
    vec3 pos = base + right * (vertex_texCoord0.x * uMistBox.y * size) + vec3(0.0, vertex_texCoord0.y * uMistBox.z * size, 0.0);

    // thin out towards the edge of the box, where sheets wrap round, and close to the lens
    float edge = 1.0 - smoothstep(0.7, 1.0, max(abs(at.x), abs(at.y)) / uMistBox.x);
    float near = smoothstep(0.9, 2.6, length(toEye));

    gl_Position = matrix_viewProjection * vec4(pos, 1.0);
    vMistWorld = pos;
    vMistSheet = vec4(vertex_texCoord0, seed.x * 3.1 + seed.z * 1.7, edge * near * (0.5 + 0.5 * vertex_normal.y));
}
`;

const FRAG_GLSL = /* glsl */`
uniform float uRainTime;
uniform vec3 uTorchColor;
uniform vec3 uFlashColor;
uniform vec4 uMist;         // brightness in the torch, in a flash, top of the mist (m), size of the wisps (1/m)
uniform sampler2D uMistFigures;     // the lighting texture: alpha is the distance to the figures, 0 where there are none
uniform vec4 uMistScreen;           // 1 / width, 1 / height of that texture; metres over which mist goes behind a figure; whether to look
${TORCH_GLSL}
varying vec3 vMistWorld;
varying vec4 vMistSheet;

float mistHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float mistNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mistHash(i), mistHash(i + vec2(1.0, 0.0)), f.x), mix(mistHash(i + vec2(0.0, 1.0)), mistHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main(void) {
    // a soft sheet, wider than it is tall
    float body = (1.0 - smoothstep(0.15, 1.0, abs(vMistSheet.x))) * (1.0 - smoothstep(0.1, 1.0, abs(vMistSheet.y)));
    // wisps: two sizes of noise sliding past each other
    vec2 q = vec2(vMistWorld.x + vMistWorld.z * 0.6, vMistWorld.y * 2.5) * uMist.w + vMistSheet.z;
    float wisps = mistNoise(q + vec2(uRainTime * 0.07, 0.0)) * 0.65 + mistNoise(q * 2.3 - vec2(uRainTime * 0.11, uRainTime * 0.03)) * 0.35;
    wisps = smoothstep(0.34, 0.74, wisps);
    // it lies on the ground and thins upwards
    float lying = smoothstep(0.0, 0.06, vMistWorld.y) * (1.0 - smoothstep(0.25 * uMist.z, uMist.z, vMistWorld.y));

    // a figure nearer than this bit of mist hides it
    float figure = texture2DLod(uMistFigures, gl_FragCoord.xy * uMistScreen.xy, 0.0).a;
    float behind = 1.0 / gl_FragCoord.w - figure;
    float seen = 1.0 - uMistScreen.w * step(0.0001, figure) * smoothstep(0.0, uMistScreen.z, behind);

    float amount = body * wisps * lying * vMistSheet.w * seen;
    vec3 light = uTorchColor * (torchLight(vMistWorld) * uMist.x) + uFlashColor * uMist.y;
    gl_FragColor = vec4(light * amount, 1.0);
}
`;

const VERT_WGSL = /* wgsl */`
attribute vertex_position: vec4f;     // where in the box the sheet starts (y is its height)
attribute vertex_normal: vec3f;       // per sheet: speed factor, size and brightness factor, spare
attribute vertex_texCoord0: vec2f;    // corner of the sheet, -1..1 both ways

uniform matrix_viewProjection: mat4x4f;
uniform uRainTime: f32;
uniform uRainEye: vec3f;
uniform uRainFall: vec4f;     // wind x, fall speed (m/s), wind z, streak width (m)
uniform uMistBox: vec4f;      // half width of the box, half width of a sheet, half height, drift (fraction of the wind)

varying vMistWorld: vec3f;
varying vMistSheet: vec4f;    // corner (-1..1 both ways), seed, how much of it there is

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    let box = uniform.uMistBox;
    let seed = vertex_position.xyz;
    var at = seed.xz + uniform.uRainFall.xz * (uniform.uRainTime * box.w * vertex_normal.x);
    at = at + vec2f(box.x);
    at = at - 2.0 * box.x * floor(at / (2.0 * box.x)) - vec2f(box.x);
    let base = vec3f(at.x, seed.y, at.y);

    let toEye = uniform.uRainEye - base;
    let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toEye));
    let size = 0.7 + 0.6 * vertex_normal.y;
    let pos = base + right * (vertex_texCoord0.x * box.y * size) + vec3f(0.0, vertex_texCoord0.y * box.z * size, 0.0);

    // thin out towards the edge of the box, where sheets wrap round, and close to the lens
    let edge = 1.0 - smoothstep(0.7, 1.0, max(abs(at.x), abs(at.y)) / box.x);
    let near = smoothstep(0.9, 2.6, length(toEye));

    output.position = uniform.matrix_viewProjection * vec4f(pos, 1.0);
    output.vMistWorld = pos;
    output.vMistSheet = vec4f(vertex_texCoord0, seed.x * 3.1 + seed.z * 1.7, edge * near * (0.5 + 0.5 * vertex_normal.y));
    return output;
}
`;

const FRAG_WGSL = /* wgsl */`
uniform uRainTime: f32;
uniform uTorchColor: vec3f;
uniform uFlashColor: vec3f;
uniform uMist: vec4f;         // brightness in the torch, in a flash, top of the mist (m), size of the wisps (1/m)
var uMistFigures: texture_2d<f32>;      // the lighting texture: alpha is the distance to the figures, 0 where there are none
var uMistFiguresSampler: sampler;
uniform uMistScreen: vec4f;   // 1 / width, 1 / height of that texture; metres over which mist goes behind a figure; whether to look
${TORCH_WGSL}
varying vMistWorld: vec3f;
varying vMistSheet: vec4f;

fn mistHash(p: vec2f) -> f32 {
    return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn mistNoise(p: vec2f) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mistHash(i), mistHash(i + vec2f(1.0, 0.0)), f.x), mix(mistHash(i + vec2f(0.0, 1.0)), mistHash(i + vec2f(1.0, 1.0)), f.x), f.y);
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let world = input.vMistWorld;
    let sheet = input.vMistSheet;
    let mist = uniform.uMist;
    let time = uniform.uRainTime;

    // a soft sheet, wider than it is tall
    let body = (1.0 - smoothstep(0.15, 1.0, abs(sheet.x))) * (1.0 - smoothstep(0.1, 1.0, abs(sheet.y)));
    // wisps: two sizes of noise sliding past each other
    let q = vec2f(world.x + world.z * 0.6, world.y * 2.5) * mist.w + vec2f(sheet.z);
    var wisps = mistNoise(q + vec2f(time * 0.07, 0.0)) * 0.65 + mistNoise(q * 2.3 - vec2f(time * 0.11, time * 0.03)) * 0.35;
    wisps = smoothstep(0.34, 0.74, wisps);
    // it lies on the ground and thins upwards
    let lying = smoothstep(0.0, 0.06, world.y) * (1.0 - smoothstep(0.25 * mist.z, mist.z, world.y));

    // a figure nearer than this bit of mist hides it
    let screen = uniform.uMistScreen;
    let figure = textureSampleLevel(uMistFigures, uMistFiguresSampler, pcPosition.xy * screen.xy, 0.0).a;
    let behind = 1.0 / pcPosition.w - figure;
    let seen = 1.0 - screen.w * step(0.0001, figure) * smoothstep(0.0, screen.z, behind);

    let amount = body * wisps * lying * sheet.w * seen;
    let light = uniform.uTorchColor * (torchLight(world) * mist.x) + uniform.uFlashColor * mist.y;
    output.color = vec4f(light * amount, 1.0);
    return output;
}
`;

/**
 * @param {object} o - What the mist needs.
 * @param {pc.AppBase} o.app - The app.
 * @param {object} o.rain - From createRain: its layer, its wind, and the torch and flash uniforms
 * it gives every material on its list.
 * @param {object} o.relighting - The GSplatRelighting script: its texture says where the figures are.
 * @returns {object} Settings, the entity and the material.
 */
export function createMist({ app, rain, relighting }) {
    const settings = {
        count: 44,
        halfWidth: 5.5,     // the box the sheets drift through, centred on the figures (m)
        sheet: [1.6, 0.5],  // half width and half height of a sheet (m)
        top: 1.2,           // the mist is gone by this height (m)
        drift: 0.22,        // how fast it moves, as a fraction of the wind on the rain
        torch: 0.34,        // brightness where the torch falls on it, against the rain's
        flash: 0.12,        // and in a lightning flash
        wisps: 1.5,         // per metre: larger is finer
        behind: 0.1         // metres behind a figure's surface by which the mist is gone
    };

    const seeds = new Float32Array(settings.count * 5);
    for (let i = 0; i < settings.count; i++) {
        seeds.set([
            (Math.random() * 2 - 1) * settings.halfWidth, 0.16 + Math.random() * 0.3, (Math.random() * 2 - 1) * settings.halfWidth,
            0.6 + Math.random() * 0.8, Math.random()
        ], i * 5);
    }
    const aabb = new pc.BoundingBox(new pc.Vec3(0, 1, 0), new pc.Vec3(settings.halfWidth + 3, 2, settings.halfWidth + 3));
    const mesh = createSeededQuads(app.graphicsDevice, seeds, 1, [[-1, -1], [1, -1], [1, 1], [-1, 1]], aabb);

    const material = createGlowMaterial('MistShader', {
        vertexGLSL: VERT_GLSL,
        fragmentGLSL: FRAG_GLSL,
        vertexWGSL: VERT_WGSL,
        fragmentWGSL: FRAG_WGSL
    });
    rain.materials.push(material);

    const entity = new pc.Entity('mist');
    entity.addComponent('render', {
        meshInstances: [new pc.MeshInstance(mesh, material)],
        layers: [rain.layer.id],
        castShadows: false,
        receiveShadows: false
    });
    app.root.addChild(entity);

    app.on('update', () => {
        material.setParameter('uMistBox', [settings.halfWidth, settings.sheet[0], settings.sheet[1], settings.drift]);
        material.setParameter('uMist', [settings.torch, settings.flash, settings.top, settings.wisps]);
        // (the texture is only kept up to date while the relighting is on, and only carries
        // distance in the half-float format)
        const figures = relighting.texture;
        const look = relighting.enabled && figures.format === pc.PIXELFORMAT_RGBA16F;
        material.setParameter('uMistFigures', figures);
        material.setParameter('uMistScreen', [1 / figures.width, 1 / figures.height, settings.behind, look ? 1 : 0]);
    });

    return { settings, entity, material };
}
