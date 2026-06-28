import { UnsignedByteType, UnsignedShortType } from "three";
import type { TextureDataType } from "three";

export type AdvFieldTargetPrecision = "rgba16-unorm" | "rgba8-unorm";

export interface AdvFieldTargetFormat {
  readonly precision: AdvFieldTargetPrecision;
  readonly textureType: TextureDataType;
  readonly normalized: boolean;
}

const RGBA16_UNORM: AdvFieldTargetFormat = Object.freeze({
  precision: "rgba16-unorm",
  textureType: UnsignedShortType,
  normalized: true,
});

const RGBA8_UNORM: AdvFieldTargetFormat = Object.freeze({
  precision: "rgba8-unorm",
  textureType: UnsignedByteType,
  normalized: false,
});

/** Pure capability decision kept separate from the WebGL probe for regression tests. */
export function selectAdvFieldTargetFormat(rgba16UnormRenderable: boolean): AdvFieldTargetFormat {
  return rgba16UnormRenderable ? RGBA16_UNORM : RGBA8_UNORM;
}

/**
 * Verifies the exact sampled-and-renderable texture format used by the ADV
 * field. Extension presence alone is insufficient: a driver may expose the
 * enum while rejecting the framebuffer attachment.
 */
export function supportsRenderableRgba16Unorm(gl: WebGL2RenderingContext): boolean {
  const extension = gl.getExtension("EXT_texture_norm16");
  if (!extension || gl.isContextLost()) return false;

  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    return false;
  }

  const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const previousDrawFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const previousReadFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  let complete = false;

  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, extension.RGBA16_EXT, 1, 1, 0, gl.RGBA, gl.UNSIGNED_SHORT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    complete = false;
  } finally {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDrawFramebuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousReadFramebuffer);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    // Do not leak a failed probe's INVALID_ENUM/INVALID_OPERATION into Three.
    gl.getError();
  }

  return complete;
}

export function detectAdvFieldTargetFormat(gl: WebGL2RenderingContext): AdvFieldTargetFormat {
  return selectAdvFieldTargetFormat(supportsRenderableRgba16Unorm(gl));
}
