// Depth-aware relighting: each splat takes its light from the mesh surface at its own depth.
//
// The engine's GSplatRelighting script draws the lit proxy mesh into a texture, and every splat
// fragment is tinted by that texture at its own pixel. A pixel holds one surface, the nearest.
// The proxy is a little bigger than the splats it stands in for (it has to cover them), so where
// an arm passes in front of a face, the arm's mesh overhangs the face by a centimetre or so, and
// that strip of face was lit as the arm: by the dim, side-on rim of it. Seen from close to, the
// outline of the mesh showed through on whatever was behind it.
//
// The cure is in shaders:
//
//   1. the proxy writes how far away it is into the texture's alpha, in metres (it used to
//      write 1, as a "something is here" flag; nothing is 0, as before)
//   2. 'far', a half-size texture, is made from that each frame. For every pixel it holds the
//      lighting of the furthest mesh surface found within a few centimetres' reach on screen:
//      what is behind an overhang, carried in under it
//   3. 'marked' is the first texture again, with its depth made negative wherever 'far' has
//      found something further off: the pixels where a second look could matter
//
// A splat fragment reads 'marked'. Nearly always that is all: it is the surface the mesh stands in
// for, or it is on the far side of the body and hidden anyway. Where the pixel is marked, it reads
// 'far' as well and takes whichever was lit at a depth closer to its own. A splat of the face
// under the arm's overhang finds the arm in the one and the face in the other, and takes the face.
//
// (Reading 'far' for every fragment that does not match the first texture was tried first. It
// is simpler, and cost 5 ms a frame in a close-up: every splat on the far side of a body pays,
// to no purpose.)
//
// 'far' also carries lighting out past the edge of the mesh, so a splat that sticks out beyond it
// still finds light there, and the proxy need not be grown so much to cover them.
import * as pc from 'playcanvas';

import { QuadPass } from './post.js';

// the proxy mesh: lighting in RGB, distance from the camera in A
const MESH_OUTPUT_GLSL = /* glsl */`
    gl_FragColor.a = 1.0 / gl_FragCoord.w;
`;
const MESH_OUTPUT_WGSL = /* wgsl */`
    output.color = vec4f(output.color.rgb, 1.0 / pcPosition.w);
`;

const FAR_GLSL = /* glsl */`
uniform sampler2D uRelightMap;
uniform vec4 uRelightExtend;    // one texel of the lighting (x, y), reach in texels at one metre, the furthest it may reach
varying vec2 ndc;

void main(void) {
    vec2 uv = getImageEffectUV(ndc * 0.5 + 0.5);
    vec4 best = texture2DLod(uRelightMap, uv, 0.0);
    // the reach is a length in the world, so it is more pixels the nearer the surface is
    float reach = best.a > 0.0 ? min(uRelightExtend.z / best.a, uRelightExtend.w) : uRelightExtend.w * 0.25;
    for (int ring = 1; ring <= 2; ring++) {
        float r = reach * float(ring) * 0.5;
        for (int k = 0; k < 8; k++) {
            float turn = (float(k) + 0.5 * float(ring)) * 0.7853982;
            vec4 tap = texture2DLod(uRelightMap, uv + vec2(cos(turn), sin(turn)) * r * uRelightExtend.xy, 0.0);
            if (tap.a > best.a) best = tap;
        }
    }
    gl_FragColor = best;
}
`;

const FAR_WGSL = /* wgsl */`
var uRelightMap: texture_2d<f32>;
var uRelightMapSampler: sampler;
uniform uRelightExtend: vec4f;    // one texel of the lighting (x, y), reach in texels at one metre, the furthest it may reach
varying ndc: vec2f;

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let extend = uniform.uRelightExtend;
    let uv = getImageEffectUV(input.ndc * 0.5 + 0.5);
    var best = textureSampleLevel(uRelightMap, uRelightMapSampler, uv, 0.0);
    // the reach is a length in the world, so it is more pixels the nearer the surface is
    var reach = extend.w * 0.25;
    if (best.a > 0.0) { reach = min(extend.z / best.a, extend.w); }
    for (var ring = 1; ring <= 2; ring++) {
        let r = reach * f32(ring) * 0.5;
        for (var k = 0; k < 8; k++) {
            let turn = (f32(k) + 0.5 * f32(ring)) * 0.7853982;
            let tap = textureSampleLevel(uRelightMap, uRelightMapSampler, uv + vec2f(cos(turn), sin(turn)) * r * extend.xy, 0.0);
            if (tap.a > best.a) { best = tap; }
        }
    }
    output.color = best;
    return output;
}
`;

