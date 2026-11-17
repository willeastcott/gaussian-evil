// Wet floor: a reflection made of splats.
//
// There is no reflection pass. A second, thinned copy of the capture (tools/mirror-ply.mjs),
// mirrored in the floor plane, sits under the floor, and the floor does not write depth, so the
// copy shows through it. A vertex hook on the splat material then treats every splat below the
// floor as a reflection: it fades with depth and with viewing angle, grows (which blurs it, more
// the further the reflected point is from the surface) and slides sideways in slow ripples.
//
// The reflection has to be lit like the real figures, so the proxy mesh is mirrored too, on a
// layer of its own with a mirrored torch, and drawn into the same relighting texture.
//
// This module owns the splat vertex hook, so it also applies the life motion (src/life.js): to
// the real figures directly, and to their reflections mirrored.
import * as pc from 'playcanvas';

import { LIFE_GLSL, LIFE_WGSL } from './life.js';
import { createCasterEntity } from './shadow-caster.js';

const GLSL = /* glsl */`
${LIFE_GLSL}
uniform float uWetTime;
uniform vec3 uWetEye;
uniform vec4 uWetParams;    // reflectivity, fade depth (m), growth per metre, ripple amplitude (m)

void modifySplatCenter(inout vec3 center) {
    float depth = -center.y;

    // life: the reflection moves as the mirror image of the point it reflects
    float side = depth > 0.0 ? -1.0 : 1.0;
    vec3 shift = lifeOffset(vec3(center.x, abs(center.y), center.z), uWetTime);
    center += vec3(shift.x, shift.y * side, shift.z);

    if (depth > 0.0) {
        float a = uWetParams.w * (0.25 + depth);
        float t = uWetTime;
        vec3 c = center;
        center.x = c.x + a * (sin(c.z * 7.0 + depth * 5.0 + t * 1.3) + 0.5 * sin(c.z * 17.0 - c.x * 5.0 + t * 2.1));
        center.z = c.z + a * (sin(c.x * 6.0 - depth * 4.0 + t * 1.1) + 0.5 * sin(c.x * 15.0 + c.z * 6.0 - t * 1.9));
    }
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float depth = -originalCenter.y;
    if (depth > 0.0) {
        scale *= 1.0 + uWetParams.z * depth;
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {
    float depth = -center.y;
    if (depth > 0.0) {
        // the line from the eye to a mirrored point meets the floor at the angle of reflection
        vec3 toEye = uWetEye - center;
        float cosT = clamp(toEye.y / length(toEye), 0.0, 1.0);
        float fresnel = mix(0.3, 1.0, pow(1.0 - cosT, 3.0));
        float grow = 1.0 + uWetParams.z * depth;
        color.a *= uWetParams.x * fresnel * exp(-depth / uWetParams.y) / grow;
    }
}
`;

const WGSL = /* wgsl */`
${LIFE_WGSL}
uniform uWetTime: f32;
uniform uWetEye: vec3f;
uniform uWetParams: vec4f;    // reflectivity, fade depth (m), growth per metre, ripple amplitude (m)

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let c0 = *center;
    let depth = -c0.y;

    // life: the reflection moves as the mirror image of the point it reflects
    let side = select(1.0, -1.0, depth > 0.0);
    let shift = lifeOffset(vec3f(c0.x, abs(c0.y), c0.z), uniform.uWetTime);
    let c = c0 + vec3f(shift.x, shift.y * side, shift.z);
    *center = c;

    if (depth > 0.0) {
        let a = uniform.uWetParams.w * (0.25 + depth);
        let t = uniform.uWetTime;
        (*center).x = c.x + a * (sin(c.z * 7.0 + depth * 5.0 + t * 1.3) + 0.5 * sin(c.z * 17.0 - c.x * 5.0 + t * 2.1));
        (*center).z = c.z + a * (sin(c.x * 6.0 - depth * 4.0 + t * 1.1) + 0.5 * sin(c.x * 15.0 + c.z * 6.0 - t * 1.9));
    }
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let depth = -originalCenter.y;
    if (depth > 0.0) {
        *scale = *scale * (1.0 + uniform.uWetParams.z * depth);
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let depth = -center.y;
    if (depth > 0.0) {
        // the line from the eye to a mirrored point meets the floor at the angle of reflection
        let toEye = uniform.uWetEye - center;
        let cosT = clamp(toEye.y / length(toEye), 0.0, 1.0);
        let fresnel = mix(0.3, 1.0, pow(1.0 - cosT, 3.0));
        let grow = 1.0 + uniform.uWetParams.z * depth;
        (*color).a = (*color).a * uniform.uWetParams.x * fresnel * exp(-depth / uniform.uWetParams.y) / grow;
    }
}
`;

