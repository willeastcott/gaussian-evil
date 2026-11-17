// Life: the small motions that stop a frozen capture reading as a pair of mannequins once rain
// is falling around it. Nothing is rigged. Each motion is a smooth displacement field in world
// space (metres), so neighbouring splats always move together and nothing can tear:
//
//   - weight shifting: each figure leans a few millimetres about its feet
//   - breathing: the ribs swell, and the shoulders, neck and head ride up on them as one piece
//   - wind: the hem of her dress and the hair down her back ripple in gusts
//
// The fields are placed from tools/body-profile.mjs, which measures where each figure is at each
// height. The two stand back to back along x, him at x < 0 and her at x > 0, with a gap at x = 0.
//
// These are shader snippets, not a whole chunk: src/wet-floor.js owns the splat vertex hook and
// calls lifeOffset() for the real figures and, mirrored, for their reflections. The lighting proxy
// mesh does not move, which is why every amplitude here stays around a centimetre or less.

/**
 * The strength of the wind at a moment, 0.1 to 1: the same gusts as in the shaders below, for
 * anything else that should follow them (src/audio.js).
 *
 * @param {number} t - Seconds on the app's clock.
 * @returns {number} The gust.
 */
export const gust = t => 0.55 + 0.45 * Math.sin(t * 0.37) * Math.sin(t * 0.23 + 1.0);

export const LIFE_GLSL = /* glsl */`
uniform float uLife;    // overall amount: 1 as designed, 0 for the capture as shot

vec3 lifeOffset(vec3 p, float t) {
    float her = smoothstep(-0.03, 0.07, p.x);
    vec3 d = vec3(0.0);

    // weight shifting: a lean about the feet
    vec2 lean = mix(
        vec2(sin(t * 0.71), sin(t * 0.53 + 1.3)) * 0.0035,
        vec2(sin(t * 0.63 + 2.0), sin(t * 0.47 + 0.4)) * 0.003, her);
    d.xz += lean * p.y;

    // breathing: tense and fairly quick, out of step with each other
    vec3 chest = mix(vec3(-0.40, 1.38, -0.18), vec3(0.38, 1.22, -0.10), her);
    float breath = 0.5 + 0.5 * sin(t * mix(2.0, 2.4, her) + her * 1.7);
    breath = breath * breath * (3.0 - 2.0 * breath);
    vec3 r = p - chest;
    // the ribs swell outwards, between the waist and the collarbone and no higher: a swell that
    // reached the head made it grow and shrink with every breath
    float ribs = smoothstep(-0.30, -0.10, r.y) * (1.0 - smoothstep(0.04, 0.14, r.y));
    float swell = ribs * exp(-dot(r.xz, r.xz) / (2.0 * 0.17 * 0.17));
    d.xz += normalize(r.xz + vec2(1.0e-4)) * (0.006 * swell * breath);
    // everything above the waist rides up. Within a hand's breadth of the spine it all rises by
    // the same amount, so the neck and head move as one piece; the arms, further out, rise less
    float outside = max(0.0, length(r.xz) - 0.2);
    float lift = smoothstep(-0.2, 0.1, r.y) * exp(-outside * outside / (2.0 * 0.3 * 0.3));
    d.y += 0.004 * lift * breath;

    // wind, in gusts
    float gust = 0.55 + 0.45 * sin(t * 0.37) * sin(t * 0.23 + 1.0);
    vec2 wind = vec2(0.5, 0.87);

    // the hem of her dress: most at the hem, none by the waist, none on her legs below it
    float hem = her * (1.0 - smoothstep(0.5, 0.9, p.y)) * smoothstep(0.36, 0.44, p.y);
    float wave = sin(dot(p.xz, vec2(7.0, 5.0)) - t * 2.3) + 0.5 * sin(p.y * 14.0 + p.x * 9.0 + t * 3.1);
    d.xz += wind * (0.011 * hem * gust * wave);

    // the hair down her back: behind the plane of her face, from her crown to her shoulder blades
    vec3 h = p - vec3(0.31, 1.48, -0.10);
    float behind = -dot(h.xz, vec2(0.82, 0.58));
    float hair = her * smoothstep(0.02, 0.14, behind + max(0.0, -h.y) * 0.5) * smoothstep(1.12, 1.25, p.y) * (1.0 - smoothstep(1.58, 1.64, p.y));
    float curl = sin(dot(p.xz, vec2(11.0, -8.0)) + p.y * 9.0 - t * 2.9) + 0.5 * sin(p.y * 21.0 + t * 4.3);
    d.xz += wind * (0.007 * hair * gust * curl);

    return d * uLife;
}
`;

