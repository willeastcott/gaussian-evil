// Rain: streaks that only show where the torch beam catches them.
//
// The drops are a single mesh of thin quads, not splats: a splat is tinted by the lighting of
// whatever figure is behind it on screen (see the relighting script), which is wrong for a drop in
// mid air. Each drop is lit in its vertex shader from its own position against the torch's cone,
// so the beam picks a shaft of rain out of the dark. Drops fall through a fixed box around the
// figures and wrap from the floor back to the top, so there is nothing to simulate or upload.
//
// Drawn additively on its own layer after the splats. Drops are not hidden behind the figures
// (splats write no depth), nor shadowed by them; a lit streak looks the same in front or behind.
//
// Because a drop's path is a pure function of its seed and the time, so is the place and moment
// it hits the ground. The snippets exported here let other shaders (src/splash.js) work that out
// for the same drops, and light things against the same torch.
import * as pc from 'playcanvas';

// where and when a drop last hit the ground
export const RAIN_LANDING_GLSL = /* glsl */`
uniform float uRainTime;
uniform vec4 uRainBox;      // half width, height, half depth, streak length (m)
uniform vec4 uRainFall;     // wind x, fall speed (m/s), wind z, streak width (m)

// xy: where on the ground (x, z); z: seconds since; w: which lap of the box that drop was on
vec4 rainLanding(vec3 seed, float speedFactor) {
    float speed = uRainFall.y * speedFactor;
    float fallen = uRainTime * speed + seed.y;
    float lap = floor(fallen / uRainBox.y);
    vec2 drift = uRainFall.xz * uRainBox.y / uRainFall.y;
    return vec4(
        mod(seed.x + drift.x + (lap - 1.0) * 1.618 + uRainBox.x, 2.0 * uRainBox.x) - uRainBox.x,
        mod(seed.z + drift.y + (lap - 1.0) * 2.414 + uRainBox.z, 2.0 * uRainBox.z) - uRainBox.z,
        (fallen - lap * uRainBox.y) / speed,
        lap);
}
`;

export const RAIN_LANDING_WGSL = /* wgsl */`
uniform uRainTime: f32;
uniform uRainBox: vec4f;      // half width, height, half depth, streak length (m)
uniform uRainFall: vec4f;     // wind x, fall speed (m/s), wind z, streak width (m)

fn rainWrap(x: f32, size: f32) -> f32 {
    return x - size * floor(x / size);
}

// xy: where on the ground (x, z); z: seconds since; w: which lap of the box that drop was on
fn rainLanding(seed: vec3f, speedFactor: f32) -> vec4f {
    let box = uniform.uRainBox;
    let fall = uniform.uRainFall;
    let speed = fall.y * speedFactor;
    let fallen = uniform.uRainTime * speed + seed.y;
    let lap = floor(fallen / box.y);
    let drift = fall.xz * box.y / fall.y;
    return vec4f(
        rainWrap(seed.x + drift.x + (lap - 1.0) * 1.618 + box.x, 2.0 * box.x) - box.x,
        rainWrap(seed.z + drift.y + (lap - 1.0) * 2.414 + box.z, 2.0 * box.z) - box.z,
        (fallen - lap * box.y) / speed,
        lap);
}
`;

// how brightly the torch lights a point in mid air
export const TORCH_GLSL = /* glsl */`
uniform vec3 uTorchPos;
uniform vec3 uTorchDir;
uniform vec4 uTorchCone;    // cos inner, cos outer, range, intensity

float torchLight(vec3 p) {
    vec3 to = p - uTorchPos;
    float dist = length(to);
    float cone = smoothstep(uTorchCone.y, uTorchCone.x, dot(to / dist, uTorchDir));
    float reach = clamp(1.0 - dist / uTorchCone.z, 0.0, 1.0);
    return uTorchCone.w * cone * reach * reach;
}

// the same for the lamp that stands behind the pair (src/lamp.js)
uniform vec3 uLampPos;
uniform vec3 uLampDir;
uniform vec4 uLampCone;     // cos inner, cos outer, range, intensity

float lampLight(vec3 p) {
    vec3 to = p - uLampPos;
    float dist = length(to);
    float cone = smoothstep(uLampCone.y, uLampCone.x, dot(to / dist, uLampDir));
    float reach = clamp(1.0 - dist / uLampCone.z, 0.0, 1.0);
    return uLampCone.w * cone * reach * reach;
}
`;

