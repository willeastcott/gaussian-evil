// Lightning: every so often the whole scene is lit from somewhere else.
//
// A strike is a distant, shadow-casting directional light that comes from a different point of
// the sky each time, high up and from any side. It lights the proxy mesh (and so the splats), the
// ground, and, through a mirrored twin, the reflection. Its brightness follows the shape of real
// lightning: two or three return strokes a tenth of a second apart, each rising at once and
// dying away exponentially.
//
// A flash lights more than the figures, so the same level also drives:
//   - the sky: the clear colour and the fog it fades into, so the figures stand against it
//   - the ambient light, which fills the shadows the bolt leaves
//   - the puddles, which mirror that sky (src/ground.js)
//   - the rain and its splashes, which are otherwise lit only by the torch (src/rain.js)
//
// Each strike is nearer or further off, which sets how bright it is. It is announced on the app
// as 'lightning:strike' with { near, from }, so the thunder can follow (src/audio.js).
//
// Nobody in the scene has to react to it, which is why it is lightning and not a muzzle flash.
//
// Flashing is kept within the usual limit for photosensitivity: at most three strokes a strike,
// and many seconds between strikes. With prefers-reduced-motion a strike is one slow swell.
import * as pc from 'playcanvas';

const BOLT = new pc.Color(0.78, 0.86, 1.0);         // the light itself
const SKY = [0.11, 0.14, 0.22];                     // the sky at the peak of a flash
const SKY_IN_WATER = [0.5, 0.6, 0.85];              // what the puddles mirror: the brighter sky overhead
const FILL = [0.2, 0.24, 0.36];                     // added to the ambient light at the peak
const RAIN = [0.26, 0.3, 0.4];                     // how brightly a flash lights a rain drop
// Between strikes the night is not quite black: a sky just light enough for the ground to end
// against, and for standing water to show as water.
const NIGHT = [0.012, 0.016, 0.027];
const NIGHT_IN_WATER = [0.03, 0.04, 0.062];

/**
 * @param {object} o - What the lightning lights.
 * @param {pc.AppBase} o.app - The app.
 * @param {pc.Entity} o.camera - Main camera: its clear colour is the sky.
 * @param {number[]} o.layers - Layers the bolt lights and takes its shadows from.
 * @param {number[]|null} o.mirrorLayers - The same for the reflected figures, if there are any.
 * @param {object} o.ground - From createGround: its puddles mirror the sky.
 * @param {object|null} o.rain - From createRain: the drops catch the flash.
 * @returns {object} Settings, strike() to fire one now, defer() to put the next one off, and the lights.
 */
