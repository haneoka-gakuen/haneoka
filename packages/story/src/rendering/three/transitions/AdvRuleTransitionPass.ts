import {
  Mesh,
  NoBlending,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector4,
  WebGLRenderer,
} from "three";
import type { IUniform } from "three";
import type { AdvRuleTransitionRenderState } from "./AdvRuleTransition";

const VERTEX_SHADER = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Exact UI/Transition GLES3 pixel math. The final straight-alpha canvas is
 * composited by the browser with the same SrcAlpha/OneMinusSrcAlpha RGB
 * equation as Unity. This layer is required because Unity's rule Image is on
 * FrontCanvas (sorting order 304), above video/still/frame canvases.
 */
export const UNITY_RULE_TRANSITION_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uRuleTexture;
uniform vec2 uScreenSize;
uniform vec4 uColor;
uniform float uValue;
uniform int uUseGradient;

void main() {
  float alpha;
  if (uUseGradient != 0) {
    vec2 screenUv = gl_FragCoord.xy / uScreenSize.xy;
    float rule = texture2D(uRuleTexture, screenUv).x;
    float threshold = uValue * 0.600000024 + 0.400000006;
    float t = clamp((rule - threshold) * 5.0, 0.0, 1.0);
    alpha = t * t * (t * -2.0 + 3.0);
  } else {
    float t = clamp((1.0 - uValue) * 0.5, 0.0, 1.0);
    alpha = t * t * (t * -2.0 + 3.0);
  }
  gl_FragColor = vec4(uColor.rgb, alpha * uColor.a);
  #include <colorspace_fragment>
}
`;

interface TransitionUniforms extends Record<string, IUniform<unknown>> {
  readonly uRuleTexture: IUniform<AdvRuleTransitionRenderState["texture"] | null>;
  readonly uScreenSize: IUniform<Vector2>;
  readonly uColor: IUniform<Vector4>;
  readonly uValue: IUniform<number>;
  readonly uUseGradient: IUniform<number>;
}

export interface AdvRuleTransitionCanvasPresentation {
  hidden: boolean | string;
  readonly style: Pick<CSSStyleDeclaration, "display" | "visibility">;
}

/**
 * The hidden attribute is CSS-overridable, and the player stylesheet assigns
 * display:block to every canvas. Keep an inline display state as the
 * authoritative compositor boundary.
 */
export function setAdvRuleTransitionCanvasVisible(canvas: AdvRuleTransitionCanvasPresentation, visible: boolean): void {
  canvas.hidden = !visible;
  canvas.style.display = visible ? "block" : "none";
  canvas.style.visibility = visible ? "visible" : "hidden";
}

/** Dedicated Three/WebGL pass for the screen-space FrontCanvas rule Image. */
export class AdvRuleTransitionPass {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly uniforms: TransitionUniforms = {
    uRuleTexture: { value: null },
    uScreenSize: { value: new Vector2(1, 1) },
    uColor: { value: new Vector4(0, 0, 0, 1) },
    uValue: { value: 1 },
    uUseGradient: { value: 0 },
  };
  private readonly material = new ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: UNITY_RULE_TRANSITION_FRAGMENT_SHADER,
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: true,
    toneMapped: false,
  });
  private readonly quad = new Mesh(this.geometry, this.material);
  private readonly drawingBufferSize = new Vector2();
  private requestedWidth = 1;
  private requestedHeight = 1;
  private requestedPixelRatio = 1;
  private canvasVisible = false;
  private disposed = false;

  constructor(layer: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "adv-rule-transition-canvas";
    Object.assign(this.canvas.style, {
      width: "100%",
      height: "100%",
      pointerEvents: "none",
    });
    setAdvRuleTransitionCanvasVisible(this.canvas, false);
    const context = this.canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!context) throw new Error("UI/Transition requires WebGL2");
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      context,
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);
    // The transition layer is inactive for almost the entire story. Keep its
    // dedicated default framebuffer at 1x1 until it is actually composited;
    // otherwise a hidden canvas retains another full-resolution RGBA backing
    // store (in addition to the main renderer and post targets).
    this.renderer.setSize(1, 1, false);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    layer.replaceChildren(this.canvas);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    if (this.disposed) return;
    this.requestedWidth = Math.max(1, Number(width) || 1);
    this.requestedHeight = Math.max(1, Number(height) || 1);
    this.requestedPixelRatio = Math.max(0.1, Number(pixelRatio) || 1);
    if (this.canvasVisible) this.applyRequestedSize();
  }

  render(state: AdvRuleTransitionRenderState | null): void {
    if (this.disposed) return;
    if (!state?.visible) {
      this.uniforms.uRuleTexture.value = null;
      if (!this.canvasVisible) return;
      // preserveDrawingBuffer=false leaves the inactive buffer undefined.
      // WebKit may otherwise keep compositing the last opaque transition
      // frame even after the controller reaches its transparent terminal
      // state. Commit a transparent frame before removing the layer.
      this.renderer.setRenderTarget(null);
      this.renderer.clear(true, false, false);
      this.renderer.getContext().flush();
      // Release the inactive full-size default framebuffer immediately. The
      // requested CSS/pixel size is retained and restored before the next draw.
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(1, 1, false);
      this.canvasVisible = false;
      setAdvRuleTransitionCanvasVisible(this.canvas, false);
      return;
    }
    if (!this.canvasVisible) this.applyRequestedSize();
    this.canvasVisible = true;
    setAdvRuleTransitionCanvasVisible(this.canvas, true);
    this.uniforms.uRuleTexture.value = state.texture;
    this.uniforms.uColor.value.set(state.color.r, state.color.g, state.color.b, state.colorAlpha);
    this.uniforms.uValue.value = state.value;
    this.uniforms.uUseGradient.value = state.useGradient ? 1 : 0;
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    this.uniforms.uScreenSize.value.copy(this.drawingBufferSize);
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.scene, this.camera);
  }

  private applyRequestedSize(): void {
    this.renderer.setPixelRatio(this.requestedPixelRatio);
    this.renderer.setSize(this.requestedWidth, this.requestedHeight, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.canvasVisible = false;
    setAdvRuleTransitionCanvasVisible(this.canvas, false);
    this.scene.remove(this.quad);
    this.uniforms.uRuleTexture.value = null;
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.disposed = true;
  }
}
