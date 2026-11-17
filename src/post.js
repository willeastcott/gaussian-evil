// Post effects: a glow around what is bright, a colour grade, a touch of lens, and film grain.
//
// The engine's own effects (CameraFrame) are not used. They draw the scene into a linear-light
// target, so splats blend in linear light, which is not how a capture was trained and turns dark
// cloth grey. Here the camera draws exactly as it would to the screen, only into a texture; a
// second camera that owns no geometry then runs a few full-screen passes over that picture:
//
//   bright   the picture, reduced to a quarter of its size, keeping only what is brighter than a
//            threshold (a torch highlight, a lit streak of rain, a lightning flash)
//   blur     that, blurred: tightly, again at an eighth of the size for a wide halo, and again at
//            a sixteenth for a haze
//   finish   the picture, its red and blue parted slightly towards the edges as a lens would,
//            plus the three glows, added as light; then the grade (more contrast, cool shadows,
//            warm highlights), a faint cold veil in the dark, the vignette and the grain
//
// The picture is stored with gamma applied, as it is on screen, so light is added by decoding it,
// adding, and encoding again.
import * as pc from 'playcanvas';

const VERT_GLSL = /* glsl */`
attribute vec2 aPosition;
varying vec2 ndc;
void main(void) {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    ndc = aPosition;
}
`;

const VERT_WGSL = /* wgsl */`
attribute aPosition: vec2f;
varying ndc: vec2f;
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(input.aPosition, 0.0, 1.0);
    output.ndc = input.aPosition;
    return output;
}
`;

const BRIGHT_GLSL = /* glsl */`
uniform sampler2D postSource;
uniform vec4 uPostBright;       // one texel of the source (x, y), threshold, width of its soft edge
varying vec2 ndc;

vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

void main(void) {
    vec2 uv = getImageEffectUV(ndc * 0.5 + 0.5);
    // four taps between texels: the sixteen texels this one stands for
    vec2 t = uPostBright.xy;
    vec3 c = toLinear(texture2D(postSource, uv + vec2(-t.x, -t.y)).rgb) + toLinear(texture2D(postSource, uv + vec2(t.x, -t.y)).rgb) +
             toLinear(texture2D(postSource, uv + vec2(-t.x, t.y)).rgb) + toLinear(texture2D(postSource, uv + vec2(t.x, t.y)).rgb);
    c *= 0.25;
    float level = max(c.r, max(c.g, c.b));
    // nothing below the threshold, all of it well above, a smooth start between
    float keep = smoothstep(uPostBright.z - uPostBright.w, uPostBright.z + uPostBright.w, level);
    gl_FragColor = vec4(min(c * keep, vec3(8.0)), 1.0);
}
`;

const BRIGHT_WGSL = /* wgsl */`
var postSource: texture_2d<f32>;
var postSourceSampler: sampler;
uniform uPostBright: vec4f;       // one texel of the source (x, y), threshold, width of its soft edge
varying ndc: vec2f;

fn toLinear(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)); }

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let uv = getImageEffectUV(input.ndc * 0.5 + 0.5);
    // four taps between texels: the sixteen texels this one stands for
    let t = uniform.uPostBright.xy;
    var c = toLinear(textureSampleLevel(postSource, postSourceSampler, uv + vec2f(-t.x, -t.y), 0.0).rgb) +
            toLinear(textureSampleLevel(postSource, postSourceSampler, uv + vec2f(t.x, -t.y), 0.0).rgb) +
            toLinear(textureSampleLevel(postSource, postSourceSampler, uv + vec2f(-t.x, t.y), 0.0).rgb) +
            toLinear(textureSampleLevel(postSource, postSourceSampler, uv + vec2f(t.x, t.y), 0.0).rgb);
    c = c * 0.25;
    let level = max(c.r, max(c.g, c.b));
    // nothing below the threshold, all of it well above, a smooth start between
    let keep = smoothstep(uniform.uPostBright.z - uniform.uPostBright.w, uniform.uPostBright.z + uniform.uPostBright.w, level);
    output.color = vec4f(min(c * keep, vec3f(8.0)), 1.0);
    return output;
}
`;

// a nine-texel gaussian in five taps, along one direction
const BLUR_GLSL = /* glsl */`
uniform sampler2D postSource;
uniform vec4 uPostBlur;         // the step between taps (x, y)
varying vec2 ndc;

void main(void) {
    vec2 uv = getImageEffectUV(ndc * 0.5 + 0.5);
    vec2 d = uPostBlur.xy;
    vec3 c = texture2D(postSource, uv).rgb * 0.2270270270;
    c += (texture2D(postSource, uv + d * 1.3846153846).rgb + texture2D(postSource, uv - d * 1.3846153846).rgb) * 0.3162162162;
    c += (texture2D(postSource, uv + d * 3.2307692308).rgb + texture2D(postSource, uv - d * 3.2307692308).rgb) * 0.0702702703;
    gl_FragColor = vec4(c, 1.0);
}
`;

