// Spray: what rain does where it lands on the two of them.
//
// The drops (src/rain.js) fall straight through the figures, which are splats and stop nothing.
// The eye does not notice that. What it does notice is rain bursting off a head, a shoulder, a
// forearm, the top of a pistol: a fine spray along every edge that faces the sky is most of what
// says somebody is standing in the rain, not in front of a picture of it.
//
// So the places where rain would land are found once, from the mesh of the figures' surface
// (the one that casts the shadows): every point of it that faces upwards, above the knee. A few
// hundred of them are picked, and each is struck over and over, at its own rate and from its own
// moment. A strike throws up a few beads of water on short arcs. Like the splashes on the
// ground nothing is simulated: where a bead is at any time is worked out from the place, the
// strike and the bead.
//
// The beads are drawn with the rain and lit like it: dark until the torch, the lamp or the
// lightning finds them. Against the lamp, which is behind the pair, they are an edge of light
// along the head and shoulders.
//
// A bead is a couple of millimetres across: from four metres off, less than a pixel, and it
// would not show. So a bead is never drawn narrower than a part of a pixel, however far away.
//
// It is meant to be a hint. The first version had a thousand places, struck every second, three
// bright beads a time, flaring against the lamp as the rain does: it lit a fiftieth of the
// picture in a close-up, and the two of them fizzed. This is a small fraction of that: fewer
// places, struck less often, two dim beads that barely leave the surface, and less of the flare. Measured, it adds about a fortieth of the light the first version did.
import * as pc from 'playcanvas';

import { STREAK_FRAG_GLSL, STREAK_FRAG_WGSL, TORCH_GLSL, TORCH_WGSL, createGlowMaterial, createSeededQuads } from './rain.js';

const BEADS = 2;        // per strike

const VERT_GLSL = /* glsl */`
attribute vec4 vertex_position;     // a place on one of the figures where rain lands, in world space
attribute vec3 vertex_normal;       // per place: where in its cycle it is struck (0..1), brightness; then which bead
attribute vec2 vertex_texCoord0;    // corner of the bead: across (-1..1), along (0..1)

uniform mat4 matrix_viewProjection;
uniform float uRainTime;
uniform vec3 uRainEye;
uniform vec4 uSpray;        // seconds between strikes at one place, speed up (m/s), speed outwards (m/s), width (m)
uniform vec4 uSprayOn;      // seconds a bead is seen for, shutter time (s), brightness, the width of a pixel a metre off (m)
uniform float uSprayFlare;  // how much of the rain's flare against the lamp a bead has, 0..1
${TORCH_GLSL}
varying vec4 vShade;        // across, along, brightness from the torch, and from a flash
varying float vLamp;        // brightness from the lamp

float sprayHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main(void) {
    vec3 site = vertex_position.xyz;
    float k = vertex_normal.z;

    // each place is struck at its own rate, and starts at its own moment
    float every = uSpray.x * (0.6 + 0.8 * sprayHash(site.xz * 91.7 + site.y * 13.3));
    float cycle = uRainTime / every + vertex_normal.x;
    float strike = floor(cycle);
    float tau = fract(cycle) * every;       // seconds since it was last struck

    // each strike, and each bead of it, is thrown differently
    vec2 key = site.xz * 53.1 + vec2(strike * 3.7 + k * 11.3, k * 5.9 - strike * 1.3);
    float h0 = sprayHash(key), h1 = sprayHash(key + 19.19), h2 = sprayHash(key + 47.7);
    float angle = 6.2832 * h0;
    float outward = uSpray.z * (0.3 + h1);
    vec3 vel = vec3(cos(angle) * outward, uSpray.y * (0.45 + 0.55 * h2), sin(angle) * outward);

    vec3 base = site + vel * tau;
    base.y -= 4.9 * tau * tau;
    vec3 v = vel - vec3(0.0, 9.8 * tau, 0.0);

    // a bead smeared along its path by the shutter; at the top of its arc it is nearly a dot.
    // Never narrower than most of a pixel
    float wide = max(uSpray.w, length(uRainEye - base) * uSprayOn.w * 0.45);
    float len = max(length(v) * uSprayOn.y, wide * 2.0);
    vec3 along = normalize(v);
    vec3 across = normalize(cross(along, uRainEye - base));
    vec3 pos = base - along * (len * vertex_texCoord0.y) + across * (wide * vertex_texCoord0.x);

    // seen from the strike until it has had its time, and fading as it goes
    float left = clamp(1.0 - tau / uSprayOn.x, 0.0, 1.0);
    pos = mix(base, pos, step(0.001, left));

    gl_Position = matrix_viewProjection * vec4(pos, 1.0);
    float bright = vertex_normal.y * uSprayOn.z * left;
    vShade = vec4(vertex_texCoord0, torchLight(base) * bright, bright);
    vLamp = lampLight(base) * mix(1.0, lampToward(base, uRainEye), uSprayFlare) * bright;
}
`;

