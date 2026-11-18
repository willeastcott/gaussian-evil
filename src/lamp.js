// A lamp on a short mast, a few metres behind the pair.
//
// Without it the scene is two lit figures in a black void: nothing says where they are, and when
// the torch is elsewhere nothing shows at all. The lamp is a second light that is always there.
// It is cold where the torch is warm, it comes from behind, so it draws an edge of light round
// the two of them and throws their shadows towards the camera, and the rain falling through its
// beam can be seen whatever the torch is doing.
//
// It is an ordinary spot light on the same layers as the torch, so it lights the proxy mesh (and
// through it the splats) and the ground. Its shadow map is drawn once: neither it nor the mesh
// that casts the shadows ever moves. A mirrored twin lights the reflections. The rain and the
// mist are lit in their own shaders, so they are told where the lamp is (src/rain.js), and so is
// the ground, which mirrors the lamp itself as a streak of light (src/ground.js).
//
// A bare lit rectangle in the dark looks like a sign, not a light. So a soft halo is drawn about
// the lens, turned to face the camera: the glare of a lamp seen through rain.
//
// It stands this close because the rain is a box 8 m square about the pair: further off, there
// would be no rain in its beam.
//
// It flickers: mostly steady, and every few seconds a short stutter. The dips come at most six a
// second and usually far fewer, the lamp is a small part of the picture, and with
// prefers-reduced-motion it burns steadily.
import * as pc from 'playcanvas';

const hash = (n) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
};

/**
 * How brightly the lamp burns at a moment: 1, but for the stutters.
 *
 * @param {number} t - Seconds.
 * @returns {number} 0.15 .. 1.
 */
export function flicker(t) {
    // a slow wander of a few per cent
    let level = 0.96 + 0.04 * Math.sin(t * 2.3) * Math.sin(t * 0.71);
    // in two windows out of three, of five seconds each, a stutter lasting most of a second
    const window = Math.floor(t / 5), within = t / 5 - window;
    const starts = 0.1 + 0.7 * hash(window);
    if (hash(window + 7.3) > 0.34 && within > starts && within < starts + 0.16) {
        const cell = Math.floor(t * 6);
        if (hash(cell + 0.5) > 0.5) level *= 0.15 + 0.45 * hash(cell + 9.1);
    }
    return level;
}

/**
 * @param {object} o - Where the lamp's light goes.
 * @param {pc.AppBase} o.app - The app.
 * @param {object|null} o.rain - From createRain: its drops and the mist are lit by the lamp too.
 * @param {number[]} o.layers - Layers the lamp lights and takes its shadows from.
 * @param {number[]|null} o.mirrorLayers - The same for the reflected figures, if there are any.
 * @param {object|null} o.ground - From createGround: the wet ground mirrors the lamp.
 * @param {pc.Entity} o.camera - Main camera: the halo is turned to it.
 * @param {pc.Layer} o.glowLayer - A layer drawn before the figures, so that they hide the halo.
 * @returns {object} Settings, and the entities made.
 */
