import type { Camera, WebGLRenderTarget } from "three";
import { AdvBokehDepthOfField } from "./AdvBokehDepthOfField";
import { AdvColorGradingLut } from "./AdvColorGradingLut";
import { AdvGaussianDepthOfField } from "./AdvGaussianDepthOfField";
import { AdvHdrColorGradingLut } from "./AdvHdrColorGradingLut";
import { AdvMotionBlur } from "./AdvMotionBlur";
import { AdvPaniniProjection } from "./AdvPaniniProjection";
import { AdvUrpBloom } from "./AdvUrpBloom";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";
import { AdvUrpUberPost } from "./AdvUrpUberPost";
import {
  createDefaultAdvUrpVolumeState,
  resolveAdvVolumeStack,
  type AdvUrpVolumeState,
  type AdvVolumeLayer,
} from "./AdvVolumeStack";

export type AdvColorGradingPipelineMode = "ldr" | "hdr";

/**
 * Compatibility-mode URP post chain used by the ADV camera:
 * DepthOfField -> CameraMotionBlur -> Panini -> ColorGradingLutPass -> Bloom -> UberPost.
 *
 * CurvedLens remains outside this class because its RendererFeature is queued
 * at RenderPassEvent 600, after URP post processing.
 */
export class AdvUrpPostProcessor {
  private readonly gaussianDepthOfField = new AdvGaussianDepthOfField();
  private readonly bokehDepthOfField = new AdvBokehDepthOfField();
  private readonly motionBlur = new AdvMotionBlur();
  private readonly paniniProjection = new AdvPaniniProjection();
  private readonly bloom = new AdvUrpBloom();
  private readonly lut = new AdvColorGradingLut();
  private readonly hdrLut = new AdvHdrColorGradingLut();
  private readonly uber = new AdvUrpUberPost();
  private volumeState: AdvUrpVolumeState = createDefaultAdvUrpVolumeState();
  private frameCount = 0;
  private colorGradingMode: AdvColorGradingPipelineMode = "ldr";

  get currentVolumeState(): Readonly<AdvUrpVolumeState> {
    return this.volumeState;
  }

  setVolumeLayers(layers: readonly AdvVolumeLayer[]): void {
    this.volumeState = resolveAdvVolumeStack(layers);
  }

  setColorGradingMode(mode: AdvColorGradingPipelineMode): void {
    this.colorGradingMode = mode === "hdr" ? "hdr" : "ldr";
  }

  render(
    source: WebGLRenderTarget,
    destination: WebGLRenderTarget,
    renderFullscreen: AdvRenderFullscreen,
    camera: Camera | null,
  ): WebGLRenderTarget {
    // URP ping-pongs full-resolution passes. The caller's main/temp pair is no
    // longer needed for scene submission once this method begins, so it is the
    // exact allocation-free equivalent of GetSource()/GetDestination().
    let current = source;
    let next = destination;
    if (
      this.gaussianDepthOfField.render(current, next, this.volumeState.depthOfField, renderFullscreen) ||
      this.bokehDepthOfField.render(current, next, this.volumeState.depthOfField, renderFullscreen)
    ) {
      const previous = current;
      current = next;
      next = previous;
    }
    if (this.motionBlur.render(current, next, this.volumeState.motionBlur, renderFullscreen, camera)) {
      const previous = current;
      current = next;
      next = previous;
    }
    if (this.paniniProjection.render(current, next, this.volumeState.paniniProjection, renderFullscreen, camera)) {
      const previous = current;
      current = next;
      next = previous;
    }

    const hdrGrading = this.colorGradingMode === "hdr";
    const internalLut = hdrGrading
      ? this.hdrLut.render(this.volumeState, renderFullscreen)
      : this.lut.render(this.volumeState, renderFullscreen);
    const bloom = this.bloom.render(
      current.texture,
      current.width,
      current.height,
      this.volumeState.bloom,
      renderFullscreen,
    );
    this.uber.render(
      current,
      next,
      this.volumeState,
      internalLut,
      bloom,
      hdrGrading,
      this.frameCount,
      renderFullscreen,
    );
    this.frameCount += 1;
    return next;
  }

  dispose(): void {
    this.gaussianDepthOfField.dispose();
    this.bokehDepthOfField.dispose();
    this.motionBlur.dispose();
    this.paniniProjection.dispose();
    this.bloom.dispose();
    this.lut.dispose();
    this.hdrLut.dispose();
    this.uber.dispose();
  }
}