const VERT_WGSL = /* wgsl */`
attribute vertex_position: vec4f;     // a place on one of the figures where rain lands, in world space
attribute vertex_normal: vec3f;       // per place: where in its cycle it is struck (0..1), brightness; then which bead
attribute vertex_texCoord0: vec2f;    // corner of the bead: across (-1..1), along (0..1)

uniform matrix_viewProjection: mat4x4f;
uniform uRainTime: f32;
uniform uRainEye: vec3f;
uniform uSpray: vec4f;        // seconds between strikes at one place, speed up (m/s), speed outwards (m/s), width (m)
uniform uSprayOn: vec4f;      // seconds a bead is seen for, shutter time (s), brightness, the width of a pixel a metre off (m)
uniform uSprayFlare: f32;     // how much of the rain's flare against the lamp a bead has, 0..1
${TORCH_WGSL}
varying vShade: vec4f;        // across, along, brightness from the torch, and from a flash
varying vLamp: f32;           // brightness from the lamp

fn sprayHash(p: vec2f) -> f32 {
    var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    let spray = uniform.uSpray;
    let on = uniform.uSprayOn;
    let site = vertex_position.xyz;
    let k = vertex_normal.z;

    // each place is struck at its own rate, and starts at its own moment
    let every = spray.x * (0.6 + 0.8 * sprayHash(site.xz * 91.7 + site.y * 13.3));
    let cycle = uniform.uRainTime / every + vertex_normal.x;
    let strike = floor(cycle);
    let tau = fract(cycle) * every;       // seconds since it was last struck

    // each strike, and each bead of it, is thrown differently
    let key = site.xz * 53.1 + vec2f(strike * 3.7 + k * 11.3, k * 5.9 - strike * 1.3);
    let h0 = sprayHash(key);
    let h1 = sprayHash(key + 19.19);
    let h2 = sprayHash(key + 47.7);
    let angle = 6.2832 * h0;
    let outward = spray.z * (0.3 + h1);
    let vel = vec3f(cos(angle) * outward, spray.y * (0.45 + 0.55 * h2), sin(angle) * outward);

    var base = site + vel * tau;
    base.y = base.y - 4.9 * tau * tau;
    let v = vel - vec3f(0.0, 9.8 * tau, 0.0);

    // a bead smeared along its path by the shutter; at the top of its arc it is nearly a dot.
    // Never narrower than most of a pixel
    let wide = max(spray.w, length(uniform.uRainEye - base) * on.w * 0.45);
    let len = max(length(v) * on.y, wide * 2.0);
    let along = normalize(v);
    let across = normalize(cross(along, uniform.uRainEye - base));
    var pos = base - along * (len * vertex_texCoord0.y) + across * (wide * vertex_texCoord0.x);

    // seen from the strike until it has had its time, and fading as it goes
    let left = clamp(1.0 - tau / on.x, 0.0, 1.0);
    pos = mix(base, pos, step(0.001, left));

    output.position = uniform.matrix_viewProjection * vec4f(pos, 1.0);
    let bright = vertex_normal.y * on.z * left;
    output.vShade = vec4f(vertex_texCoord0, torchLight(base) * bright, bright);
    output.vLamp = lampLight(base) * mix(1.0, lampToward(base, uniform.uRainEye), uniform.uSprayFlare) * bright;
    return output;
}
`;