export const TORCH_WGSL = /* wgsl */`
uniform uTorchPos: vec3f;
uniform uTorchDir: vec3f;
uniform uTorchCone: vec4f;    // cos inner, cos outer, range, intensity

fn torchLight(p: vec3f) -> f32 {
    let to = p - uniform.uTorchPos;
    let dist = length(to);
    let cone = smoothstep(uniform.uTorchCone.y, uniform.uTorchCone.x, dot(to / dist, uniform.uTorchDir));
    let reach = clamp(1.0 - dist / uniform.uTorchCone.z, 0.0, 1.0);
    return uniform.uTorchCone.w * cone * reach * reach;
}

// the same for the lamp that stands behind the pair (src/lamp.js)
uniform uLampPos: vec3f;
uniform uLampDir: vec3f;
uniform uLampCone: vec4f;     // cos inner, cos outer, range, intensity

fn lampLight(p: vec3f) -> f32 {
    let to = p - uniform.uLampPos;
    let dist = length(to);
    let cone = smoothstep(uniform.uLampCone.y, uniform.uLampCone.x, dot(to / dist, uniform.uLampDir));
    let reach = clamp(1.0 - dist / uniform.uLampCone.z, 0.0, 1.0);
    return uniform.uLampCone.w * cone * reach * reach;
}
`;

const VERT_GLSL = /* glsl */`
attribute vec4 vertex_position;     // where in the box the drop starts
attribute vec3 vertex_normal;       // per drop: speed factor, brightness factor, spare
attribute vec2 vertex_texCoord0;    // corner of the streak: across (-1..1), along (0..1)

uniform mat4 matrix_viewProjection;
uniform float uRainTime;
uniform vec3 uRainEye;
uniform vec4 uRainBox;      // half width, height, half depth, streak length (m)
uniform vec4 uRainFall;     // wind x, fall speed (m/s), wind z, streak width (m)
${TORCH_GLSL}
varying vec4 vShade;        // across, along, brightness from the torch, and from a flash
varying float vLamp;        // brightness from the lamp

void main(void) {
    float speed = uRainFall.y * vertex_normal.x;
    vec3 seed = vertex_position.xyz;

    // fall, wrapping from the floor back to the top of the box; the wind carries the drop sideways
    float fallen = uRainTime * speed + seed.y;
    float y = uRainBox.y - mod(fallen, uRainBox.y);
    float lap = floor(fallen / uRainBox.y);
    vec2 drift = uRainFall.xz * (uRainBox.y - y) / uRainFall.y;
    vec3 base = vec3(
        mod(seed.x + drift.x + lap * 1.618 + uRainBox.x, 2.0 * uRainBox.x) - uRainBox.x,
        y,
        mod(seed.z + drift.y + lap * 2.414 + uRainBox.z, 2.0 * uRainBox.z) - uRainBox.z);

    // a streak along the direction of travel, turned to face the eye
    vec3 along = normalize(vec3(uRainFall.x, -uRainFall.y, uRainFall.z));
    vec3 across = normalize(cross(along, uRainEye - base));
    vec3 pos = base - along * (uRainBox.w * vertex_texCoord0.y) + across * (uRainFall.w * vertex_texCoord0.x);
    pos.y = max(pos.y, 0.0);

    gl_Position = matrix_viewProjection * vec4(pos, 1.0);
    vShade = vec4(vertex_texCoord0, torchLight(base) * vertex_normal.y, vertex_normal.y);
    vLamp = lampLight(base) * vertex_normal.y;
}
`;

// a soft-edged streak in the torch's colour; shared with the splash droplets
export const STREAK_FRAG_GLSL = /* glsl */`
uniform vec3 uTorchColor;
uniform vec3 uFlashColor;   // lightning: lights every drop, wherever it is
uniform vec3 uLampColor;
varying vec4 vShade;
varying float vLamp;

void main(void) {
    float edge = 1.0 - vShade.x * vShade.x;
    float tail = sin(vShade.y * 3.14159);
    gl_FragColor = vec4((uTorchColor * vShade.z + uLampColor * vLamp + uFlashColor * vShade.w) * (edge * tail), 1.0);
}
`;