export function createLamp({ app, rain, ground, layers, mirrorLayers, camera, glowLayer }) {
    const settings = {
        base: new pc.Vec3(-1.9, 0, -3.9),       // the foot of the mast: behind them, a little to one side
        height: 3.0,
        arm: 0.45,                              // metres the head stands out from the mast, towards them
        target: new pc.Vec3(-0.6, 0, -1.2),     // the spot on the ground the lamp is turned to
        color: new pc.Color(0.6, 0.95, 0.82),   // a cold, slightly green white
        intensity: 0.5,                         // the torch is 1.6
        range: 12,
        inner: 24,                              // degrees: the cone
        outer: 44,
        drops: 0.5,                             // how brightly it lights rain and mist, against how it lights a surface
        glow: 1.6,                              // of the lens itself
        halo: 0.55,                             // of the glare about it
        haloSize: 2.2,                          // metres across
        mirrored: 1.3,                          // the brightest its image gets in the wet ground
        mirroredStrength: 24,                   // and how strongly that image shows: more reaches further over rough ground
        flicker: 1                              // 0 for a steady lamp
    };
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const metal = new pc.StandardMaterial();
    metal.diffuse = new pc.Color(0.05, 0.055, 0.06);
    metal.gloss = 0.35;
    metal.update();
    const lensMaterial = new pc.StandardMaterial();
    lensMaterial.useLighting = false;
    lensMaterial.diffuse = new pc.Color(0, 0, 0);
    lensMaterial.emissive = settings.color;
    lensMaterial.emissiveIntensity = settings.glow;
    lensMaterial.update();

    // the halo: bright at the middle, and falling away fast
    const spot = document.createElement('canvas');
    spot.width = spot.height = 128;
    const g = spot.getContext('2d');
    const fall = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (const [at, v] of [[0, 255], [0.06, 150], [0.16, 62], [0.36, 20], [0.66, 5], [1, 0]]) fall.addColorStop(at, `rgb(${v}, ${v}, ${v})`);
    g.fillStyle = fall;
    g.fillRect(0, 0, 128, 128);
    const spotTexture = new pc.Texture(app.graphicsDevice, { width: 128, height: 128, format: pc.PIXELFORMAT_RGBA8, mipmaps: true });
    spotTexture.setSource(spot);
    const haloMaterial = new pc.StandardMaterial();
    haloMaterial.useLighting = false;
    haloMaterial.useFog = false;
    haloMaterial.diffuse = new pc.Color(0, 0, 0);
    haloMaterial.emissive = settings.color;
    haloMaterial.emissiveMap = spotTexture;
    haloMaterial.emissiveIntensity = settings.halo;
    haloMaterial.blendType = pc.BLEND_ADDITIVE;
    haloMaterial.depthWrite = false;
    haloMaterial.cull = pc.CULLFACE_NONE;
    haloMaterial.update();

    const part = (name, type, material, partLayers = [pc.LAYERID_WORLD]) => {
        const e = new pc.Entity(name);
        e.addComponent('render', { type, material, layers: partLayers, castShadows: false, receiveShadows: false });
        return e;
    };

    const root = new pc.Entity('lamp');
    app.root.addChild(root);
    const top = new pc.Vec3(settings.base.x, settings.height, settings.base.z);
    const towards = new pc.Vec3(settings.target.x - settings.base.x, 0, settings.target.z - settings.base.z).normalize();
    const headAt = top.clone().add(towards.clone().mulScalar(settings.arm));

    const mast = part('mast', 'cylinder', metal);
    mast.setLocalScale(0.09, settings.height, 0.09);
    mast.setPosition(settings.base.x, settings.height / 2, settings.base.z);
    root.addChild(mast);

    const arm = part('arm', 'box', metal);
    arm.setLocalScale(0.05, 0.05, settings.arm);
    arm.setPosition(top.clone().add(towards.clone().mulScalar(settings.arm / 2)));
    arm.lookAt(headAt);
    root.addChild(arm);

    // the head looks along its own -Z at the spot it lights
    const head = new pc.Entity('head');
    head.setPosition(headAt);
    head.lookAt(settings.target);
    const lens = part('lens', 'plane', lensMaterial);
    lens.setLocalEulerAngles(-90, 0, 0);        // a plane faces +Y: turn that to -Z
    lens.setLocalPosition(0, 0, -0.07);
    lens.setLocalScale(0.3, 1, 0.16);
    head.addChild(lens);
    root.addChild(head);
    const housing = part('housing', 'box', metal);
    housing.setLocalScale(0.36, 0.2, 0.12);
    head.addChild(housing);

    const halo = part('halo', 'plane', haloMaterial, [glowLayer.id]);
    halo.setLocalScale(settings.haloSize, 1, settings.haloSize);
    halo.setPosition(headAt.clone().add(settings.target.clone().sub(headAt).normalize().mulScalar(0.1)));
    root.addChild(halo);

    const light = new pc.Entity('lamp-light');
    light.addComponent('light', {
        type: 'spot',
        color: settings.color,
        intensity: settings.intensity,
        range: settings.range,
        innerConeAngle: settings.inner,
        outerConeAngle: settings.outer,
        castShadows: true,
        // neither the lamp nor what it lights moves: one shadow map, drawn once
        shadowUpdateMode: pc.SHADOWUPDATE_THISFRAME,
        shadowType: pc.SHADOW_PCF3_32F,
        shadowResolution: 1024,
        shadowBias: 0.2,
        normalOffsetBias: 0.05,
        layers
    });
    light.setPosition(headAt);
    light.lookAt(settings.target);
    light.rotateLocal(90, 0, 0);        // a spot light shines down its -Y axis
    root.addChild(light);

    // under the ground: the light on the reflected figures
    const under = new pc.Vec3(headAt.x, -headAt.y, headAt.z);
    let mirrorLight = null;
    if (mirrorLayers) {
        mirrorLight = new pc.Entity('lamp-light-mirror');
        mirrorLight.addComponent('light', {
            type: 'spot',
            color: settings.color,
            intensity: settings.intensity,
            range: settings.range,
            innerConeAngle: settings.inner,
            outerConeAngle: settings.outer,
            castShadows: false,
            layers: mirrorLayers
        });
        mirrorLight.setPosition(under);
        mirrorLight.lookAt(settings.target);
        mirrorLight.rotateLocal(90, 0, 0);
        root.addChild(mirrorLight);
    }

    const axis = settings.target.clone().sub(headAt).normalize();
    const cosInner = Math.cos(settings.inner * pc.math.DEG_TO_RAD), cosOuter = Math.cos(settings.outer * pc.math.DEG_TO_RAD);
    let time = 0, was = -1;
    app.on('update', (dt) => {
        time += dt;
        const level = calm ? 1 : pc.math.lerp(1, flicker(time), settings.flicker);
        if (level !== was) {
            was = level;
            light.light.intensity = settings.intensity * level;
            if (mirrorLight) mirrorLight.light.intensity = settings.intensity * level;
            lensMaterial.emissiveIntensity = settings.glow * level;
            lensMaterial.update();
            haloMaterial.emissiveIntensity = settings.halo * level;
            haloMaterial.update();
        }
        // (a plane faces +Y: looked at the camera, then tipped over, it faces the camera)
        halo.lookAt(camera.getPosition());
        halo.rotateLocal(-90, 0, 0);
        if (ground) {
            const glow = settings.mirrored * level;
            ground.settings.lamp = {
                position: [headAt.x, headAt.y, headAt.z],
                strength: settings.mirroredStrength,
                glow: [settings.color.r * glow, settings.color.g * glow, settings.color.b * glow]
            };
        }
        if (rain) {
            rain.settings.lamp = {
                position: [headAt.x, headAt.y, headAt.z],
                direction: [axis.x, axis.y, axis.z],
                cone: [cosInner, cosOuter, settings.range, settings.intensity * settings.drops * level],
                color: [settings.color.r, settings.color.g, settings.color.b]
            };
        }
    });

    return { settings, root, light, mirrorLight, lensMaterial, head: headAt, get level() { return was; } };
}