/**
 * @param {object} o - What the spray needs.
 * @param {pc.AppBase} o.app - The app.
 * @param {pc.Entity} o.camera - Main camera: how big a pixel is goes by its lens.
 * @param {object} o.rain - From createRain: its layer, its clock, and the lights it hands every material on its list.
 * @param {pc.Mesh} o.mesh - The figures' surface, in the stage's own space.
 * @param {pc.Mat4} o.transform - That space to the world.
 * @returns {object} Settings, the entity and how many places there are.
 */
export function createSpray({ app, camera, rain, mesh, transform }) {
    const settings = {
        places: 350,        // where rain is seen to land
        facing: 0.55,       // how nearly a surface must face the sky to be one (the y of its normal)
        above: 0.75,        // metres: none lower than this (the ground has its own splashes)
        every: 2.4,         // seconds between strikes at one place, about
        up: 0.7,            // m/s: how hard a bead is thrown upwards, at most
        out: 0.3,           // m/s outwards
        life: 0.16,         // seconds a bead is seen for
        shutter: 0.02,      // s: the smear of a moving bead
        width: 0.002,       // m
        brightness: 0.9,    // relative to a rain streak
        flare: 0.6          // how much of the rain's flare against the lamp a bead has
    };

    // every point of the surface that faces the sky
    const positions = [], normals = [];
    mesh.getPositions(positions);
    mesh.getNormals(normals);
    const found = [];
    const p = new pc.Vec3(), n = new pc.Vec3();
    for (let i = 0; i < positions.length; i += 3) {
        transform.transformVector(n.set(normals[i], normals[i + 1], normals[i + 2]), n).normalize();
        if (n.y < settings.facing) continue;
        transform.transformPoint(p.set(positions[i], positions[i + 1], positions[i + 2]), p);
        if (p.y < settings.above) continue;
        // (a little clear of the surface, so that a bead starts outside it)
        found.push(p.x + n.x * 0.006, p.y + n.y * 0.006, p.z + n.z * 0.006);
    }
    const available = found.length / 3, count = Math.min(settings.places, available);
    const seeds = new Float32Array(count * 5);
    for (let i = 0; i < count; i++) {
        const at = Math.floor(Math.random() * available) * 3;
        seeds.set([found[at], found[at + 1], found[at + 2], Math.random(), 0.5 + Math.random() * 0.5], i * 5);
    }

    const material = createGlowMaterial('SprayShader', {
        vertexGLSL: VERT_GLSL,
        fragmentGLSL: STREAK_FRAG_GLSL,
        vertexWGSL: VERT_WGSL,
        fragmentWGSL: STREAK_FRAG_WGSL
    });
    const aabb = new pc.BoundingBox(new pc.Vec3(0, 1.1, 0), new pc.Vec3(1.5, 1.3, 1.5));
    const entity = new pc.Entity('spray');
    entity.addComponent('render', {
        meshInstances: [new pc.MeshInstance(createSeededQuads(app.graphicsDevice, seeds, BEADS, [[-1, 0], [1, 0], [1, 1], [-1, 1]], aabb), material)],
        layers: [rain.layer.id],
        castShadows: false,
        receiveShadows: false
    });
    app.root.addChild(entity);

    // the rain hands it its clock and the lights
    rain.materials.push(material);
    app.on('update', () => {
        material.setParameter('uSpray', [settings.every, settings.up, settings.out, settings.width]);
        const pixel = 2 * Math.tan(camera.camera.fov * 0.5 * pc.math.DEG_TO_RAD) / Math.max(app.graphicsDevice.height, 1);
        material.setParameter('uSprayOn', [settings.life, settings.shutter, settings.brightness, pixel]);
        material.setParameter('uSprayFlare', settings.flare);
    });

    return { settings, entity, material, places: count, available };
}