const VERT_WGSL = /* wgsl */`
attribute vertex_position: vec4f;     // where in the box the drop starts
attribute vertex_normal: vec3f;       // per drop: speed factor, brightness factor, spare
attribute vertex_texCoord0: vec2f;    // corner of the streak: across (-1..1), along (0..1)

uniform matrix_viewProjection: mat4x4f;
uniform uRainTime: f32;
uniform uRainEye: vec3f;
uniform uRainBox: vec4f;      // half width, height, half depth, streak length (m)
uniform uRainFall: vec4f;     // wind x, fall speed (m/s), wind z, streak width (m)
${TORCH_WGSL}
varying vShade: vec4f;        // across, along, brightness from the torch, and from a flash
varying vLamp: f32;           // brightness from the lamp

fn wrap(x: f32, size: f32) -> f32 {
    return x - size * floor(x / size);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    let box = uniform.uRainBox;
    let fall = uniform.uRainFall;
    let speed = fall.y * vertex_normal.x;
    let seed = vertex_position.xyz;

    // fall, wrapping from the floor back to the top of the box; the wind carries the drop sideways
    let fallen = uniform.uRainTime * speed + seed.y;
    let y = box.y - wrap(fallen, box.y);
    let lap = floor(fallen / box.y);
    let drift = fall.xz * (box.y - y) / fall.y;
    let base = vec3f(
        wrap(seed.x + drift.x + lap * 1.618 + box.x, 2.0 * box.x) - box.x,
        y,
        wrap(seed.z + drift.y + lap * 2.414 + box.z, 2.0 * box.z) - box.z);

    // a streak along the direction of travel, turned to face the eye
    let along = normalize(vec3f(fall.x, -fall.y, fall.z));
    let across = normalize(cross(along, uniform.uRainEye - base));
    var pos = base - along * (box.w * vertex_texCoord0.y) + across * (fall.w * vertex_texCoord0.x);
    pos.y = max(pos.y, 0.0);

    output.position = uniform.matrix_viewProjection * vec4f(pos, 1.0);
    output.vShade = vec4f(vertex_texCoord0, torchLight(base) * vertex_normal.y, vertex_normal.y);
    output.vLamp = lampLight(base) * vertex_normal.y;
    return output;
}
`;

export const STREAK_FRAG_WGSL = /* wgsl */`
uniform uTorchColor: vec3f;
uniform uFlashColor: vec3f;   // lightning: lights every drop, wherever it is
uniform uLampColor: vec3f;
varying vShade: vec4f;
varying vLamp: f32;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let edge = 1.0 - input.vShade.x * input.vShade.x;
    let tail = sin(input.vShade.y * 3.14159);
    output.color = vec4f((uniform.uTorchColor * input.vShade.z + uniform.uLampColor * input.vLamp + uniform.uFlashColor * input.vShade.w) * (edge * tail), 1.0);
    return output;
}
`;

/**
 * A mesh of quads, several per drop, whose corners all carry the drop's seed.
 *
 * @param {pc.GraphicsDevice} device - The device.
 * @param {Float32Array} seeds - Five numbers per drop: x, y, z, speed factor, brightness factor.
 * @param {number} perDrop - Quads per drop; the quad's index goes in the normal's third component.
 * @param {number[][]} corners - The four corners, as texture coordinates.
 * @param {pc.BoundingBox} aabb - Everything moves in the shader, so the bounds are given.
 * @returns {pc.Mesh} The mesh.
 */
export function createSeededQuads(device, seeds, perDrop, corners, aabb) {
    const n = (seeds.length / 5) * perDrop;
    const positions = new Float32Array(n * 12), normals = new Float32Array(n * 12), uvs = new Float32Array(n * 8);
    const indices = new Uint32Array(n * 6);
    for (let q = 0; q < n; q++) {
        const s = Math.floor(q / perDrop) * 5;
        for (let c = 0; c < 4; c++) {
            positions.set([seeds[s], seeds[s + 1], seeds[s + 2]], (q * 4 + c) * 3);
            normals.set([seeds[s + 3], seeds[s + 4], q % perDrop], (q * 4 + c) * 3);
            uvs.set(corners[c], (q * 4 + c) * 2);
        }
        indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    }
    const mesh = new pc.Mesh(device);
    mesh.setPositions(positions);
    mesh.setNormals(normals);
    mesh.setUvs(0, uvs);
    mesh.setIndices(indices);
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    mesh.aabb = aabb;
    return mesh;
}

/**
 * @param {string} name - Unique name of the shader.
 * @param {object} sources - vertexGLSL, fragmentGLSL, vertexWGSL, fragmentWGSL.
 * @returns {pc.ShaderMaterial} An additive material that ignores depth.
 */
export function createGlowMaterial(name, sources) {
    const material = new pc.ShaderMaterial({
        uniqueName: name,
        ...sources,
        attributes: {
            vertex_position: pc.SEMANTIC_POSITION,
            vertex_normal: pc.SEMANTIC_NORMAL,
            vertex_texCoord0: pc.SEMANTIC_TEXCOORD0
        }
    });
    material.blendType = pc.BLEND_ADDITIVE;
    material.depthWrite = false;
    material.depthTest = false;
    material.cull = pc.CULLFACE_NONE;
    material.update();
    return material;
}