/**
 * @param {object} o - What the reflection hangs off.
 * @param {pc.AppBase} o.app - The app.
 * @param {pc.Entity} o.stage - Parent of the capture, in PLY space.
 * @param {number} o.plyFloorY - Height of the floor in PLY space.
 * @param {pc.Asset} o.mirrorAsset - The mirrored splat.
 * @param {pc.Asset} o.proxyAsset - The proxy mesh container.
 * @param {pc.Material} o.proxyMaterial - Material of the proxy mesh.
 * @param {pc.Mesh} o.casterMesh - The slim copy of the proxy mesh that casts its shadows.
 * @param {pc.Entity} o.camera - Main camera, carrying the relighting script.
 * @param {pc.Layer} o.relightLayer - Layer of the real proxy mesh.
 * @param {pc.Layer} o.reflectionLayer - Layer drawn before the ground, for the reflected figures.
 * @param {pc.Entity} o.torch - The real torch.
 * @param {pc.Vec3} o.aim - Point the real torch is aimed at, updated by the caller.
 * @returns {object} Settings and the entities made.
 */
export function createWetFloor({ app, stage, plyFloorY, mirrorAsset, proxyAsset, proxyMaterial, casterMesh, camera, relightLayer, reflectionLayer, torch, aim }) {
    const settings = {
        reflectivity: 1,
        fadeDepth: 1.6,     // metres below the surface at which the reflection has faded to 1/e
        growth: 0.55,       // splat growth per metre of depth: the blur
        ripple: 0.006,      // metres of sideways slide at the surface
        life: 1             // amount of breathing, weight shifting and wind (src/life.js)
    };

    // the reflected figures
    const mirror = new pc.Entity('mirror');
    mirror.addComponent('gsplat', { asset: mirrorAsset, unified: true, layers: [reflectionLayer.id] });
    stage.addChild(mirror);

    // their lighting: a mirrored proxy mesh under a mirrored torch, kept apart from the real pair
    // by living on a layer of its own, and drawn into the same relighting texture
    const mirrorLayer = new pc.Layer({ name: 'RelightingMirror' });
    app.scene.layers.push(mirrorLayer);
    camera.findByName('RelightingCamera').camera.layers = [relightLayer.id, mirrorLayer.id];

    const mirrorProxy = proxyAsset.resource.instantiateRenderEntity();
    mirrorProxy.findComponents('render').forEach((render) => {
        render.layers = [mirrorLayer.id];
        render.castShadows = false;
        render.meshInstances.forEach((mi) => { mi.material = proxyMaterial; });
    });
    mirrorProxy.setLocalScale(1, -1, 1);
    mirrorProxy.setLocalPosition(0, 2 * plyFloorY, 0);
    stage.addChild(mirrorProxy);

    // as with the real pair, the fat proxy only receives: its shadows come from the slim copy
    const mirrorCasterLayer = new pc.Layer({ name: 'RelightingMirrorCasters' });
    app.scene.layers.push(mirrorCasterLayer);
    const mirrorCaster = createCasterEntity(casterMesh, proxyMaterial, [mirrorCasterLayer.id]);
    mirrorCaster.setLocalScale(1, -1, 1);
    mirrorCaster.setLocalPosition(0, 2 * plyFloorY, 0);
    stage.addChild(mirrorCaster);

    const light = torch.light;
    const mirrorTorch = new pc.Entity('torch-mirror');
    mirrorTorch.addComponent('light', {
        type: 'spot',
        castShadows: true,
        shadowType: light.shadowType,
        shadowResolution: 1024,
        shadowBias: light.shadowBias,
        normalOffsetBias: light.normalOffsetBias,
        layers: [mirrorLayer.id, mirrorCasterLayer.id]
    });
    app.root.addChild(mirrorTorch);

    const material = app.scene.gsplat.material;
    material.getShaderChunks(app.graphicsDevice.isWebGPU ? pc.SHADERLANGUAGE_WGSL : pc.SHADERLANGUAGE_GLSL)
        .set('gsplatModifyVS', app.graphicsDevice.isWebGPU ? WGSL : GLSL);

    let time = 0;
    const tmp = new pc.Vec3();
    app.on('update', (dt) => {
        time += dt;

        const p = torch.getPosition();
        mirrorTorch.setPosition(p.x, -p.y, p.z);
        mirrorTorch.lookAt(tmp.set(aim.x, -aim.y, aim.z));
        mirrorTorch.rotateLocal(90, 0, 0);
        const m = mirrorTorch.light;
        m.color = light.color;
        m.intensity = light.intensity;
        m.range = light.range;
        m.innerConeAngle = light.innerConeAngle;
        m.outerConeAngle = light.outerConeAngle;

        const eye = camera.getPosition();
        material.setParameter('uWetTime', time);
        material.setParameter('uLife', settings.life);
        material.setParameter('uWetEye', [eye.x, eye.y, eye.z]);
        material.setParameter('uWetParams', [settings.reflectivity, settings.fadeDepth, settings.growth, settings.ripple]);
        material.update();
    });

    return { settings, mirror, mirrorProxy, mirrorCaster, mirrorTorch, mirrorLayer, mirrorCasterLayer };
}