// the first texture, with its depth negated where 'far' holds something further off. Where there
// is no mesh at all but 'far' has some, the depth is a token small negative number
const MARK_GLSL = /* glsl */`
uniform sampler2D uRelightMap;
uniform sampler2D uRelightFar;
uniform vec4 uRelightPick;      // how much further off 'far' must be to count (m), spare
varying vec2 ndc;

void main(void) {
    vec2 uv = getImageEffectUV(ndc * 0.5 + 0.5);
    vec4 near = texture2DLod(uRelightMap, uv, 0.0);
    float far = texture2DLod(uRelightFar, uv, 0.0).a;
    float depth = near.a;
    if (far > near.a + uRelightPick.x) depth = near.a > 0.0 ? -near.a : -0.00001;
    gl_FragColor = vec4(near.rgb, depth);
}
`;

const MARK_WGSL = /* wgsl */`
var uRelightMap: texture_2d<f32>;
var uRelightMapSampler: sampler;
var uRelightFar: texture_2d<f32>;
var uRelightFarSampler: sampler;
uniform uRelightPick: vec4f;      // how much further off 'far' must be to count (m), spare
varying ndc: vec2f;

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let uv = getImageEffectUV(input.ndc * 0.5 + 0.5);
    let near = textureSampleLevel(uRelightMap, uRelightMapSampler, uv, 0.0);
    let far = textureSampleLevel(uRelightFar, uRelightFarSampler, uv, 0.0).a;
    var depth = near.a;
    if (far > near.a + uniform.uRelightPick.x) { depth = select(-0.00001, -near.a, near.a > 0.0); }
    output.color = vec4f(near.rgb, depth);
    return output;
}
`;

// the splats: the same uniforms as the engine's chunk, reading 'marked' in place of its texture
const SPLAT_GLSL = /* glsl */`
uniform sampler2D uRelightMarked;
uniform sampler2D uRelightFar;
uniform vec4 screen_size;
uniform float uRelightBlend;
uniform float uRelightBrightness;
uniform float uRelightBackground;
uniform vec4 uRelightPick;      // how much closer in depth 'far' must be to be chosen (m), spare

void modifySplatColor(vec2 gaussianUV, inout vec4 color) {
    vec2 uv = gl_FragCoord.xy * screen_size.zw;
    vec4 lit = textureLod(uRelightMarked, uv, 0.0);
    if (lit.a < 0.0) {
        // something further off is lit near here: take whichever is nearer this splat's own depth
        vec4 far = textureLod(uRelightFar, uv, 0.0);
        float mine = 1.0 / gl_FragCoord.w;
        float offNear = lit.a < -0.0001 ? abs(mine + lit.a) : 1000.0;
        if (abs(mine - far.a) + uRelightPick.x < offNear) lit = far;
    }
    vec3 factor = mix(vec3(uRelightBackground), lit.rgb * uRelightBrightness, step(0.0001, abs(lit.a)));
    color.rgb = mix(color.rgb, color.rgb * factor, uRelightBlend);
}
`;

const SPLAT_WGSL = /* wgsl */`
var uRelightMarked: texture_2d<f32>;
var uRelightMarkedSampler: sampler;
var uRelightFar: texture_2d<f32>;
var uRelightFarSampler: sampler;
uniform screen_size: vec4f;
uniform uRelightBlend: f32;
uniform uRelightBrightness: f32;
uniform uRelightBackground: f32;
uniform uRelightPick: vec4f;      // how much closer in depth 'far' must be to be chosen (m), spare

fn modifySplatColor(gaussianUV: vec2f, color: ptr<function, vec4f>) {
    let uv = pcPosition.xy * uniform.screen_size.zw;
    var lit = textureSampleLevel(uRelightMarked, uRelightMarkedSampler, uv, 0.0);
    if (lit.a < 0.0) {
        // something further off is lit near here: take whichever is nearer this splat's own depth
        let far = textureSampleLevel(uRelightFar, uRelightFarSampler, uv, 0.0);
        let mine = 1.0 / pcPosition.w;
        let offNear = select(1000.0, abs(mine + lit.a), lit.a < -0.0001);
        if (abs(mine - far.a) + uniform.uRelightPick.x < offNear) { lit = far; }
    }
    let factor = mix(vec3f(uniform.uRelightBackground), lit.rgb * uniform.uRelightBrightness, step(0.0001, abs(lit.a)));
    *color = vec4f(mix((*color).rgb, (*color).rgb * factor, uniform.uRelightBlend), (*color).a);
}
`;