const BLUR_WGSL = /* wgsl */`
var postSource: texture_2d<f32>;
var postSourceSampler: sampler;
uniform uPostBlur: vec4f;         // the step between taps (x, y)
varying ndc: vec2f;

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let uv = getImageEffectUV(input.ndc * 0.5 + 0.5);
    let d = uniform.uPostBlur.xy;
    var c = textureSampleLevel(postSource, postSourceSampler, uv, 0.0).rgb * 0.2270270270;
    c = c + (textureSampleLevel(postSource, postSourceSampler, uv + d * 1.3846153846, 0.0).rgb + textureSampleLevel(postSource, postSourceSampler, uv - d * 1.3846153846, 0.0).rgb) * 0.3162162162;
    c = c + (textureSampleLevel(postSource, postSourceSampler, uv + d * 3.2307692308, 0.0).rgb + textureSampleLevel(postSource, postSourceSampler, uv - d * 3.2307692308, 0.0).rgb) * 0.0702702703;
    output.color = vec4f(c, 1.0);
    return output;
}
`;

const FINISH_GLSL = /* glsl */`
uniform sampler2D postSource;
uniform sampler2D postGlowTight;
uniform sampler2D postGlowWide;
uniform sampler2D postGlowHaze;
uniform vec4 uPostLook;         // glow, vignette, grain, time
uniform vec4 uPostGrain;        // size of a grain in pixels, frames of grain a second, lens fringe, contrast
uniform vec4 uPostTone;         // the veil left in the dark (r, g, b), strength of the toning
varying vec2 ndc;

vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
vec3 toScreen(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
float postHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main(void) {
    vec2 uv = getImageEffectUV(ndc * 0.5 + 0.5);

    // the lens: towards the edges red lands a little further out than green, and blue further in
    vec2 fringe = ndc * dot(ndc, ndc) * uPostGrain.z;
    vec3 scene = vec3(
        texture2D(postSource, getImageEffectUV((ndc + fringe) * 0.5 + 0.5)).r,
        texture2D(postSource, uv).g,
        texture2D(postSource, getImageEffectUV((ndc - fringe) * 0.5 + 0.5)).b);

    // the glow, from a tight halo to a haze a tenth of the picture wide, added as light
    vec3 glow = texture2D(postGlowTight, uv).rgb * 0.4 + texture2D(postGlowWide, uv).rgb * 0.35 + texture2D(postGlowHaze, uv).rgb * 0.25;
    vec3 c = min(toScreen(toLinear(scene) + glow * uPostLook.x), vec3(1.0));

    // the grade: a little more contrast, the shadows turned cool and the highlights warm
    c = mix(c, c * c * (3.0 - 2.0 * c), uPostGrain.w);
    float level = dot(c, vec3(0.299, 0.587, 0.114));
    c *= mix(vec3(1.0), mix(vec3(0.88, 1.0, 1.14), vec3(1.07, 1.0, 0.9), smoothstep(0.12, 0.65, level)), uPostTone.w);

    // rain hangs in the air, so the dark is never quite black: a faint cold veil
    c += uPostTone.rgb * (1.0 - level) * (1.0 - level);

    // darker towards the corners
    c *= 1.0 - uPostLook.y * smoothstep(0.35, 1.4, length(ndc));

    // grain: a new pattern several times a second, a little stronger in the shadows
    vec2 cell = floor(gl_FragCoord.xy / uPostGrain.x);
    float frame = floor(uPostLook.w * uPostGrain.y);
    float n = postHash(cell + frame * 7.31) + postHash(cell * 1.37 + frame * 3.17) - 1.0;
    c += n * uPostLook.z * (1.25 - 0.85 * clamp(level, 0.0, 1.0));

    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

const FINISH_WGSL = /* wgsl */`
var postSource: texture_2d<f32>;
var postSourceSampler: sampler;
var postGlowTight: texture_2d<f32>;
var postGlowTightSampler: sampler;
var postGlowWide: texture_2d<f32>;
var postGlowWideSampler: sampler;
var postGlowHaze: texture_2d<f32>;
var postGlowHazeSampler: sampler;
uniform uPostLook: vec4f;         // glow, vignette, grain, time
uniform uPostGrain: vec4f;        // size of a grain in pixels, frames of grain a second, lens fringe, contrast
uniform uPostTone: vec4f;         // the veil left in the dark (r, g, b), strength of the toning
varying ndc: vec2f;

