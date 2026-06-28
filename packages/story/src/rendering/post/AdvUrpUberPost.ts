import {
  ClampToEdgeWrapping,
  LinearFilter,
  NoBlending,
  NoColorSpace,
  RepeatWrapping,
  ShaderMaterial,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import type { AdvBloomResult, AdvRenderFullscreen } from "./AdvUrpBloom";
import type { AdvUrpVolumeState } from "./AdvVolumeStack";

const FILM_GRAIN_URLS = [
  new URL("../../assets/urp/film-grain/Thin01.png", import.meta.url).href,
  new URL("../../assets/urp/film-grain/Thin02.png", import.meta.url).href,
  new URL("../../assets/urp/film-grain/Medium01.png", import.meta.url).href,
  new URL("../../assets/urp/film-grain/Medium02.png", import.meta.url).href,
  new URL("../../assets/urp/film-grain/Medium03.png", import.meta.url).href,
  new URL("../../assets/urp/film-grain/Medium04.png", import.meta.url).href,
  new URL("../../assets/urp/film-grain/Medium05.png", import.meta.url).href,
  new URL("../../assets/urp/film-grain/Medium06.png", import.meta.url).href,
  new URL("../../assets/urp/film-grain/Large01.png", import.meta.url).href,
  new URL("../../assets/urp/film-grain/Large02.png", import.meta.url).href,
] as const;

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Hidden/Universal Render Pipeline/UberPost. Branches are uniforms here rather
// than keywords so one WebGL program covers all packaged ADV Volume profiles;
// each branch body and CPU parameter packing match the shipped URP variant.
const UBER_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform sampler2D tBloom;
uniform sampler2D tLut;
uniform sampler2D tGrain;
uniform sampler2D tUserLut;
uniform sampler2D tLensDirt;
uniform vec2 uInputTexelSize;
uniform vec2 uBloomTexelSize;
uniform vec3 uLutParams; // 1/width, 1/height, height-1
uniform float uPostExposure;
uniform vec4 uBloomParams; // intensity, normalized linear tint RGB
uniform vec4 uDistortion1; // center.xy, axis.xy
uniform vec4 uDistortion2; // theta, sigma, scale, signed intensity
uniform float uChromaAmount;
uniform vec4 uVignette1; // color.rgb, roundness
uniform vec4 uVignette2; // center.xy, intensity*3, smoothness*5
uniform vec2 uGrainParams; // intensity*4, response
uniform vec4 uGrainTiling; // scale.xy, offset.xy
uniform vec4 uUserLutParams; // reciprocal width/height, height-1, contribution
uniform vec4 uLensDirtParams; // tiling.xy, offset.xy
uniform float uLensDirtIntensity;
uniform float uTonemapping;
uniform float uHdrGrading;
uniform float uUseDistortion;
uniform float uUseChromatic;
uniform float uUseBloom;
uniform float uUseVignette;
uniform float uUseGrain;
uniform float uUseUserLut;
uniform float uUseLensDirt;
varying vec2 vUv;

vec2 clampBilinear(vec2 uv, vec2 texelSize) {
  return clamp(uv, texelSize * 0.5, vec2(1.0) - texelSize * 0.5);
}

vec3 fastSrgbToLinear(vec3 color) {
  return color * (color * (color * 0.305306011 + 0.682171111) + 0.012522878);
}

vec3 fastLinearToSrgb(vec3 color) {
  // Unity's PositivePow macro is pow(abs(base), power), not max(base, 0).
  return clamp(1.055 * pow(abs(color), vec3(0.416666657)) - 0.055, 0.0, 1.0);
}

vec3 linearToLogCLutSpace(vec3 color) {
  vec3 encoded = max(color * 5.55555582 + 0.0479959995, 0.0);
  return clamp(log2(encoded) * 0.0734997839 + 0.386036009, 0.0, 1.0);
}

float linearToSrgb(float channel) {
  return channel <= 0.0031308
    ? channel * 12.9232102
    : 1.055 * pow(max(channel, 0.0), 0.416666667) - 0.055;
}

vec3 linearToSrgb(vec3 color) {
  return vec3(linearToSrgb(color.r), linearToSrgb(color.g), linearToSrgb(color.b));
}

vec2 distortUv(vec2 uv) {
  if (uUseDistortion < 0.5) return uv;
  uv = (uv - 0.5) * uDistortion2.z + 0.5;
  vec2 radialUv = uDistortion1.zw * (uv - 0.5 - uDistortion1.xy);
  float radius = length(radialUv);
  float warpedRadius;
  if (uDistortion2.w > 0.0) {
    float wu = radius * uDistortion2.x;
    warpedRadius = tan(wu) / (radius * uDistortion2.y + 6.103515625e-05);
  } else {
    warpedRadius = uDistortion2.x * atan(radius * uDistortion2.y) / radius;
  }
  return uv + radialUv * (warpedRadius - 1.0);
}

vec3 sampleLut2D(sampler2D lut, vec3 params, vec3 color) {
  color = clamp(color, 0.0, 1.0);
  float blue = color.b * params.z;
  float shift = floor(blue);
  vec2 uv = color.rg * params.z * params.xy + params.xy * 0.5;
  uv.x += shift * params.y;
  vec3 left = texture2D(lut, uv).rgb;
  vec3 right = texture2D(lut, uv + vec2(params.y, 0.0)).rgb;
  return mix(left, right, blue - shift);
}

vec3 neutralTonemap(vec3 value) {
  value = clamp(value, 0.0, 435.187134);
  vec3 scaled = value * 1.31338608;
  vec3 numerator = scaled * (value * 0.262677222 + 0.0695999935) + 0.00543999998;
  vec3 denominator = scaled * (value * 0.262677222 + 0.289999992) + 0.0816000104;
  return clamp((numerator / denominator - 0.0666666627) * 1.31338608, 0.0, 1.0);
}

// _TONEMAP_ACES blob 88. This is the packaged ACES RRT+ODT path, retained
// verbatim at the scalar/vector expression level instead of using a fitted
// filmic approximation.
vec3 acesTonemap(vec3 value) {
  vec4 u_xlat2 = vec4(value, 0.0);
  bvec3 u_xlatb2;
  vec3 u_xlat16_3;
  vec3 u_xlat16_4;
  vec3 u_xlat5;
  bvec2 u_xlatb5;
  vec3 u_xlat6;
  vec3 u_xlat9;
  bool u_xlatb9;
  vec3 u_xlat16_10;
  float u_xlat16_11;
  float u_xlat12;
  bool u_xlatb12;
  float u_xlat16_17;
  float u_xlat16_18;
  float u_xlat19;
  bool u_xlatb19;
  float u_xlat16_22;
  float u_xlat23;
  float u_xlat16_24;
  bool u_xlatb26;

  u_xlat16_10.x = dot(vec3(0.439700991, 0.382977992, 0.177334994), u_xlat2.xyz);
  u_xlat16_10.y = dot(vec3(0.0897922963, 0.813422978, 0.0967615992), u_xlat2.xyz);
  u_xlat16_10.z = dot(vec3(0.0175439995, 0.111543998, 0.870703995), u_xlat2.xyz);
  u_xlat16_22 = min(u_xlat16_10.y, u_xlat16_10.x);
  u_xlat16_22 = min(u_xlat16_10.z, u_xlat16_22);
  u_xlat16_3.x = max(u_xlat16_10.y, u_xlat16_10.x);
  u_xlat16_3.x = max(u_xlat16_10.z, u_xlat16_3.x);
  u_xlat16_4.xy = max(u_xlat16_3.xx, vec2(9.99999975e-05, 0.00999999978));
  u_xlat16_22 = max(u_xlat16_22, 9.99999975e-05);
  u_xlat16_22 = (-u_xlat16_22) + u_xlat16_4.x;
  u_xlat16_22 = u_xlat16_22 / u_xlat16_4.y;
  u_xlat16_4.xyz = (-u_xlat16_10.yxz) + u_xlat16_10.zyx;
  u_xlat16_4.xy = u_xlat16_10.zy * u_xlat16_4.xy;
  u_xlat16_3.x = u_xlat16_4.y + u_xlat16_4.x;
  u_xlat16_3.x = u_xlat16_10.x * u_xlat16_4.z + u_xlat16_3.x;
  u_xlat16_3.x = max(u_xlat16_3.x, 0.0);
  u_xlat16_3.x = sqrt(u_xlat16_3.x);
  u_xlat16_4.x = u_xlat16_10.y + u_xlat16_10.z;
  u_xlat16_4.x = u_xlat16_10.x + u_xlat16_4.x;
  u_xlat16_3.x = u_xlat16_3.x * 1.75 + u_xlat16_4.x;
  u_xlat16_4.x = u_xlat16_3.x * 0.333333343;
  u_xlat16_11 = u_xlat16_22 + -0.400000006;
  u_xlat16_18 = u_xlat16_11 * 2.5;
  u_xlat16_18 = -abs(u_xlat16_18) + 1.0;
  u_xlat16_18 = max(u_xlat16_18, 0.0);
  u_xlatb2.x = u_xlat16_11 >= 0.0;
  u_xlat2.x = u_xlatb2.x ? 1.0 : -1.0;
  u_xlat16_11 = (-u_xlat16_18) * u_xlat16_18 + 1.0;
  u_xlat16_11 = u_xlat2.x * u_xlat16_11 + 1.0;
  u_xlat16_11 = u_xlat16_11 * 0.0250000004;
  u_xlatb2.x = 0.159999996 >= u_xlat16_3.x;
  u_xlatb9 = u_xlat16_3.x >= 0.479999989;
  u_xlat16_3.x = 0.0799999982 / u_xlat16_4.x;
  u_xlat16_3.x = u_xlat16_3.x + -0.5;
  u_xlat16_3.x = u_xlat16_3.x * u_xlat16_11;
  u_xlat16_3.x = u_xlatb9 ? 0.0 : u_xlat16_3.x;
  u_xlat16_3.x = u_xlatb2.x ? u_xlat16_11 : u_xlat16_3.x;
  u_xlat16_3.x = u_xlat16_3.x + 1.0;
  u_xlat2.yzw = u_xlat16_3.xxx * u_xlat16_10.xyz;
  u_xlatb5.xy = equal(u_xlat2.zw, u_xlat2.yz);
  u_xlatb5.x = u_xlatb5.y && u_xlatb5.x;
  u_xlat16_17 = u_xlat16_10.y * u_xlat16_3.x + (-u_xlat2.w);
  u_xlat16_17 = u_xlat16_17 * 1.73205078;
  u_xlat16_4.x = u_xlat2.y * 2.0 + (-u_xlat2.z);
  u_xlat16_24 = (-u_xlat16_10.z) * u_xlat16_3.x + u_xlat16_4.x;
  u_xlat16_4.x = min(abs(u_xlat16_24), abs(u_xlat16_17));
  u_xlat16_11 = max(abs(u_xlat16_24), abs(u_xlat16_17));
  u_xlat16_11 = 1.0 / u_xlat16_11;
  u_xlat16_4.x = u_xlat16_11 * u_xlat16_4.x;
  u_xlat16_11 = u_xlat16_4.x * u_xlat16_4.x;
  u_xlat12 = u_xlat16_11 * 0.0208350997 + -0.0851330012;
  u_xlat12 = u_xlat16_11 * u_xlat12 + 0.180141002;
  u_xlat12 = u_xlat16_11 * u_xlat12 + -0.330299497;
  u_xlat12 = u_xlat16_11 * u_xlat12 + 0.999866009;
  u_xlat19 = u_xlat16_4.x * u_xlat12;
  u_xlatb26 = abs(u_xlat16_24) < abs(u_xlat16_17);
  u_xlat19 = u_xlat19 * -2.0 + 1.57079637;
  u_xlat19 = u_xlatb26 ? u_xlat19 : 0.0;
  u_xlat12 = u_xlat16_4.x * u_xlat12 + u_xlat19;
  u_xlatb19 = u_xlat16_24 < (-u_xlat16_24);
  u_xlat19 = u_xlatb19 ? -3.14159274 : 0.0;
  u_xlat12 = u_xlat19 + u_xlat12;
  u_xlat16_4.x = min(u_xlat16_24, u_xlat16_17);
  u_xlat16_17 = max(u_xlat16_24, u_xlat16_17);
  u_xlatb19 = u_xlat16_4.x < (-u_xlat16_4.x);
  u_xlatb26 = u_xlat16_17 >= (-u_xlat16_17);
  u_xlatb19 = u_xlatb26 && u_xlatb19;
  u_xlat12 = u_xlatb19 ? (-u_xlat12) : u_xlat12;
  u_xlat16_17 = u_xlat12 * 57.2957802;
  u_xlat16_17 = u_xlatb5.x ? 0.0 : u_xlat16_17;
  u_xlatb5.x = u_xlat16_17 < 0.0;
  u_xlat16_24 = u_xlat16_17 + 360.0;
  u_xlat16_17 = u_xlatb5.x ? u_xlat16_24 : u_xlat16_17;
  u_xlatb5.x = u_xlat16_17 < -180.0;
  u_xlatb12 = 180.0 < u_xlat16_17;
  u_xlat16_4.xy = vec2(u_xlat16_17) + vec2(360.0, -360.0);
  u_xlat16_17 = u_xlatb12 ? u_xlat16_4.y : u_xlat16_17;
  u_xlat16_17 = u_xlatb5.x ? u_xlat16_4.x : u_xlat16_17;
  u_xlat5.x = u_xlat16_17 * 0.0148148146;
  u_xlat5.x = -abs(u_xlat5.x) + 1.0;
  u_xlat5.x = max(u_xlat5.x, 0.0);
  u_xlat12 = u_xlat5.x * -2.0 + 3.0;
  u_xlat5.x = u_xlat5.x * u_xlat5.x;
  u_xlat5.x = u_xlat5.x * u_xlat12;
  u_xlat5.x = u_xlat5.x * u_xlat5.x;
  u_xlat5.x = u_xlat16_22 * u_xlat5.x;
  u_xlat12 = (-u_xlat16_10.x) * u_xlat16_3.x + 0.0299999993;
  u_xlat5.x = u_xlat12 * u_xlat5.x;
  u_xlat2.x = u_xlat5.x * 0.180000007 + u_xlat2.y;
  u_xlat5.x = dot(vec3(1.45143926, -0.236510754, -0.214928567), u_xlat2.xzw);
  u_xlat5.y = dot(vec3(-0.0765537769, 1.17622972, -0.0996759236), u_xlat2.xzw);
  u_xlat5.z = dot(vec3(0.00831614807, -0.00603244966, 0.997716308), u_xlat2.xzw);
  u_xlat2.xyz = max(u_xlat5.xyz, vec3(0.0));
  u_xlat23 = dot(u_xlat2.xyz, vec3(0.272228986, 0.674081981, 0.0536894985));
  u_xlat2.xyz = (-vec3(u_xlat23)) + u_xlat2.xyz;
  u_xlat2.xyz = u_xlat2.xyz * 0.959999979 + vec3(u_xlat23);
  u_xlat5.xyz = u_xlat2.xyz + vec3(0.0245785993);
  u_xlat5.xyz = u_xlat2.xyz * u_xlat5.xyz + vec3(-9.05370034e-05);
  u_xlat6.xyz = u_xlat2.xyz * 0.983729005 + vec3(0.432951003);
  u_xlat2.xyz = u_xlat2.xyz * u_xlat6.xyz + vec3(0.238080993);
  u_xlat2.xyz = u_xlat5.xyz / u_xlat2.xyz;
  u_xlat5.x = dot(vec3(0.662454188, 0.134004205, 0.156187683), u_xlat2.xyz);
  u_xlat5.y = dot(vec3(0.272228718, 0.674081743, 0.0536895171), u_xlat2.xyz);
  u_xlat5.z = dot(vec3(-0.00557464967, 0.0040607336, 1.01033914), u_xlat2.xyz);
  u_xlat16_22 = dot(u_xlat5.xyz, vec3(1.0));
  u_xlat16_22 = max(u_xlat16_22, 9.99999975e-05);
  u_xlat16_3.xy = u_xlat5.xy / vec2(u_xlat16_22);
  u_xlat16_22 = max(u_xlat5.y, 0.0);
  u_xlat16_22 = min(u_xlat16_22, 65504.0);
  u_xlat16_22 = log2(u_xlat16_22);
  u_xlat16_22 = u_xlat16_22 * 0.981100023;
  u_xlat16_4.y = exp2(u_xlat16_22);
  u_xlat16_22 = max(u_xlat16_3.y, 9.99999975e-05);
  u_xlat16_22 = u_xlat16_4.y / u_xlat16_22;
  u_xlat16_24 = (-u_xlat16_3.x) + 1.0;
  u_xlat16_3.z = (-u_xlat16_3.y) + u_xlat16_24;
  u_xlat16_4.xz = vec2(u_xlat16_22) * u_xlat16_3.xz;
  u_xlat16_3.x = dot(vec3(1.6410234, -0.324803293, -0.236424699), u_xlat16_4.xyz);
  u_xlat16_3.y = dot(vec3(-0.663662851, 1.61533165, 0.0167563483), u_xlat16_4.xyz);
  u_xlat16_3.z = dot(vec3(0.0117218941, -0.00828444213, 0.988394856), u_xlat16_4.xyz);
  u_xlat2.x = dot(u_xlat16_3.xyz, vec3(0.272228986, 0.674081981, 0.0536894985));
  u_xlat9.xyz = (-u_xlat2.xxx) + u_xlat16_3.xyz;
  u_xlat2.xyz = u_xlat9.xyz * 0.930000007 + u_xlat2.xxx;
  u_xlat5.x = dot(vec3(0.662454188, 0.134004205, 0.156187683), u_xlat2.xyz);
  u_xlat5.y = dot(vec3(0.272228718, 0.674081743, 0.0536895171), u_xlat2.xyz);
  u_xlat5.z = dot(vec3(-0.00557464967, 0.0040607336, 1.01033914), u_xlat2.xyz);
  u_xlat2.x = dot(vec3(0.987223983, -0.00611326983, 0.0159533005), u_xlat5.xyz);
  u_xlat2.y = dot(vec3(-0.00759836007, 1.00186002, 0.00533019984), u_xlat5.xyz);
  u_xlat2.z = dot(vec3(0.00307257008, -0.00509594986, 1.08168006), u_xlat5.xyz);
  u_xlat16_3.x = clamp(dot(vec3(3.2409699, -1.5373832, -0.498610765), u_xlat2.xyz), 0.0, 1.0);
  u_xlat16_3.y = clamp(dot(vec3(-0.969243646, 1.8759675, 0.0415550582), u_xlat2.xyz), 0.0, 1.0);
  u_xlat16_3.z = clamp(dot(vec3(0.0556300804, -0.203976959, 1.05697155), u_xlat2.xyz), 0.0, 1.0);
  return u_xlat16_3;
}

vec3 applyUserLut(vec3 linearColor) {
  if (uUseUserLut < 0.5 || uUserLutParams.w <= 0.0) return linearColor;
  vec3 srgb = max(1.055 * pow(clamp(linearColor, 0.0, 1.0), vec3(0.416666657)) - 0.055, 0.0);
  vec3 graded = sampleLut2D(tUserLut, uUserLutParams.xyz, srgb);
  srgb += (graded - srgb) * uUserLutParams.w;
  return fastSrgbToLinear(srgb);
}

void main() {
  vec2 uv = vUv;
  vec2 distortedUv = distortUv(uv);
  vec4 inputColor = texture2D(tInput, clampBilinear(distortedUv, uInputTexelSize));
  vec3 color = inputColor.rgb;

  if (uUseChromatic > 0.5) {
    vec2 coords = 2.0 * uv - 1.0;
    vec2 endUv = uv - coords * dot(coords, coords) * uChromaAmount;
    vec2 delta = (endUv - uv) / 3.0;
    float red = color.r;
    float green = texture2D(tInput, clampBilinear(distortUv(uv + delta), uInputTexelSize)).g;
    float blue = texture2D(tInput, clampBilinear(distortUv(uv + delta * 2.0), uInputTexelSize)).b;
    color = vec3(red, green, blue);
  }

  // PlayerSettings.m_ActiveColorSpace=Gamma and the reference configuration
  // enables the fast conversion keyword. Uber performs the remaining effects
  // in linear space.
  color = fastSrgbToLinear(color);
  inputColor.rgb = fastSrgbToLinear(inputColor.rgb);

  if (uUseBloom > 0.5) {
    vec3 bloom = texture2D(tBloom, clampBilinear(distortedUv, uBloomTexelSize)).rgb;
    bloom *= bloom;
    bloom *= uBloomParams.x;
    color += bloom * uBloomParams.yzw;
    if (uUseLensDirt > 0.5) {
      vec3 dirt = texture2D(tLensDirt, uv * uLensDirtParams.xy + uLensDirtParams.zw).rgb;
      color += dirt * uLensDirtIntensity * bloom;
    }
    // _ENABLE_ALPHA_OUTPUT: preserve bloom beneath transparent source pixels.
    inputColor.rgb = color;
  }

  if (uUseVignette > 0.5 && uVignette2.z > 0.0) {
    vec2 distanceToCenter = abs(distortedUv - uVignette2.xy) * uVignette2.z;
    distanceToCenter.x *= uVignette1.w;
    float factor = pow(clamp(1.0 - dot(distanceToCenter, distanceToCenter), 0.0, 1.0), uVignette2.w);
    color *= mix(uVignette1.rgb, vec3(1.0), factor);
  }

  color *= uPostExposure;
  if (uHdrGrading > 0.5) {
    color = sampleLut2D(tLut, uLutParams, linearToLogCLutSpace(color));
    color = applyUserLut(color);
  } else {
    if (uTonemapping > 1.5) color = acesTonemap(color);
    else if (uTonemapping > 0.5) color = neutralTonemap(color);
    else color = clamp(color, 0.0, 1.0);
    color = applyUserLut(color);
    color = sampleLut2D(tLut, uLutParams, color);
  }

  if (uUseGrain > 0.5) {
    float grain = texture2D(tGrain, uv * uGrainTiling.xy + uGrainTiling.zw).a;
    grain = (grain - 0.5) * 2.0;
    float response = 1.0 - sqrt(max(dot(color, vec3(0.212672904, 0.715152204, 0.0721750036)), 0.0));
    response = mix(1.0, response, uGrainParams.y);
    color += color * grain * uGrainParams.x * response;
  }

  color = fastLinearToSrgb(color);
  inputColor.rgb = linearToSrgb(inputColor.rgb);
  color = mix(inputColor.rgb, color, clamp(inputColor.a, 0.0, 1.0));
  gl_FragColor = vec4(color, clamp(inputColor.a, 0.0, 1.0));
}
`;

type UberUniforms = Record<string, IUniform<unknown>> & {
  tInput: IUniform<Texture | null>;
  tBloom: IUniform<Texture | null>;
  tLut: IUniform<Texture | null>;
  tGrain: IUniform<Texture | null>;
  tUserLut: IUniform<Texture | null>;
  tLensDirt: IUniform<Texture | null>;
  uInputTexelSize: IUniform<Vector2>;
  uBloomTexelSize: IUniform<Vector2>;
  uLutParams: IUniform<Vector3>;
  uPostExposure: IUniform<number>;
  uBloomParams: IUniform<Vector4>;
  uDistortion1: IUniform<Vector4>;
  uDistortion2: IUniform<Vector4>;
  uChromaAmount: IUniform<number>;
  uVignette1: IUniform<Vector4>;
  uVignette2: IUniform<Vector4>;
  uGrainParams: IUniform<Vector2>;
  uGrainTiling: IUniform<Vector4>;
  uUserLutParams: IUniform<Vector4>;
  uLensDirtParams: IUniform<Vector4>;
  uLensDirtIntensity: IUniform<number>;
  uTonemapping: IUniform<number>;
  uHdrGrading: IUniform<number>;
  uUseDistortion: IUniform<number>;
  uUseChromatic: IUniform<number>;
  uUseBloom: IUniform<number>;
  uUseVignette: IUniform<number>;
  uUseGrain: IUniform<number>;
  uUseUserLut: IUniform<number>;
  uUseLensDirt: IUniform<number>;
};

export interface UnityRandomState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

const UNITY_RANDOM_MULTIPLIER = 0x6c078965;
// Scale is the float32 encoding 0x34000001, i.e. the correctly-rounded
// reciprocal of the largest 23-bit unsigned mantissa.
const UNITY_RANDOM_VALUE_SCALE = Math.fround(1 / 0x7fffff);

/** Mirrors `UnityEngine.Random::InitState`. */
export function unityRandomState(seed: number): UnityRandomState {
  const s0 = Math.trunc(seed) >>> 0;
  const s1 = (Math.imul(s0, UNITY_RANDOM_MULTIPLIER) + 1) >>> 0;
  const s2 = (Math.imul(s1, UNITY_RANDOM_MULTIPLIER) + 1) >>> 0;
  const s3 = (Math.imul(s2, UNITY_RANDOM_MULTIPLIER) + 1) >>> 0;
  return { s0, s1, s2, s3 };
}

/** Mirrors `UnityEngine.Random::get_value`. */
export function unityRandomValue(state: UnityRandomState): number {
  const temporary = (state.s0 ^ (state.s0 << 11)) >>> 0;
  const next = (temporary ^ state.s3 ^ (temporary >>> 8) ^ (state.s3 >>> 19)) >>> 0;
  state.s0 = state.s1;
  state.s1 = state.s2;
  state.s2 = state.s3;
  state.s3 = next;
  return Math.fround(Math.fround(next & 0x7fffff) * UNITY_RANDOM_VALUE_SCALE);
}

function configureTexture(texture: Texture): void {
  texture.colorSpace = NoColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = false;
}

function configureClampTexture(texture: Texture): void {
  texture.colorSpace = NoColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
}

function textureUrl(reference: unknown): string | null {
  if (typeof reference === "string") return reference || null;
  if (reference == null || typeof reference !== "object") return null;
  const value = reference as Readonly<Record<string, unknown>>;
  const url = value.url ?? value.textureUrl;
  return typeof url === "string" && url ? url : null;
}

function textureDimensions(texture: Texture | null): readonly [number, number] | null {
  const image = texture?.image as { width?: unknown; height?: unknown } | undefined;
  const width = Number(image?.width);
  const height = Number(image?.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? [width, height] : null;
}

/** Compatibility SetupBloom lens-dirt tiling/offset packing. */
export function advLensDirtScaleOffset(
  screenWidth: number,
  screenHeight: number,
  dirtWidth: number,
  dirtHeight: number,
): readonly [number, number, number, number] {
  const screenRatio = screenWidth / screenHeight;
  const dirtRatio = dirtWidth / dirtHeight;
  if (dirtRatio > screenRatio) {
    const scale = screenRatio / dirtRatio;
    return [scale, 1, (1 - scale) * 0.5, 0];
  }
  if (dirtRatio < screenRatio) {
    const scale = dirtRatio / screenRatio;
    return [1, scale, 0, (1 - scale) * 0.5];
  }
  return [1, 1, 0, 0];
}

export function advUserLutParams(width: number, height: number, contribution: number): readonly number[] {
  return [1 / width, 1 / height, height - 1, Math.max(0, Math.min(1, contribution))];
}

/** LinearToLogC followed by the _HDR_GRADING saturate in Common.hlsl. */
export function advHdrLutInput(value: number): number {
  const encoded = Math.max(value * 5.55555582 + 0.0479959995, 0);
  return Math.max(0, Math.min(1, Math.log2(encoded) * 0.0734997839 + 0.386036009));
}

/** Resolves FilmGrain.Type without conflating different future custom URLs. */
export function advFilmGrainTextureUrl(type: number, customTextureReference: unknown): string | null {
  if (Math.trunc(type) !== 10) return FILM_GRAIN_URLS[Math.trunc(type)] ?? null;
  return textureUrl(customTextureReference);
}

export class AdvUrpUberPost {
  private readonly uniforms: UberUniforms = {
    tInput: { value: null },
    tBloom: { value: null },
    tLut: { value: null },
    tGrain: { value: null },
    tUserLut: { value: null },
    tLensDirt: { value: null },
    uInputTexelSize: { value: new Vector2(1, 1) },
    uBloomTexelSize: { value: new Vector2(1, 1) },
    uLutParams: { value: new Vector3(1 / 256, 1 / 16, 15) },
    uPostExposure: { value: 1 },
    uBloomParams: { value: new Vector4() },
    uDistortion1: { value: new Vector4(0, 0, 1, 1) },
    uDistortion2: { value: new Vector4(1, 1, 1, 0) },
    uChromaAmount: { value: 0 },
    uVignette1: { value: new Vector4(0, 0, 0, 1) },
    uVignette2: { value: new Vector4(0.5, 0.5, 0, 1) },
    uGrainParams: { value: new Vector2() },
    uGrainTiling: { value: new Vector4() },
    uUserLutParams: { value: new Vector4(1, 1, 0, 0) },
    uLensDirtParams: { value: new Vector4(1, 1, 0, 0) },
    uLensDirtIntensity: { value: 0 },
    uTonemapping: { value: 0 },
    uHdrGrading: { value: 0 },
    uUseDistortion: { value: 0 },
    uUseChromatic: { value: 0 },
    uUseBloom: { value: 0 },
    uUseVignette: { value: 0 },
    uUseGrain: { value: 0 },
    uUseUserLut: { value: 0 },
    uUseLensDirt: { value: 0 },
  };
  private readonly material = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: UBER_FRAGMENT,
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });
  private readonly textureLoader = new TextureLoader();
  private readonly filmGrainTextures = new Map<string, Texture>();
  private readonly externalTextures = new Map<string, Texture>();

  render(
    source: WebGLRenderTarget,
    destination: WebGLRenderTarget,
    state: Readonly<AdvUrpVolumeState>,
    lut: Texture,
    bloom: AdvBloomResult | null,
    hdrGrading: boolean,
    frameCount: number,
    renderFullscreen: AdvRenderFullscreen,
  ): void {
    source.texture.minFilter = LinearFilter;
    source.texture.magFilter = LinearFilter;
    this.uniforms.tInput.value = source.texture;
    this.uniforms.uInputTexelSize.value.set(1 / source.width, 1 / source.height);
    this.uniforms.tLut.value = lut;
    this.uniforms.uPostExposure.value = Math.pow(2, state.colorAdjustments.postExposure);

    this.uniforms.uUseBloom.value = bloom ? 1 : 0;
    this.uniforms.tBloom.value = bloom?.texture ?? source.texture;
    this.uniforms.uBloomTexelSize.value.set(1 / (bloom?.width ?? source.width), 1 / (bloom?.height ?? source.height));
    this.uniforms.uBloomParams.value.set(
      bloom?.intensity ?? 0,
      bloom?.tint[0] ?? 1,
      bloom?.tint[1] ?? 1,
      bloom?.tint[2] ?? 1,
    );

    const dirt = state.bloom;
    const dirtTexture = bloom && dirt.dirtIntensity > 0 ? this.resolveExternalTexture(dirt.dirtTexture) : null;
    const dirtSize = textureDimensions(dirtTexture);
    const dirtActive = Boolean(bloom && dirtTexture && dirtSize && dirt.dirtIntensity > 0);
    this.uniforms.uUseLensDirt.value = dirtActive ? 1 : 0;
    this.uniforms.tLensDirt.value = dirtTexture ?? source.texture;
    this.uniforms.uLensDirtIntensity.value = Math.max(0, dirt.dirtIntensity);
    if (dirtSize) {
      this.uniforms.uLensDirtParams.value.set(
        ...advLensDirtScaleOffset(source.width, source.height, dirtSize[0], dirtSize[1]),
      );
    }

    const colorLookup = state.colorLookup;
    const userLut =
      colorLookup.active && colorLookup.contribution > 0 ? this.resolveExternalTexture(colorLookup.texture) : null;
    const userLutSize = textureDimensions(userLut);
    const userLutActive = Boolean(userLut && userLutSize && userLutSize[0] === userLutSize[1] * userLutSize[1]);
    this.uniforms.uUseUserLut.value = userLutActive ? 1 : 0;
    this.uniforms.tUserLut.value = userLut ?? lut;
    if (userLutSize) {
      const params = advUserLutParams(userLutSize[0], userLutSize[1], colorLookup.contribution);
      this.uniforms.uUserLutParams.value.set(params[0], params[1], params[2], params[3]);
    }
    this.uniforms.uHdrGrading.value = hdrGrading ? 1 : 0;
    this.uniforms.uTonemapping.value = !hdrGrading && state.tonemapping.active ? Math.trunc(state.tonemapping.mode) : 0;

    const distortion = state.lensDistortion;
    const distortionActive = distortion.active && Math.abs(distortion.intensity) > 0;
    this.uniforms.uUseDistortion.value = distortionActive ? 1 : 0;
    if (distortionActive) {
      const amount = 1.6 * Math.max(Math.abs(distortion.intensity * 100), 1);
      const theta = (Math.PI / 180) * Math.min(160, amount);
      const sigma = 2 * Math.tan(theta * 0.5);
      const centerX = distortion.center.x * 2 - 1;
      const centerY = distortion.center.y * 2 - 1;
      this.uniforms.uDistortion1.value.set(
        centerX,
        centerY,
        Math.max(distortion.xMultiplier, 0.0001),
        Math.max(distortion.yMultiplier, 0.0001),
      );
      this.uniforms.uDistortion2.value.set(
        distortion.intensity >= 0 ? theta : 1 / theta,
        sigma,
        1 / distortion.scale,
        distortion.intensity * 100,
      );
    }

    this.uniforms.uUseChromatic.value =
      state.chromaticAberration.active && state.chromaticAberration.intensity > 0 ? 1 : 0;
    this.uniforms.uChromaAmount.value = Math.max(0, state.chromaticAberration.intensity) * 0.05;

    const vignette = state.vignette;
    // SetupVignette passes ColorParameter.value directly; unlike Bloom tint
    // and color grading's filter, it does not access Color.linear.
    const vignetteColor = [
      vignette.color.r ?? vignette.color.x ?? 0,
      vignette.color.g ?? vignette.color.y ?? 0,
      vignette.color.b ?? vignette.color.z ?? 0,
    ] as const;
    this.uniforms.uUseVignette.value = vignette.active && vignette.intensity > 0 ? 1 : 0;
    this.uniforms.uVignette1.value.set(
      vignetteColor[0],
      vignetteColor[1],
      vignetteColor[2],
      vignette.rounded ? source.width / source.height : 1,
    );
    this.uniforms.uVignette2.value.set(
      vignette.center.x,
      vignette.center.y,
      vignette.intensity * 3,
      vignette.smoothness * 5,
    );

    const grain = state.filmGrain;
    const grainType = Math.trunc(grain.type);
    const grainRequested = grain.active && grain.intensity > 0;
    const grainTexture = grainRequested ? this.getFilmGrainTexture(grainType, grain.texture) : null;
    const grainActive = grain.active && grain.intensity > 0 && Boolean(grainTexture);
    this.uniforms.uUseGrain.value = grainActive ? 1 : 0;
    this.uniforms.tGrain.value = grainTexture ?? source.texture;
    this.uniforms.uGrainParams.value.set(grain.intensity * 4, grain.response);
    const random = unityRandomState(frameCount);
    this.uniforms.uGrainTiling.value.set(
      source.width / 512,
      source.height / 512,
      unityRandomValue(random),
      unityRandomValue(random),
    );

    renderFullscreen(this.material, destination, true);
  }

  dispose(): void {
    this.material.dispose();
    for (const texture of this.filmGrainTextures.values()) texture.dispose();
    this.filmGrainTextures.clear();
    for (const texture of this.externalTextures.values()) texture.dispose();
    this.externalTextures.clear();
  }

  private getFilmGrainTexture(type: number, customTextureReference: unknown): Texture | null {
    if (type === 10 && customTextureReference instanceof Texture) {
      configureTexture(customTextureReference);
      return customTextureReference;
    }
    const url = advFilmGrainTextureUrl(type, customTextureReference);
    if (!url) return null;
    const cached = this.filmGrainTextures.get(url);
    if (cached) return cached;
    const texture = this.textureLoader.load(url, configureTexture);
    configureTexture(texture);
    this.filmGrainTextures.set(url, texture);
    return texture;
  }

  private resolveExternalTexture(reference: unknown): Texture | null {
    if (reference instanceof Texture) {
      configureClampTexture(reference);
      return reference;
    }
    const url = textureUrl(reference);
    if (!url) return null;
    const cached = this.externalTextures.get(url);
    if (cached) return cached;
    const texture = this.textureLoader.load(url, configureClampTexture);
    configureClampTexture(texture);
    this.externalTextures.set(url, texture);
    return texture;
  }
}