export function createLightning({ app, camera, layers, mirrorLayers, ground, rain }) {
    const settings = {
        intensity: 2.6,         // of the bolt at its peak; the torch is 1.6
        every: [7, 16],         // seconds between strikes: shortest, longest
        first: 4,               // seconds before the first
        height: [35, 65],       // degrees above the horizon it comes from
        ambient: 1,             // the ambient light between strikes, as a fraction of the scene's own
        enabled: true
    };
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const makeBolt = (name, boltLayers) => {
        const e = new pc.Entity(name);
        e.addComponent('light', {
            type: 'directional',
            color: BOLT,
            intensity: 0,
            castShadows: true,
            shadowType: pc.SHADOW_PCF3_32F,
            shadowResolution: 2048,
            shadowDistance: 12,
            numCascades: 1,
            shadowBias: 0.2,
            normalOffsetBias: 0.05,
            layers: boltLayers
        });
        app.root.addChild(e);
        return e;
    };
    const bolt = makeBolt('lightning', layers);
    const mirrorBolt = mirrorLayers ? makeBolt('lightning-mirror', mirrorLayers) : null;

    const ambientBase = app.scene.ambientLight.clone();
    const from = new pc.Vec3(0, 1, 0);      // where in the sky the current strike is
    let strokes = [];                       // { at, peak, decay } in seconds since the strike began
    let clock = 0, began = -100, next = settings.first;
    // the first few frames run with the lights on but dark, so that every shader that will be
    // needed for a strike is built while the scene is still loading in, not at the first flash
    let warmUp = 4;

    // a directional light shines down its own -Y axis
    const aimAt = (entity, x, y, z) => {
        entity.setPosition(x, y, z);
        entity.lookAt(pc.Vec3.ZERO);
        entity.rotateLocal(90, 0, 0);
    };

    /**
     * @param {object} [o] - A strike is random unless told otherwise.
     * @param {number} [o.azimuth] - Where round the sky it comes from, in radians (0 is +x, 90° is +z).
     * @param {number} [o.height] - Degrees above the horizon.
     * @param {number} [o.near] - 1 is right on top of us, 0 a kilometre off.
     */
    function strike(o = {}) {
        const azimuth = o.azimuth ?? Math.random() * Math.PI * 2;
        const height = (o.height ?? pc.math.lerp(settings.height[0], settings.height[1], Math.random())) * pc.math.DEG_TO_RAD;
        from.set(Math.cos(azimuth) * Math.cos(height), Math.sin(height), Math.sin(azimuth) * Math.cos(height)).mulScalar(20);
        aimAt(bolt, from.x, from.y, from.z);
        if (mirrorBolt) aimAt(mirrorBolt, from.x, -from.y, from.z);

        const near = o.near ?? Math.random();
        const power = 0.4 + 0.6 * near;

        strokes = [];
        if (calm) {
            strokes.push({ at: 0, peak: 0.5 * power, decay: 0.35, swell: true });
        } else {
            const count = 2 + Math.floor(Math.random() * 2);
            let at = 0;
            for (let i = 0; i < count; i++) {
                strokes.push({ at, peak: power * (i === 0 ? 1 : 0.35 + Math.random() * 0.45), decay: 0.045 + Math.random() * 0.05 });
                at += 0.09 + Math.random() * 0.12;
            }
        }
        began = clock;
        next = clock + pc.math.lerp(settings.every[0], settings.every[1], Math.random());
        app.fire('lightning:strike', { near, from: from.clone() });
    }

    /** @returns {number} Brightness of the current strike, 0..1 */
    function level() {
        const t = clock - began;
        let sum = 0;
        for (const s of strokes) {
            const dt = t - s.at;
            if (dt < 0) continue;
            // a swell rises as well as falls; a stroke is at its peak the moment it starts
            sum += s.swell ? s.peak * (dt / s.decay) * Math.exp(1 - dt / s.decay) : s.peak * Math.exp(-dt / s.decay);
        }
        return Math.min(1, sum);
    }

    const sky = new pc.Color(), ambient = new pc.Color();
    app.on('update', (dt) => {
        clock += dt;
        if (settings.enabled && clock >= next) strike();

        let flash = level();
        if (flash < 0.004) flash = 0;
        const on = flash > 0 || warmUp > 0;
        if (warmUp > 0) warmUp--;

        bolt.enabled = on;
        bolt.light.intensity = settings.intensity * flash;
        if (mirrorBolt) {
            mirrorBolt.enabled = on;
            mirrorBolt.light.intensity = settings.intensity * flash;
        }

        sky.set(SKY[0] * flash + NIGHT[0], SKY[1] * flash + NIGHT[1], SKY[2] * flash + NIGHT[2]);
        camera.camera.clearColor = sky;
        app.scene.fog.color = sky;
        const dim = settings.ambient;
        ambient.set(ambientBase.r * dim + FILL[0] * flash, ambientBase.g * dim + FILL[1] * flash, ambientBase.b * dim + FILL[2] * flash);
        app.scene.ambientLight = ambient;

        ground.settings.sky = SKY_IN_WATER.map((c, i) => c * flash + NIGHT_IN_WATER[i]);
        if (rain) rain.settings.flash = RAIN.map(c => c * flash);
    });

    /** @param {number} seconds - The next strike that comes by itself is this far off. */
    const defer = (seconds) => {
        next = clock + seconds;
    };

    return { settings, strike, defer, bolt, mirrorBolt, get level() { return level(); } };
}