export const LIFE_WGSL = /* wgsl */`
uniform uLife: f32;    // overall amount: 1 as designed, 0 for the capture as shot

fn lifeOffset(p: vec3f, t: f32) -> vec3f {
    let her = smoothstep(-0.03, 0.07, p.x);
    var d = vec3f(0.0);

    // weight shifting: a lean about the feet
    let lean = mix(
        vec2f(sin(t * 0.71), sin(t * 0.53 + 1.3)) * 0.0035,
        vec2f(sin(t * 0.63 + 2.0), sin(t * 0.47 + 0.4)) * 0.003, her);
    d.x += lean.x * p.y;
    d.z += lean.y * p.y;

    // breathing: tense and fairly quick, out of step with each other
    let chest = mix(vec3f(-0.40, 1.38, -0.18), vec3f(0.38, 1.22, -0.10), her);
    var breath = 0.5 + 0.5 * sin(t * mix(2.0, 2.4, her) + her * 1.7);
    breath = breath * breath * (3.0 - 2.0 * breath);
    let r = p - chest;
    // the ribs swell outwards, between the waist and the collarbone and no higher: a swell that
    // reached the head made it grow and shrink with every breath
    let ribs = smoothstep(-0.30, -0.10, r.y) * (1.0 - smoothstep(0.04, 0.14, r.y));
    let swell = ribs * exp(-dot(r.xz, r.xz) / (2.0 * 0.17 * 0.17));
    let push = normalize(r.xz + vec2f(1.0e-4)) * (0.006 * swell * breath);
    d.x += push.x;
    d.z += push.y;
    // everything above the waist rides up. Within a hand's breadth of the spine it all rises by
    // the same amount, so the neck and head move as one piece; the arms, further out, rise less
    let outside = max(0.0, length(r.xz) - 0.2);
    let lift = smoothstep(-0.2, 0.1, r.y) * exp(-outside * outside / (2.0 * 0.3 * 0.3));
    d.y += 0.004 * lift * breath;

    // wind, in gusts
    let gust = 0.55 + 0.45 * sin(t * 0.37) * sin(t * 0.23 + 1.0);
    let wind = vec2f(0.5, 0.87);

    // the hem of her dress: most at the hem, none by the waist, none on her legs below it
    let hem = her * (1.0 - smoothstep(0.5, 0.9, p.y)) * smoothstep(0.36, 0.44, p.y);
    let wave = sin(dot(p.xz, vec2f(7.0, 5.0)) - t * 2.3) + 0.5 * sin(p.y * 14.0 + p.x * 9.0 + t * 3.1);
    let hemMove = wind * (0.011 * hem * gust * wave);

    // the hair down her back: behind the plane of her face, from her crown to her shoulder blades
    let h = p - vec3f(0.31, 1.48, -0.10);
    let behind = -dot(h.xz, vec2f(0.82, 0.58));
    let hair = her * smoothstep(0.02, 0.14, behind + max(0.0, -h.y) * 0.5) * smoothstep(1.12, 1.25, p.y) * (1.0 - smoothstep(1.58, 1.64, p.y));
    let curl = sin(dot(p.xz, vec2f(11.0, -8.0)) + p.y * 9.0 - t * 2.9) + 0.5 * sin(p.y * 21.0 + t * 4.3);
    let hairMove = wind * (0.007 * hair * gust * curl);

    d.x += hemMove.x + hairMove.x;
    d.z += hemMove.y + hairMove.y;
    return d * uniform.uLife;
}
`;