fn toLinear(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)); }
fn toScreen(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2)); }
fn postHash(p: vec2f) -> f32 {
    var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let look = uniform.uPostLook;
    let grain = uniform.uPostGrain;
    let tone = uniform.uPostTone;
    let at = input.ndc;
    let uv = getImageEffectUV(at * 0.5 + 0.5);

    // the lens: towards the edges red lands a little further out than green, and blue further in
    let fringe = at * dot(at, at) * grain.z;
    let scene = vec3f(
        textureSampleLevel(postSource, postSourceSampler, getImageEffectUV((at + fringe) * 0.5 + 0.5), 0.0).r,
        textureSampleLevel(postSource, postSourceSampler, uv, 0.0).g,
        textureSampleLevel(postSource, postSourceSampler, getImageEffectUV((at - fringe) * 0.5 + 0.5), 0.0).b);

    // the glow, from a tight halo to a haze a tenth of the picture wide, added as light
    let glow = textureSampleLevel(postGlowTight, postGlowTightSampler, uv, 0.0).rgb * 0.4 +
               textureSampleLevel(postGlowWide, postGlowWideSampler, uv, 0.0).rgb * 0.35 +
               textureSampleLevel(postGlowHaze, postGlowHazeSampler, uv, 0.0).rgb * 0.25;
    var c = min(toScreen(toLinear(scene) + glow * look.x), vec3f(1.0));

    // the grade: a little more contrast, the shadows turned cool and the highlights warm
    c = mix(c, c * c * (3.0 - 2.0 * c), grain.w);
    let level = dot(c, vec3f(0.299, 0.587, 0.114));
    c = c * mix(vec3f(1.0), mix(vec3f(0.88, 1.0, 1.14), vec3f(1.07, 1.0, 0.9), smoothstep(0.12, 0.65, level)), tone.w);

    // rain hangs in the air, so the dark is never quite black: a faint cold veil
    c = c + tone.rgb * (1.0 - level) * (1.0 - level);

    // darker towards the corners
    c = c * (1.0 - look.y * smoothstep(0.35, 1.4, length(at)));

    // grain: a new pattern several times a second, a little stronger in the shadows
    let cell = floor(pcPosition.xy / grain.x);
    let frame = floor(look.w * grain.y);
    let n = postHash(cell + frame * 7.31) + postHash(cell * 1.37 + frame * 3.17) - 1.0;
    c = c + n * look.z * (1.25 - 0.85 * clamp(level, 0.0, 1.0));

    output.color = vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
    return output;
}
`;

// a full-screen pass: a fragment shader, and a function that gives it its inputs when it runs
export class QuadPass extends pc.RenderPassShaderQuad {
    constructor(device, name, fragmentGLSL, fragmentWGSL, feed) {
        super(device);
        this.shader = pc.ShaderUtils.createShader(device, {
            uniqueName: name,
            attributes: { aPosition: pc.SEMANTIC_POSITION },
            vertexGLSL: VERT_GLSL,
            fragmentGLSL,
            vertexWGSL: VERT_WGSL,
            fragmentWGSL
        });
        this.feed = feed;
        this.put = (uniform, value) => device.scope.resolve(uniform).setValue(value);
    }

    execute() {
        this.feed(this.put);
        super.execute();
    }
}

/**
 * @param {object} o - What the effects are applied to.
 * @param {pc.AppBase} o.app - The app.
 * @param {pc.Entity} o.camera - Main camera: from now on it draws into a texture.
 * @returns {object} Settings, setEnabled(on) and the pieces made.
 */
export function createPost({ app, camera }) {
    const settings = {
        glow: 0.8,              // strength of the glow
        threshold: 0.25,        // linear brightness above which a thing glows
        knee: 0.2,              // how gradually it starts
        contrast: 0.06,         // 0 leaves the tones alone, 1 is a full S-curve (which buries a dark scene)
        toning: 0.45,           // cool shadows and warm highlights
        veil: [0.010, 0.016, 0.030],    // what is left in the dark, on screen (1 is white)
        fringe: 0.0025,         // how far red and blue part at the middle of an edge, in half-widths
        vignette: 0.5,          // how much darker the corners are
        grain: 0.04,            // strength of the grain
        grainSize: 2,           // in device pixels
        grainRate: 24           // new patterns a second
    };
    const device = app.graphicsDevice;
    // the glow is kept in half floats, so that it can be brighter than white; the picture itself is
    // kept in eight bits, exactly as the screen would hold it (with the picture in half floats too,
    // a close-up, where large splats overlap many times, ran about a quarter slower)
    const glowFormat = device.textureHalfFloatRenderable ? pc.PIXELFORMAT_RGBA16F : pc.PIXELFORMAT_RGBA8;
    const texture = (name, format = glowFormat) => new pc.Texture(device, {
        name,
        width: 4,
        height: 4,
        format,
        mipmaps: false,
        minFilter: pc.FILTER_LINEAR,
        magFilter: pc.FILTER_LINEAR,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE,
        addressV: pc.ADDRESS_CLAMP_TO_EDGE
    });

    // the camera draws the scene here, just as it would to the screen
    const scene = texture('PostScene', pc.PIXELFORMAT_RGBA8);
    const sceneTarget = new pc.RenderTarget({ colorBuffer: scene, depth: true });
    camera.camera.renderTarget = sceneTarget;
    const fit = () => {
        const w = Math.max(4, device.width), h = Math.max(4, device.height);
        if (sceneTarget.width !== w || sceneTarget.height !== h) sceneTarget.resize(w, h);
    };
    fit();
    app.on('update', fit);

    const target = name => new pc.RenderTarget({ colorBuffer: texture(name), depth: false });
    const quarter = [target('PostQuarterA'), target('PostQuarterB')];
    const eighth = [target('PostEighthA'), target('PostEighthB')];
    const sixteenth = [target('PostSixteenthA'), target('PostSixteenthB')];

    let time = 0;
    app.on('update', (dt) => { time += dt; });

    const passes = [];
    const add = (name, glsl, wgsl, into, scale, feed) => {
        const pass = new QuadPass(device, name, glsl, wgsl, feed);
        pass.init(into, into ? { resizeSource: scene, scaleX: scale, scaleY: scale } : undefined);
        passes.push(pass);
        return pass;
    };
    const blur = (from, into, scale, x, y) => add('PostBlur', BLUR_GLSL, BLUR_WGSL, into, scale, (put) => {
        put('postSource', from.colorBuffer);
        put('uPostBlur', [x / from.width, y / from.height, 0, 0]);
    });

    add('PostBright', BRIGHT_GLSL, BRIGHT_WGSL, quarter[0], 0.25, (put) => {
        put('postSource', scene);
        put('uPostBright', [1 / scene.width, 1 / scene.height, settings.threshold, settings.knee]);
    });
    // tightly, at a quarter of the size
    blur(quarter[0], quarter[1], 0.25, 1, 0);
    blur(quarter[1], quarter[0], 0.25, 0, 1);
    // and widely, at an eighth: the taps are twice as far apart on the way down
    blur(quarter[0], eighth[0], 0.125, 2, 0);
    blur(eighth[0], eighth[1], 0.125, 0, 1);
    // and as a haze, at a sixteenth, blurred twice over
    blur(eighth[1], sixteenth[0], 0.0625, 2, 0);
    blur(sixteenth[0], sixteenth[1], 0.0625, 0, 1);
    blur(sixteenth[1], sixteenth[0], 0.0625, 1.5, 0);
    blur(sixteenth[0], sixteenth[1], 0.0625, 0, 1.5);

    add('PostFinish', FINISH_GLSL, FINISH_WGSL, null, 1, (put) => {
        put('postSource', scene);
        put('postGlowTight', quarter[0].colorBuffer);
        put('postGlowWide', eighth[1].colorBuffer);
        put('postGlowHaze', sixteenth[1].colorBuffer);
        put('uPostLook', [settings.glow, settings.vignette, settings.grain, time]);
        put('uPostGrain', [settings.grainSize, settings.grainRate, settings.fringe, settings.contrast]);
        put('uPostTone', [settings.veil[0], settings.veil[1], settings.veil[2], settings.toning]);
    });

    // a second camera owns no geometry: it only runs the passes, the last of them into the canvas
    const layer = new pc.Layer({ name: 'Post' });
    app.scene.layers.push(layer);
    const finisher = new pc.Entity('post');
    finisher.addComponent('camera', { priority: 1, layers: [layer.id], clearColorBuffer: false, clearDepthBuffer: false });
    app.root.addChild(finisher);
    finisher.camera.framePasses = passes;

    // off: the camera draws straight to the screen again, and the passes do not run
    let enabled = true;
    const setEnabled = (on) => {
        enabled = on;
        camera.camera.renderTarget = on ? sceneTarget : null;
        finisher.enabled = on;
    };

    return { settings, scene, sceneTarget, passes, finisher, setEnabled, get enabled() { return enabled; } };
}