/**
 * @param {object} o - What the rain needs.
 * @param {pc.AppBase} o.app - The app.
 * @param {pc.Entity} o.camera - Main camera.
 * @param {pc.Entity} o.torch - The torch.
 * @param {pc.Vec3} o.aim - Point the torch is aimed at, updated by the caller.
 * @returns {object} Settings, the entity made, the drops' seeds, and the list of materials that
 * are given the rain and torch uniforms each frame (others may add theirs).
 */
export function createRain({ app, camera, torch, aim }) {
    const settings = {
        count: 4500,
        halfWidth: 4,       // the box of rain: 8 m square and 5 m tall, centred on the figures
        height: 5,
        speed: 8,           // m/s
        wind: new pc.Vec2(0.5, 0.87).mulScalar(0.9),    // m/s sideways, the same way the hair blows
        streak: 0.18,       // m: how far a drop travels while the shutter is open
        width: 0.003,       // m
        brightness: 0.35,
        flash: [0, 0, 0],   // light on every drop from lightning; src/lightning.js sets it
        night: [0.012, 0.014, 0.019],   // and from the night itself: very little, but the dark is not empty
        // the lamp behind the pair: where it is, which way it points, its cone, its colour. src/lamp.js sets it
        lamp: { position: [0, 10, 0], direction: [0, -1, 0], cone: [0.9, 0.8, 1, 0], color: [0, 0, 0] }
    };

    const seeds = new Float32Array(settings.count * 5);
    for (let i = 0; i < settings.count; i++) {
        seeds.set([
            (Math.random() * 2 - 1) * settings.halfWidth, Math.random() * settings.height, (Math.random() * 2 - 1) * settings.halfWidth,
            0.8 + Math.random() * 0.4, 0.4 + Math.random() * 0.6
        ], i * 5);
    }
    // the drops move in the shader, anywhere in the box
    const aabb = new pc.BoundingBox(new pc.Vec3(0, settings.height / 2, 0), new pc.Vec3(settings.halfWidth + 1, settings.height / 2 + 1, settings.halfWidth + 1));
    const mesh = createSeededQuads(app.graphicsDevice, seeds, 1, [[-1, 0], [1, 0], [1, 1], [-1, 1]], aabb);

    const material = createGlowMaterial('RainShader', {
        vertexGLSL: VERT_GLSL,
        fragmentGLSL: STREAK_FRAG_GLSL,
        vertexWGSL: VERT_WGSL,
        fragmentWGSL: STREAK_FRAG_WGSL
    });

    // a layer after everything else, so the streaks land on top of the splats
    const layer = new pc.Layer({ name: 'Rain' });
    app.scene.layers.push(layer);
    camera.camera.layers = [...camera.camera.layers, layer.id];

    const entity = new pc.Entity('rain');
    entity.addComponent('render', {
        meshInstances: [new pc.MeshInstance(mesh, material)],
        layers: [layer.id],
        castShadows: false,
        receiveShadows: false
    });
    app.root.addChild(entity);

    const materials = [material];
    let time = 0;
    const dir = new pc.Vec3();
    app.on('update', (dt) => {
        time += dt;
        const light = torch.light, eye = camera.getPosition(), p = torch.getPosition();
        dir.sub2(aim, p).normalize();
        const cone = [
            Math.cos(light.innerConeAngle * pc.math.DEG_TO_RAD), Math.cos(light.outerConeAngle * pc.math.DEG_TO_RAD),
            light.range, light.intensity * settings.brightness
        ];
        const everywhere = settings.flash.map((c, i) => c + settings.night[i]);
        const lamp = settings.lamp;
        for (const m of materials) {
            m.setParameter('uRainTime', time);
            m.setParameter('uRainEye', [eye.x, eye.y, eye.z]);
            m.setParameter('uRainBox', [settings.halfWidth, settings.height, settings.halfWidth, settings.streak]);
            m.setParameter('uRainFall', [settings.wind.x, settings.speed, settings.wind.y, settings.width]);
            m.setParameter('uTorchPos', [p.x, p.y, p.z]);
            m.setParameter('uTorchDir', [dir.x, dir.y, dir.z]);
            m.setParameter('uTorchCone', cone);
            m.setParameter('uTorchColor', [light.color.r, light.color.g, light.color.b]);
            m.setParameter('uFlashColor', everywhere);
            m.setParameter('uLampPos', lamp.position);
            m.setParameter('uLampDir', lamp.direction);
            m.setParameter('uLampCone', lamp.cone);
            m.setParameter('uLampColor', lamp.color);
        }
    });

    return { settings, entity, material, layer, seeds, aabb, materials };
}