/**
 * @param {object} o - What it builds on.
 * @param {pc.AppBase} o.app - The app.
 * @param {pc.Entity} o.camera - Main camera.
 * @param {object} o.relighting - The engine's GSplatRelighting script on that camera.
 * @param {pc.StandardMaterial} o.proxyMaterial - Material of the proxy mesh, already configured
 * by the script.
 * @returns {object} Settings and the pieces made.
 */
export function createDepthAwareRelighting({ app, camera, relighting, proxyMaterial }) {
    const settings = {
        reach: 0.02,        // metres: how far lighting is carried in under an overhang, and out past an edge
        maxReach: 64,       // the most that may be, in pixels of the lighting texture
        prefer: 0.08        // metres: 'far' must be this much further off to be marked, and this much closer to a splat to be chosen
    };
    const device = app.graphicsDevice;

    // depths need a float texture; without one, the engine's own lookup is left as it is
    if (relighting.texture.format !== pc.PIXELFORMAT_RGBA16F) return { settings, active: false };

    proxyMaterial.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('outputPS', MESH_OUTPUT_GLSL);
    proxyMaterial.getShaderChunks(pc.SHADERLANGUAGE_WGSL).set('outputPS', MESH_OUTPUT_WGSL);
    proxyMaterial.update();

    // both are read without blending between texels: a blend of two depths is neither
    const target = (name) => new pc.RenderTarget({
        colorBuffer: new pc.Texture(device, {
            name,
            width: 4,
            height: 4,
            format: pc.PIXELFORMAT_RGBA16F,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE
        }),
        depth: false
    });
    const farTarget = target('RelightingFar'), markedTarget = target('RelightingMarked');
    const far = farTarget.colorBuffer, marked = markedTarget.colorBuffer;

    const farPass = new QuadPass(device, 'RelightFar', FAR_GLSL, FAR_WGSL, (put) => {
        const map = relighting.texture;
        // a pixel's width in radians, turned into pixels of reach at one metre
        const perMetre = map.height / (2 * Math.tan(camera.camera.fov * pc.math.DEG_TO_RAD / 2));
        put('uRelightMap', map);
        put('uRelightExtend', [1 / map.width, 1 / map.height, settings.reach * perMetre, settings.maxReach]);
    });
    farPass.init(farTarget);
    const markPass = new QuadPass(device, 'RelightMark', MARK_GLSL, MARK_WGSL, (put) => {
        put('uRelightMap', relighting.texture);
        put('uRelightFar', far);
        put('uRelightPick', [settings.prefer, 0, 0, 0]);
    });
    markPass.init(markedTarget);

    // a camera that owns no geometry runs the passes, after the proxy is drawn and before the splats
    const layer = new pc.Layer({ name: 'RelightingExtend' });
    app.scene.layers.push(layer);
    const extender = new pc.Entity('relighting-extend');
    extender.addComponent('camera', { priority: -0.5, layers: [layer.id], clearColorBuffer: false, clearDepthBuffer: false });
    app.root.addChild(extender);
    extender.camera.framePasses = [farPass, markPass];

    // the splats' chunk replaces the engine's, which the script puts back whenever it is enabled
    const material = app.scene.gsplat.material;
    const apply = () => {
        material.getShaderChunks(device.isWebGPU ? pc.SHADERLANGUAGE_WGSL : pc.SHADERLANGUAGE_GLSL)
            .set('gsplatModifyPS', device.isWebGPU ? SPLAT_WGSL : SPLAT_GLSL);
        material.update();
    };
    apply();
    relighting.on('enable', apply);

    app.on('update', () => {
        extender.enabled = relighting.enabled;
        const map = relighting.texture;
        const w = Math.max(2, map.width >> 1), h = Math.max(2, map.height >> 1);
        if (farTarget.width !== w || farTarget.height !== h) farTarget.resize(w, h);
        if (markedTarget.width !== map.width || markedTarget.height !== map.height) markedTarget.resize(map.width, map.height);
        material.setParameter('uRelightMarked', marked);
        material.setParameter('uRelightFar', far);
        material.setParameter('uRelightPick', [settings.prefer, 0, 0, 0]);
    });

    return { settings, active: true, far, marked, farTarget, markedTarget, extender };
}
