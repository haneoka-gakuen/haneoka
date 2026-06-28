// @ts-nocheck -- upstream Cubism Web Framework 5-r.3 is not strict-null typed
/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { CubismMatrix44 } from '../math/cubismmatrix44';
import { CubismModel } from '../model/cubismmodel';
import {
  bindUnityCubismMissingNormal,
  UNITY_CUBISM_NORMAL_ATTRIBUTE_LOCATION,
  UNITY_CUBISM_POSITION_ATTRIBUTE_LOCATION,
  UNITY_CUBISM_UV_ATTRIBUTE_LOCATION
} from '../../../rendering/cubism/UnityCubismVertexDefaults';
import { csmRect } from '../type/csmrectf';
import { csmVector } from '../type/csmvector';
import { CubismLogError } from '../utils/cubismdebug';
import { CubismBlendMode, CubismTextureColor } from './cubismrenderer';
import { CubismRenderer_WebGL } from './cubismrenderer_webgl';

let s_instance: CubismShaderManager_WebGL; // インスタンス（シングルトン）
const ShaderCount = 10; // シェーダーの数 = マスク生成用 + (通常用 + 加算 + 乗算) * (マスク無の乗算済アルファ対応版 + マスク有の乗算済アルファ対応版 + マスク有反転の乗算済アルファ対応版)

/**
 * WebGL用のシェーダープログラムを生成・破棄するクラス
 */
export class CubismShader_WebGL {
  /**
   * コンストラクタ
   */
  public constructor() {
    this._shaderSets = new csmVector<CubismShaderSet>();
    this._baseColor = new CubismTextureColor();
    this._multiplyColor = new CubismTextureColor();
    this._screenColor = new CubismTextureColor();
  }

  private getUnityAdvProgramUploadState(
    program: WebGLProgram
  ): UnityAdvProgramUploadState {
    let state = this._unityAdvProgramUploadStates.get(program);
    if (!state) {
      state = {
        samplerUnitsInitialized: false,
        drawRendererToken: null,
        drawGenerationToken: -1,
        lightingToken: null,
        additionalLightsToken: null,
        multiplyParametersToken: null
      };
      this._unityAdvProgramUploadStates.set(program, state);
    }
    return state;
  }

  /**
   * デストラクタ相当の処理
   */
  public release(): void {
    this.releaseShaderProgram();
  }

  /** Drawableごとの動的頂点VBOをbindし、同一モデル描画内では一度だけ更新する。 */
  private bindDrawableVertices(
    renderer: CubismRenderer_WebGL,
    model: Readonly<CubismModel>,
    index: number,
    attributeLocation: number
  ): void {
    const buffers = renderer._bufferData;
    let buffer = buffers.vertex[index];
    const vertices: Float32Array = model.getDrawableVertices(index);
    if (buffer == null) {
      buffer = this.gl.createBuffer();
      buffers.vertex[index] = buffer;
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.DYNAMIC_DRAW);
      buffers.vertexByteLength[index] = vertices.byteLength;
      buffers.vertexGeneration[index] = renderer._drawGeneration;
    } else {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
      if (buffers.vertexGeneration[index] !== renderer._drawGeneration) {
        if (buffers.vertexByteLength[index] !== vertices.byteLength) {
          this.gl.bufferData(
            this.gl.ARRAY_BUFFER,
            vertices,
            this.gl.DYNAMIC_DRAW
          );
          buffers.vertexByteLength[index] = vertices.byteLength;
        } else if (model.getDrawableDynamicFlagVertexPositionsDidChange(index)) {
          this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, vertices);
        }
        buffers.vertexGeneration[index] = renderer._drawGeneration;
      }
    }
    this.gl.enableVertexAttribArray(attributeLocation);
    this.gl.vertexAttribPointer(attributeLocation, 2, this.gl.FLOAT, false, 0, 0);
  }

  /** UVはモデル生成後に不変なのでdrawable専用VBOへ一度だけ転送する。 */
  private bindDrawableUvs(
    renderer: CubismRenderer_WebGL,
    model: Readonly<CubismModel>,
    index: number,
    attributeLocation: number
  ): void {
    const buffers = renderer._bufferData;
    let buffer = buffers.uv[index];
    if (buffer == null) {
      buffer = this.gl.createBuffer();
      buffers.uv[index] = buffer;
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
      this.gl.bufferData(
        this.gl.ARRAY_BUFFER,
        model.getDrawableVertexUvs(index),
        this.gl.STATIC_DRAW
      );
    } else {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    }
    this.gl.enableVertexAttribArray(attributeLocation);
    this.gl.vertexAttribPointer(attributeLocation, 2, this.gl.FLOAT, false, 0, 0);
  }

  /** index配列も不変なのでdrawable専用IBOへ一度だけ転送する。 */
  private bindDrawableIndices(
    renderer: CubismRenderer_WebGL,
    model: Readonly<CubismModel>,
    index: number
  ): void {
    const buffers = renderer._bufferData;
    let buffer = buffers.index[index];
    if (buffer == null) {
      buffer = this.gl.createBuffer();
      buffers.index[index] = buffer;
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, buffer);
      this.gl.bufferData(
        this.gl.ELEMENT_ARRAY_BUFFER,
        model.getDrawableVertexIndices(index),
        this.gl.STATIC_DRAW
      );
    } else {
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, buffer);
    }
  }

  /**
   * 描画用のシェーダプログラムの一連のセットアップを実行する
   * @param renderer レンダラー
   * @param model 描画対象のモデル
   * @param index 描画対象のメッシュのインデックス
   */
  public setupShaderProgramForDraw(
    renderer: CubismRenderer_WebGL,
    model: Readonly<CubismModel>,
    index: number
  ): void {
    if (!renderer.isPremultipliedAlpha()) {
      CubismLogError('NoPremultipliedAlpha is not allowed');
    }

    if (this._shaderSets.getSize() == 0) {
      this.generateShaders();
    }

    // Blending
    let srcColor: number;
    let dstColor: number;
    let srcAlpha: number;
    let dstAlpha: number;

    // _shaderSets用のオフセット計算
    const masked: boolean = renderer.getClippingContextBufferForDraw() != null; // この描画オブジェクトはマスク対象か
    const invertedMask: boolean = model.getDrawableInvertedMaskBit(index);
    const offset: number = masked ? (invertedMask ? 2 : 1) : 0;

    let shaderSet: CubismShaderSet;
    const drawableBlendMode = model.getDrawableBlendMode(index);
    switch (drawableBlendMode) {
      case CubismBlendMode.CubismBlendMode_Normal:
      default:
        shaderSet = this._shaderSets.at(
          ShaderNames.ShaderNames_NormalPremultipliedAlpha + offset
        );
        srcColor = this.gl.ONE;
        dstColor = this.gl.ONE_MINUS_SRC_ALPHA;
        srcAlpha = this.gl.ONE;
        dstAlpha = this.gl.ONE_MINUS_SRC_ALPHA;
        break;

      case CubismBlendMode.CubismBlendMode_Additive:
        shaderSet = this._shaderSets.at(
          ShaderNames.ShaderNames_AddPremultipliedAlpha + offset
        );
        srcColor = this.gl.ONE;
        dstColor = this.gl.ONE;
        srcAlpha = this.gl.ZERO;
        dstAlpha = this.gl.ONE;
        break;

      case CubismBlendMode.CubismBlendMode_Multiplicative:
        shaderSet = this._shaderSets.at(
          ShaderNames.ShaderNames_MultPremultipliedAlpha + offset
        );
        srcColor = this.gl.DST_COLOR;
        dstColor = this.gl.ONE_MINUS_SRC_ALPHA;
        srcAlpha = this.gl.ZERO;
        dstAlpha = this.gl.ONE;
        break;
    }

    this.gl.useProgram(shaderSet.shaderProgram);
    const uploadState = this.getUnityAdvProgramUploadState(
      shaderSet.shaderProgram
    );

    // Cubism Core supplies position/UV only. Unity's native vertex-stream
    // fallback supplies NORMAL0=(0,0,+1,0), which the High/Best ADV lighting
    // shader consumes. A generic attribute avoids a redundant normal buffer.
    bindUnityCubismMissingNormal(this.gl);

    this.bindDrawableVertices(
      renderer,
      model,
      index,
      shaderSet.attributePositionLocation
    );
    this.bindDrawableUvs(
      renderer,
      model,
      index,
      shaderSet.attributeTexCoordLocation
    );

    if (masked) {
      this.gl.activeTexture(this.gl.TEXTURE1);

      // frameBufferに書かれたテクスチャ
      const tex: WebGLTexture = renderer
        .getClippingContextBufferForDraw()
        .getClippingManager()
        .getColorBuffer()
        .at(renderer.getClippingContextBufferForDraw()._bufferIndex);
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);

      // view座標をClippingContextの座標に変換するための行列を設定
      this.gl.uniformMatrix4fv(
        shaderSet.uniformClipMatrixLocation,
        false,
        renderer.getClippingContextBufferForDraw()._matrixForDraw.getArray()
      );

      // 使用するカラーチャンネルを設定
      const channelIndex: number =
        renderer.getClippingContextBufferForDraw()._layoutChannelIndex;
      const colorChannel: CubismTextureColor = renderer
        .getClippingContextBufferForDraw()
        .getClippingManager()
        .getChannelFlagAsColor(channelIndex);
      this.gl.uniform4f(
        shaderSet.uniformChannelFlagLocation,
        colorChannel.r,
        colorChannel.g,
        colorChannel.b,
        colorChannel.a
      );
    }

    // テクスチャ設定
    const textureNo: number = model.getDrawableTextureIndex(index);
    const textureId: WebGLTexture = renderer
      .getBindedTextures()
      .getValue(textureNo);
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, textureId);

    // The compatible fragment path samples `_MultiplyTex` even when the use
    // flag is zero. Keep a complete texture bound; an absent property uses the
    // drawable's main texture and is algebraically ignored.
    const multiplyTexture = renderer.getUnityAdvMultiplyTexture();
    this.gl.activeTexture(this.gl.TEXTURE2);
    this.gl.bindTexture(
      this.gl.TEXTURE_2D,
      multiplyTexture || textureId
    );
    if (!uploadState.samplerUnitsInitialized) {
      this.gl.uniform1i(shaderSet.samplerTexture0Location, 0);
      this.gl.uniform1i(shaderSet.samplerMultiplyTextureLocation, 2);
      if (masked) this.gl.uniform1i(shaderSet.samplerTexture1Location, 1);
      uploadState.samplerUnitsInitialized = true;
    }

    //座標変換
    const matrix4x4: CubismMatrix44 = renderer.getMvpMatrix();
    if (
      uploadState.drawRendererToken !== renderer ||
      uploadState.drawGenerationToken !== renderer._drawGeneration
    ) {
      this.gl.uniformMatrix4fv(
        shaderSet.uniformMatrixLocation,
        false,
        matrix4x4.getArray()
      );
      this.gl.uniformMatrix4fv(
        shaderSet.uniformObjectToWorldLocation,
        false,
        renderer.getUnityAdvObjectToWorld()
      );
      this.gl.uniform1f(
        shaderSet.uniformTimeSecondsLocation,
        renderer.getUnityAdvTimeSeconds()
      );
      uploadState.drawRendererToken = renderer;
      uploadState.drawGenerationToken = renderer._drawGeneration;
    }

    // Unity's CubismRenderer uploads _RendererColor.rgb without premultiplying
    // it. The packaged ADV fragment program performs the sole RGB*alpha at its
    // exit; Cubism Web's stock getModelColorWithOpacity() would apply drawable
    // opacity to RGB here and therefore square the opacity in that program.
    const baseColor: CubismTextureColor = renderer.getModelColorInto(
      this._baseColor
    );
    baseColor.a *= model.getDrawableOpacity(index);
    const multiplyColor: CubismTextureColor = model.getMultiplyColorInto(
      index,
      this._multiplyColor
    );
    const screenColor: CubismTextureColor = model.getScreenColorInto(
      index,
      this._screenColor
    );

    this.gl.uniform4f(
      shaderSet.uniformBaseColorLocation,
      baseColor.r,
      baseColor.g,
      baseColor.b,
      baseColor.a
    );

    this.gl.uniform4f(
      shaderSet.uniformMultiplyColorLocation,
      multiplyColor.r,
      multiplyColor.g,
      multiplyColor.b,
      multiplyColor.a
    );

    this.gl.uniform4f(
      shaderSet.uniformScreenColorLocation,
      screenColor.r,
      screenColor.g,
      screenColor.b,
      screenColor.a
    );

    const lighting = renderer.getUnityAdvLightingState();
    const lightingEnabled =
      lighting.enabled &&
      !(
        lighting.disableForMultiplicativeDrawables &&
        drawableBlendMode === CubismBlendMode.CubismBlendMode_Multiplicative
      );
    this.gl.uniform1f(
      shaderSet.uniformLightingEnabledLocation,
      lightingEnabled ? 1 : 0
    );
    if (uploadState.lightingToken !== lighting) {
      const sh = lighting.sphericalHarmonics;
      this.gl.uniform4fv(
        shaderSet.uniformMainLightPositionLocation,
        lighting.mainLightPosition
      );
      this.gl.uniform3fv(
        shaderSet.uniformMainLightColorLocation,
        lighting.mainLightColor
      );
      this.gl.uniform4fv(shaderSet.uniformUnitySHArLocation, sh.ar);
      this.gl.uniform4fv(shaderSet.uniformUnitySHAgLocation, sh.ag);
      this.gl.uniform4fv(shaderSet.uniformUnitySHAbLocation, sh.ab);
      this.gl.uniform4fv(shaderSet.uniformUnitySHBrLocation, sh.br);
      this.gl.uniform4fv(shaderSet.uniformUnitySHBgLocation, sh.bg);
      this.gl.uniform4fv(shaderSet.uniformUnitySHBbLocation, sh.bb);
      this.gl.uniform4fv(shaderSet.uniformUnitySHCLocation, sh.c);
      uploadState.lightingToken = lighting;
    }
    const additionalLights = renderer.getUnityAdvAdditionalLights();
    if (uploadState.additionalLightsToken !== additionalLights) {
      this.gl.uniform1f(
        shaderSet.uniformAdditionalLightCountLocation,
        additionalLights.count
      );
      if (additionalLights.count > 0) {
        const components = additionalLights.count * 4;
        this.gl.uniform4fv(
          shaderSet.uniformAdditionalLightPositionsLocation,
          additionalLights.positions.subarray(0, components)
        );
        this.gl.uniform4fv(
          shaderSet.uniformAdditionalLightColorsLocation,
          additionalLights.colors.subarray(0, components)
        );
        this.gl.uniform4fv(
          shaderSet.uniformAdditionalLightAttenuationsLocation,
          additionalLights.attenuations.subarray(0, components)
        );
        this.gl.uniform4fv(
          shaderSet.uniformAdditionalLightSpotDirectionsLocation,
          additionalLights.spotDirections.subarray(0, components)
        );
      }
      uploadState.additionalLightsToken = additionalLights;
    }
    const multiplyParameters =
      renderer.getUnityAdvMultiplyTextureParameters();
    if (uploadState.multiplyParametersToken !== multiplyParameters) {
      this.gl.uniform1f(
        shaderSet.uniformUseMultiplyTextureLocation,
        multiplyParameters.enabled ? 1 : 0
      );
      this.gl.uniform4fv(
        shaderSet.uniformMultiplyUvLocation,
        multiplyParameters.uv
      );
      this.gl.uniform1f(
        shaderSet.uniformMultiplyTextureIntensityLocation,
        multiplyParameters.intensity
      );
      this.gl.uniform2fv(
        shaderSet.uniformMultiplyTextureAmplitudeLocation,
        multiplyParameters.amplitude
      );
      this.gl.uniform1f(
        shaderSet.uniformMultiplyTextureFrequencyLocation,
        multiplyParameters.frequency
      );
      uploadState.multiplyParametersToken = multiplyParameters;
    }

    this.bindDrawableIndices(renderer, model, index);

    this.gl.blendFuncSeparate(srcColor, dstColor, srcAlpha, dstAlpha);
  }

  /**
   * マスク用のシェーダプログラムの一連のセットアップを実行する
   * @param renderer レンダラー
   * @param model 描画対象のモデル
   * @param index 描画対象のメッシュのインデックス
   */
  public setupShaderProgramForMask(
    renderer: CubismRenderer_WebGL,
    model: Readonly<CubismModel>,
    index: number
  ): void {
    if (!renderer.isPremultipliedAlpha()) {
      CubismLogError('NoPremultipliedAlpha is not allowed');
    }

    if (this._shaderSets.getSize() == 0) {
      this.generateShaders();
    }

    const shaderSet: CubismShaderSet = this._shaderSets.at(
      ShaderNames.ShaderNames_SetupMask
    );
    this.gl.useProgram(shaderSet.shaderProgram);
    const uploadState = this.getUnityAdvProgramUploadState(
      shaderSet.shaderProgram
    );

    this.bindDrawableVertices(
      renderer,
      model,
      index,
      shaderSet.attributePositionLocation
    );

    //テクスチャ設定
    const textureNo: number = model.getDrawableTextureIndex(index);
    const textureId: WebGLTexture = renderer
      .getBindedTextures()
      .getValue(textureNo);
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, textureId);
    if (!uploadState.samplerUnitsInitialized) {
      this.gl.uniform1i(shaderSet.samplerTexture0Location, 0);
      uploadState.samplerUnitsInitialized = true;
    }

    this.bindDrawableUvs(
      renderer,
      model,
      index,
      shaderSet.attributeTexCoordLocation
    );

    // チャンネル
    const context = renderer.getClippingContextBufferForMask();
    const channelIndex: number =
      renderer.getClippingContextBufferForMask()._layoutChannelIndex;
    const colorChannel: CubismTextureColor = renderer
      .getClippingContextBufferForMask()
      .getClippingManager()
      .getChannelFlagAsColor(channelIndex);
    this.gl.uniform4f(
      shaderSet.uniformChannelFlagLocation,
      colorChannel.r,
      colorChannel.g,
      colorChannel.b,
      colorChannel.a
    );

    this.gl.uniformMatrix4fv(
      shaderSet.uniformClipMatrixLocation,
      false,
      renderer.getClippingContextBufferForMask()._matrixForMask.getArray()
    );

    const rect: csmRect =
      renderer.getClippingContextBufferForMask()._layoutBounds;

    this.gl.uniform4f(
      shaderSet.uniformBaseColorLocation,
      rect.x * 2.0 - 1.0,
      rect.y * 2.0 - 1.0,
      rect.getRight() * 2.0 - 1.0,
      rect.getBottom() * 2.0 - 1.0
    );

    const multiplyColor: CubismTextureColor = model.getMultiplyColorInto(
      index,
      this._multiplyColor
    );
    const screenColor: CubismTextureColor = model.getScreenColorInto(
      index,
      this._screenColor
    );

    this.gl.uniform4f(
      shaderSet.uniformMultiplyColorLocation,
      multiplyColor.r,
      multiplyColor.g,
      multiplyColor.b,
      multiplyColor.a
    );

    this.gl.uniform4f(
      shaderSet.uniformScreenColorLocation,
      screenColor.r,
      screenColor.g,
      screenColor.b,
      screenColor.a
    );

    // Blending
    const srcColor: number = this.gl.ZERO;
    const dstColor: number = this.gl.ONE_MINUS_SRC_COLOR;
    const srcAlpha: number = this.gl.ZERO;
    const dstAlpha: number = this.gl.ONE_MINUS_SRC_ALPHA;

    this.bindDrawableIndices(renderer, model, index);

    this.gl.blendFuncSeparate(srcColor, dstColor, srcAlpha, dstAlpha);
  }

  /**
   * シェーダープログラムを解放する
   */
  public releaseShaderProgram(): void {
    for (let i = 0; i < this._shaderSets.getSize(); i++) {
      this.gl.deleteProgram(this._shaderSets.at(i).shaderProgram);
      this._shaderSets.at(i).shaderProgram = 0;
      this._shaderSets.set(i, void 0);
      this._shaderSets.set(i, null);
    }
  }

  /**
   * シェーダープログラムを初期化する
   * @param vertShaderSrc 頂点シェーダのソース
   * @param fragShaderSrc フラグメントシェーダのソース
   */
  public generateShaders(): void {
    for (let i = 0; i < ShaderCount; i++) {
      this._shaderSets.pushBack(new CubismShaderSet());
    }

    this._shaderSets.at(0).shaderProgram = this.loadShaderProgram(
      vertexShaderSrcSetupMask,
      fragmentShaderSrcsetupMask
    );

    this._shaderSets.at(1).shaderProgram = this.loadShaderProgram(
      vertexShaderSrc,
      fragmentShaderSrcPremultipliedAlpha
    );
    this._shaderSets.at(2).shaderProgram = this.loadShaderProgram(
      vertexShaderSrcMasked,
      fragmentShaderSrcMaskPremultipliedAlpha
    );
    this._shaderSets.at(3).shaderProgram = this.loadShaderProgram(
      vertexShaderSrcMasked,
      fragmentShaderSrcMaskInvertedPremultipliedAlpha
    );

    // 加算も通常と同じシェーダーを利用する
    this._shaderSets.at(4).shaderProgram = this._shaderSets.at(1).shaderProgram;
    this._shaderSets.at(5).shaderProgram = this._shaderSets.at(2).shaderProgram;
    this._shaderSets.at(6).shaderProgram = this._shaderSets.at(3).shaderProgram;

    // 乗算も通常と同じシェーダーを利用する
    this._shaderSets.at(7).shaderProgram = this._shaderSets.at(1).shaderProgram;
    this._shaderSets.at(8).shaderProgram = this._shaderSets.at(2).shaderProgram;
    this._shaderSets.at(9).shaderProgram = this._shaderSets.at(3).shaderProgram;

    // SetupMask
    this._shaderSets.at(0).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(0).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(0).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(0).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(0).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(0).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(0).uniformClipMatrixLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(0).shaderProgram,
        'u_clipMatrix'
      );
    this._shaderSets.at(0).uniformChannelFlagLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(0).shaderProgram,
        'u_channelFlag'
      );
    this._shaderSets.at(0).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(0).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(0).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(0).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(0).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(0).shaderProgram,
        'u_screenColor'
      );

    // 通常（PremultipliedAlpha）
    this._shaderSets.at(1).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(1).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(1).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(1).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(1).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(1).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(1).uniformMatrixLocation = this.gl.getUniformLocation(
      this._shaderSets.at(1).shaderProgram,
      'u_matrix'
    );
    this._shaderSets.at(1).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(1).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(1).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(1).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(1).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(1).shaderProgram,
        'u_screenColor'
      );

    // 通常（クリッピング、PremultipliedAlpha）
    this._shaderSets.at(2).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(2).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(2).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(2).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(2).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(2).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(2).samplerTexture1Location = this.gl.getUniformLocation(
      this._shaderSets.at(2).shaderProgram,
      's_texture1'
    );
    this._shaderSets.at(2).uniformMatrixLocation = this.gl.getUniformLocation(
      this._shaderSets.at(2).shaderProgram,
      'u_matrix'
    );
    this._shaderSets.at(2).uniformClipMatrixLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(2).shaderProgram,
        'u_clipMatrix'
      );
    this._shaderSets.at(2).uniformChannelFlagLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(2).shaderProgram,
        'u_channelFlag'
      );
    this._shaderSets.at(2).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(2).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(2).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(2).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(2).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(2).shaderProgram,
        'u_screenColor'
      );

    // 通常（クリッピング・反転, PremultipliedAlpha）
    this._shaderSets.at(3).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(3).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(3).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(3).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(3).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(3).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(3).samplerTexture1Location = this.gl.getUniformLocation(
      this._shaderSets.at(3).shaderProgram,
      's_texture1'
    );
    this._shaderSets.at(3).uniformMatrixLocation = this.gl.getUniformLocation(
      this._shaderSets.at(3).shaderProgram,
      'u_matrix'
    );
    this._shaderSets.at(3).uniformClipMatrixLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(3).shaderProgram,
        'u_clipMatrix'
      );
    this._shaderSets.at(3).uniformChannelFlagLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(3).shaderProgram,
        'u_channelFlag'
      );
    this._shaderSets.at(3).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(3).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(3).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(3).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(3).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(3).shaderProgram,
        'u_screenColor'
      );

    // 加算（PremultipliedAlpha）
    this._shaderSets.at(4).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(4).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(4).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(4).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(4).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(4).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(4).uniformMatrixLocation = this.gl.getUniformLocation(
      this._shaderSets.at(4).shaderProgram,
      'u_matrix'
    );
    this._shaderSets.at(4).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(4).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(4).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(4).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(4).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(4).shaderProgram,
        'u_screenColor'
      );

    // 加算（クリッピング、PremultipliedAlpha）
    this._shaderSets.at(5).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(5).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(5).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(5).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(5).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(5).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(5).samplerTexture1Location = this.gl.getUniformLocation(
      this._shaderSets.at(5).shaderProgram,
      's_texture1'
    );
    this._shaderSets.at(5).uniformMatrixLocation = this.gl.getUniformLocation(
      this._shaderSets.at(5).shaderProgram,
      'u_matrix'
    );
    this._shaderSets.at(5).uniformClipMatrixLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(5).shaderProgram,
        'u_clipMatrix'
      );
    this._shaderSets.at(5).uniformChannelFlagLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(5).shaderProgram,
        'u_channelFlag'
      );
    this._shaderSets.at(5).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(5).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(5).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(5).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(5).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(5).shaderProgram,
        'u_screenColor'
      );

    // 加算（クリッピング・反転、PremultipliedAlpha）
    this._shaderSets.at(6).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(6).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(6).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(6).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(6).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(6).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(6).samplerTexture1Location = this.gl.getUniformLocation(
      this._shaderSets.at(6).shaderProgram,
      's_texture1'
    );
    this._shaderSets.at(6).uniformMatrixLocation = this.gl.getUniformLocation(
      this._shaderSets.at(6).shaderProgram,
      'u_matrix'
    );
    this._shaderSets.at(6).uniformClipMatrixLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(6).shaderProgram,
        'u_clipMatrix'
      );
    this._shaderSets.at(6).uniformChannelFlagLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(6).shaderProgram,
        'u_channelFlag'
      );
    this._shaderSets.at(6).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(6).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(6).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(6).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(6).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(6).shaderProgram,
        'u_screenColor'
      );

    // 乗算（PremultipliedAlpha）
    this._shaderSets.at(7).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(7).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(7).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(7).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(7).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(7).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(7).uniformMatrixLocation = this.gl.getUniformLocation(
      this._shaderSets.at(7).shaderProgram,
      'u_matrix'
    );
    this._shaderSets.at(7).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(7).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(7).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(7).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(7).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(7).shaderProgram,
        'u_screenColor'
      );

    // 乗算（クリッピング、PremultipliedAlpha）
    this._shaderSets.at(8).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(8).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(8).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(8).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(8).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(8).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(8).samplerTexture1Location = this.gl.getUniformLocation(
      this._shaderSets.at(8).shaderProgram,
      's_texture1'
    );
    this._shaderSets.at(8).uniformMatrixLocation = this.gl.getUniformLocation(
      this._shaderSets.at(8).shaderProgram,
      'u_matrix'
    );
    this._shaderSets.at(8).uniformClipMatrixLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(8).shaderProgram,
        'u_clipMatrix'
      );
    this._shaderSets.at(8).uniformChannelFlagLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(8).shaderProgram,
        'u_channelFlag'
      );
    this._shaderSets.at(8).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(8).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(8).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(8).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(8).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(8).shaderProgram,
        'u_screenColor'
      );

    // 乗算（クリッピング・反転、PremultipliedAlpha）
    this._shaderSets.at(9).attributePositionLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(9).shaderProgram,
        'a_position'
      );
    this._shaderSets.at(9).attributeTexCoordLocation =
      this.gl.getAttribLocation(
        this._shaderSets.at(9).shaderProgram,
        'a_texCoord'
      );
    this._shaderSets.at(9).samplerTexture0Location = this.gl.getUniformLocation(
      this._shaderSets.at(9).shaderProgram,
      's_texture0'
    );
    this._shaderSets.at(9).samplerTexture1Location = this.gl.getUniformLocation(
      this._shaderSets.at(9).shaderProgram,
      's_texture1'
    );
    this._shaderSets.at(9).uniformMatrixLocation = this.gl.getUniformLocation(
      this._shaderSets.at(9).shaderProgram,
      'u_matrix'
    );
    this._shaderSets.at(9).uniformClipMatrixLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(9).shaderProgram,
        'u_clipMatrix'
      );
    this._shaderSets.at(9).uniformChannelFlagLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(9).shaderProgram,
        'u_channelFlag'
      );
    this._shaderSets.at(9).uniformBaseColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(9).shaderProgram,
        'u_baseColor'
      );
    this._shaderSets.at(9).uniformMultiplyColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(9).shaderProgram,
        'u_multiplyColor'
      );
    this._shaderSets.at(9).uniformScreenColorLocation =
      this.gl.getUniformLocation(
        this._shaderSets.at(9).shaderProgram,
        'u_screenColor'
      );

    // Uniforms shared by all three blend modes of the ADV compatibility shader.
    // Programs 4-9 alias programs 1-3, matching Cubism's material variants.
    for (let index = 1; index < ShaderCount; index++) {
      const set = this._shaderSets.at(index);
      set.uniformObjectToWorldLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_objectToWorld'
      );
      set.samplerMultiplyTextureLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        's_multiplyTexture'
      );
      set.uniformLightingEnabledLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_lightingEnabled'
      );
      set.uniformMainLightPositionLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_mainLightPosition'
      );
      set.uniformMainLightColorLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_mainLightColor'
      );
      set.uniformAdditionalLightCountLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_additionalLightCount'
      );
      set.uniformAdditionalLightPositionsLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_additionalLightPositions[0]'
      );
      set.uniformAdditionalLightColorsLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_additionalLightColors[0]'
      );
      set.uniformAdditionalLightAttenuationsLocation =
        this.gl.getUniformLocation(
          set.shaderProgram,
          'u_additionalLightAttenuations[0]'
        );
      set.uniformAdditionalLightSpotDirectionsLocation =
        this.gl.getUniformLocation(
          set.shaderProgram,
          'u_additionalLightSpotDirections[0]'
        );
      set.uniformUnitySHArLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_unitySHAr'
      );
      set.uniformUnitySHAgLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_unitySHAg'
      );
      set.uniformUnitySHAbLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_unitySHAb'
      );
      set.uniformUnitySHBrLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_unitySHBr'
      );
      set.uniformUnitySHBgLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_unitySHBg'
      );
      set.uniformUnitySHBbLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_unitySHBb'
      );
      set.uniformUnitySHCLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_unitySHC'
      );
      set.uniformUseMultiplyTextureLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_useMultiplyTexture'
      );
      set.uniformMultiplyUvLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_multiplyUv'
      );
      set.uniformMultiplyTextureIntensityLocation =
        this.gl.getUniformLocation(
          set.shaderProgram,
          'u_multiplyTextureIntensity'
        );
      set.uniformMultiplyTextureAmplitudeLocation =
        this.gl.getUniformLocation(
          set.shaderProgram,
          'u_multiplyTextureAmplitude'
        );
      set.uniformMultiplyTextureFrequencyLocation =
        this.gl.getUniformLocation(
          set.shaderProgram,
          'u_multiplyTextureFrequency'
        );
      set.uniformTimeSecondsLocation = this.gl.getUniformLocation(
        set.shaderProgram,
        'u_timeSeconds'
      );
    }
  }

  /**
   * シェーダプログラムをロードしてアドレスを返す
   * @param vertexShaderSource    頂点シェーダのソース
   * @param fragmentShaderSource  フラグメントシェーダのソース
   * @return シェーダプログラムのアドレス
   */
  public loadShaderProgram(
    vertexShaderSource: string,
    fragmentShaderSource: string
  ): WebGLProgram {
    // Create Shader Program
    let shaderProgram: WebGLProgram = this.gl.createProgram();

    let vertShader = this.compileShaderSource(
      this.gl.VERTEX_SHADER,
      vertexShaderSource
    );

    if (!vertShader) {
      CubismLogError('Vertex shader compile error!');
      return 0;
    }

    let fragShader = this.compileShaderSource(
      this.gl.FRAGMENT_SHADER,
      fragmentShaderSource
    );
    if (!fragShader) {
      CubismLogError('Vertex shader compile error!');
      return 0;
    }

    // Attach vertex shader to program
    this.gl.attachShader(shaderProgram, vertShader);

    // Attach fragment shader to program
    this.gl.attachShader(shaderProgram, fragShader);

    // Keep the bridge layout deterministic. The stock shader currently uses
    // position/UV; ADV lit variants additionally consume a_normal.
    this.gl.bindAttribLocation(
      shaderProgram,
      UNITY_CUBISM_POSITION_ATTRIBUTE_LOCATION,
      'a_position'
    );
    this.gl.bindAttribLocation(
      shaderProgram,
      UNITY_CUBISM_UV_ATTRIBUTE_LOCATION,
      'a_texCoord'
    );
    this.gl.bindAttribLocation(
      shaderProgram,
      UNITY_CUBISM_NORMAL_ATTRIBUTE_LOCATION,
      'a_normal'
    );

    // link program
    this.gl.linkProgram(shaderProgram);
    const linkStatus = this.gl.getProgramParameter(
      shaderProgram,
      this.gl.LINK_STATUS
    );

    // リンクに失敗したらシェーダーを削除
    if (!linkStatus) {
      CubismLogError('Failed to link program: {0}', shaderProgram);

      this.gl.deleteShader(vertShader);
      vertShader = 0;

      this.gl.deleteShader(fragShader);
      fragShader = 0;

      if (shaderProgram) {
        this.gl.deleteProgram(shaderProgram);
        shaderProgram = 0;
      }

      return 0;
    }

    // Release vertex and fragment shaders.
    this.gl.deleteShader(vertShader);
    this.gl.deleteShader(fragShader);

    return shaderProgram;
  }

  /**
   * シェーダープログラムをコンパイルする
   * @param shaderType シェーダタイプ(Vertex/Fragment)
   * @param shaderSource シェーダソースコード
   *
   * @return コンパイルされたシェーダープログラム
   */
  public compileShaderSource(
    shaderType: GLenum,
    shaderSource: string
  ): WebGLProgram {
    const source: string = shaderSource;

    const shader: WebGLProgram = this.gl.createShader(shaderType);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!shader) {
      const log: string = this.gl.getShaderInfoLog(shader);
      CubismLogError('Shader compile log: {0} ', log);
    }

    const status: any = this.gl.getShaderParameter(
      shader,
      this.gl.COMPILE_STATUS
    );
    if (!status) {
      this.gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  public setGl(gl: WebGLRenderingContext): void {
    this.gl = gl;
  }

  _shaderSets: csmVector<CubismShaderSet>; // ロードしたシェーダープログラムを保持する変数
  private _baseColor: CubismTextureColor;
  private _multiplyColor: CubismTextureColor;
  private _screenColor: CubismTextureColor;
  private readonly _unityAdvProgramUploadStates = new WeakMap<
    WebGLProgram,
    UnityAdvProgramUploadState
  >();
  gl: WebGLRenderingContext; // webglコンテキスト
}

interface UnityAdvProgramUploadState {
  samplerUnitsInitialized: boolean;
  drawRendererToken: CubismRenderer_WebGL | null;
  drawGenerationToken: number;
  lightingToken: unknown;
  additionalLightsToken: unknown;
  multiplyParametersToken: unknown;
}

interface CubismShaderContextEntry {
  shader: CubismShader_WebGL;
  owners: number;
}

/**
 * GLContextごとにCubismShader_WebGLを確保するためのクラス
 * シングルトンなクラスであり、CubismShaderManager_WebGL.getInstanceからアクセスする。
 */
export class CubismShaderManager_WebGL {
  /**
   * インスタンスを取得する（シングルトン）
   * @return インスタンス
   */
  public static getInstance(): CubismShaderManager_WebGL {
    if (s_instance == null) {
      s_instance = new CubismShaderManager_WebGL();
    }
    return s_instance;
  }

  /**
   * インスタンスを開放する（シングルトン）
   */
  public static deleteInstance(): void {
    if (s_instance) {
      s_instance.release();
      s_instance = null;
    }
  }

  /**
   * Privateなコンストラクタ
   */
  private constructor() {
    this._shaderMap = new Map<
      WebGLRenderingContext,
      CubismShaderContextEntry
    >();
  }

  /**
   * デストラクタ相当の処理
   */
  public release(): void {
    for (const entry of this._shaderMap.values()) {
      entry.shader.release();
    }
    this._shaderMap.clear();
  }

  /**
   * GLContextをキーにShaderを取得する
   * @param gl
   * @returns
   */
  public getShader(gl: WebGLRenderingContext): CubismShader_WebGL {
    return this._shaderMap.get(gl)?.shader;
  }

  /**
   * GLContextのShaderへの所有権を取得する。
   * @param gl
   * @returns GLContextに対応するShader
   */
  public acquireGlContext(gl: WebGLRenderingContext): CubismShader_WebGL {
    let entry = this._shaderMap.get(gl);
    if (!entry) {
      const shader = new CubismShader_WebGL();
      shader.setGl(gl);
      entry = { shader, owners: 0 };
      this._shaderMap.set(gl, entry);
    }
    entry.owners += 1;
    return entry.shader;
  }

  /**
   * GLContextのShaderへの所有権を解放する。
   * 最後の所有者が解放した時だけShaderプログラムを破棄する。
   * @param gl
   */
  public releaseGlContext(gl: WebGLRenderingContext): void {
    const entry = this._shaderMap.get(gl);
    if (!entry) return;

    entry.owners -= 1;
    if (entry.owners > 0) return;

    entry.shader.release();
    this._shaderMap.delete(gl);
  }

  /**
   * GLContextを登録する
   * @param gl
   */
  public setGlContext(gl: WebGLRenderingContext): void {
    if (!this._shaderMap.has(gl)) this.acquireGlContext(gl);
  }

  /**
   * GLContextごとのShaderを保持する変数
   */
  private _shaderMap: Map<WebGLRenderingContext, CubismShaderContextEntry>;
}

/**
 * GLContextに対応する共有Cubism Shaderへの所有権を取得する。
 */
export function acquireCubismShaderContext(
  gl: WebGLRenderingContext
): CubismShader_WebGL {
  return CubismShaderManager_WebGL.getInstance().acquireGlContext(gl);
}

/**
 * GLContextに対応する共有Cubism Shaderへの所有権を解放する。
 */
export function releaseCubismShaderContext(
  gl: WebGLRenderingContext
): void {
  // 解放だけで空のマネージャーを再生成しない。
  s_instance?.releaseGlContext(gl);
}

/**
 * CubismShader_WebGLのインナークラス
 */
export class CubismShaderSet {
  shaderProgram: WebGLProgram; // シェーダープログラムのアドレス
  attributePositionLocation: GLuint; // シェーダープログラムに渡す変数のアドレス（Position）
  attributeTexCoordLocation: GLuint; // シェーダープログラムに渡す変数のアドレス（TexCoord）
  uniformMatrixLocation: WebGLUniformLocation; // シェーダープログラムに渡す変数のアドレス（Matrix）
  uniformClipMatrixLocation: WebGLUniformLocation; // シェーダープログラムに渡す変数のアドレス（ClipMatrix）
  samplerTexture0Location: WebGLUniformLocation; // シェーダープログラムに渡す変数のアドレス（Texture0）
  samplerTexture1Location: WebGLUniformLocation; // シェーダープログラムに渡す変数のアドレス（Texture1）
  uniformBaseColorLocation: WebGLUniformLocation; // シェーダープログラムに渡す変数のアドレス（BaseColor）
  uniformChannelFlagLocation: WebGLUniformLocation; // シェーダープログラムに渡す変数のアドレス（ChannelFlag）
  uniformMultiplyColorLocation: WebGLUniformLocation; // シェーダープログラムに渡す変数のアドレス（MultiplyColor）
  uniformScreenColorLocation: WebGLUniformLocation; // シェーダープログラムに渡す変数のアドレス（ScreenColor）
  uniformObjectToWorldLocation: WebGLUniformLocation;
  samplerMultiplyTextureLocation: WebGLUniformLocation;
  uniformLightingEnabledLocation: WebGLUniformLocation;
  uniformMainLightPositionLocation: WebGLUniformLocation;
  uniformMainLightColorLocation: WebGLUniformLocation;
  uniformAdditionalLightCountLocation: WebGLUniformLocation;
  uniformAdditionalLightPositionsLocation: WebGLUniformLocation;
  uniformAdditionalLightColorsLocation: WebGLUniformLocation;
  uniformAdditionalLightAttenuationsLocation: WebGLUniformLocation;
  uniformAdditionalLightSpotDirectionsLocation: WebGLUniformLocation;
  uniformUnitySHArLocation: WebGLUniformLocation;
  uniformUnitySHAgLocation: WebGLUniformLocation;
  uniformUnitySHAbLocation: WebGLUniformLocation;
  uniformUnitySHBrLocation: WebGLUniformLocation;
  uniformUnitySHBgLocation: WebGLUniformLocation;
  uniformUnitySHBbLocation: WebGLUniformLocation;
  uniformUnitySHCLocation: WebGLUniformLocation;
  uniformUseMultiplyTextureLocation: WebGLUniformLocation;
  uniformMultiplyUvLocation: WebGLUniformLocation;
  uniformMultiplyTextureIntensityLocation: WebGLUniformLocation;
  uniformMultiplyTextureAmplitudeLocation: WebGLUniformLocation;
  uniformMultiplyTextureFrequencyLocation: WebGLUniformLocation;
  uniformTimeSecondsLocation: WebGLUniformLocation;
}

export enum ShaderNames {
  // SetupMask
  ShaderNames_SetupMask,

  // Normal
  ShaderNames_NormalPremultipliedAlpha,
  ShaderNames_NormalMaskedPremultipliedAlpha,
  ShaderNames_NomralMaskedInvertedPremultipliedAlpha,

  // Add
  ShaderNames_AddPremultipliedAlpha,
  ShaderNames_AddMaskedPremultipliedAlpha,
  ShaderNames_AddMaskedPremultipliedAlphaInverted,

  // Mult
  ShaderNames_MultPremultipliedAlpha,
  ShaderNames_MultMaskedPremultipliedAlpha,
  ShaderNames_MultMaskedPremultipliedAlphaInverted
}

export const vertexShaderSrcSetupMask =
  'attribute vec4     a_position;' +
  'attribute vec2     a_texCoord;' +
  'varying vec2       v_texCoord;' +
  'varying vec4       v_myPos;' +
  'uniform mat4       u_clipMatrix;' +
  'void main()' +
  '{' +
  '   gl_Position = u_clipMatrix * a_position;' +
  '   v_myPos = u_clipMatrix * a_position;' +
  '   v_texCoord = a_texCoord;' +
  '   v_texCoord.y = 1.0 - v_texCoord.y;' +
  '}';

export const fragmentShaderSrcsetupMask =
  'precision mediump float;' +
  'varying vec2       v_texCoord;' +
  'varying vec4       v_myPos;' +
  'uniform vec4       u_baseColor;' +
  'uniform vec4       u_channelFlag;' +
  'uniform sampler2D  s_texture0;' +
  'void main()' +
  '{' +
  '   float isInside = ' +
  '       step(u_baseColor.x, v_myPos.x/v_myPos.w)' +
  '       * step(u_baseColor.y, v_myPos.y/v_myPos.w)' +
  '       * step(v_myPos.x/v_myPos.w, u_baseColor.z)' +
  '       * step(v_myPos.y/v_myPos.w, u_baseColor.w);' +
  '   gl_FragColor = u_channelFlag * texture2D(s_texture0, v_texCoord).a * isInside;' +
  '}';

//----- バーテックスシェーダプログラム -----
// Normal & Add & Mult 共通
export const vertexShaderSrc = `
  attribute vec4 a_position;
  attribute vec2 a_texCoord;
  attribute vec4 a_normal;
  varying vec2 v_texCoord;
  varying vec3 v_worldNormal;
  varying vec4 v_screenPos;
  varying vec3 v_vertexLightColor;
  varying vec3 v_vertexLightDirection;
  uniform mat4 u_matrix;
  uniform mat4 u_objectToWorld;
  uniform float u_additionalLightCount;
  uniform vec4 u_additionalLightPositions[16];
  uniform vec4 u_additionalLightColors[16];
  uniform vec4 u_additionalLightAttenuations[16];
  uniform vec4 u_additionalLightSpotDirections[16];
  void main() {
    vec4 clipPosition = u_matrix * a_position;
    vec4 worldPosition = u_objectToWorld * a_position;
    gl_Position = clipPosition;
    v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
    // The packaged shader uses the object-to-world 3x3 directly, not an
    // inverse-transpose normal matrix.
    v_worldNormal = normalize(mat3(u_objectToWorld) * a_normal.xyz);
    vec3 accumulatedColor = vec3(0.0);
    vec3 accumulatedDirection = vec3(0.0);
    float totalAttenuation = 0.0;
    for (int index = 0; index < 16; index++) {
      if (float(index) >= u_additionalLightCount) break;
      vec4 lightPosition = u_additionalLightPositions[index];
      vec4 lightAttenuation = u_additionalLightAttenuations[index];
      vec3 lightVector = -worldPosition.xyz * lightPosition.w + lightPosition.xyz;
      float distanceSquared = max(dot(lightVector, lightVector), 6.10351562e-05);
      vec3 lightDirection = lightVector * inversesqrt(distanceSquared);
      float rangeFactor = distanceSquared * lightAttenuation.x;
      float smoothFactor = max(1.0 - rangeFactor * rangeFactor, 0.0);
      float distanceAttenuation = smoothFactor * smoothFactor / distanceSquared;
      float spotAttenuation = clamp(
        dot(u_additionalLightSpotDirections[index].xyz, lightDirection) * lightAttenuation.z +
          lightAttenuation.w,
        0.0,
        1.0
      );
      float attenuation = distanceAttenuation * spotAttenuation * spotAttenuation;
      accumulatedDirection += lightDirection * attenuation;
      accumulatedColor += u_additionalLightColors[index].xyz * attenuation;
      totalAttenuation += attenuation;
    }
    v_vertexLightColor = accumulatedColor;
    v_vertexLightDirection = totalAttenuation > 0.0
      ? normalize(accumulatedDirection / totalAttenuation)
      : vec3(0.0, 0.0, 1.0);
    // GLES ProjectionParams.x is +1 for this render path.
    v_screenPos = vec4(
      clipPosition.x * 0.5 + clipPosition.w * 0.5,
      clipPosition.y * 0.5 + clipPosition.w * 0.5,
      clipPosition.z,
      clipPosition.w
    );
  }
`;

// Normal & Add & Mult 共通（クリッピングされたものの描画用）
export const vertexShaderSrcMasked = `
  attribute vec4 a_position;
  attribute vec2 a_texCoord;
  attribute vec4 a_normal;
  varying vec2 v_texCoord;
  varying vec3 v_worldNormal;
  varying vec4 v_screenPos;
  varying vec3 v_vertexLightColor;
  varying vec3 v_vertexLightDirection;
  varying vec4 v_clipPos;
  uniform mat4 u_matrix;
  uniform mat4 u_objectToWorld;
  uniform mat4 u_clipMatrix;
  uniform float u_additionalLightCount;
  uniform vec4 u_additionalLightPositions[16];
  uniform vec4 u_additionalLightColors[16];
  uniform vec4 u_additionalLightAttenuations[16];
  uniform vec4 u_additionalLightSpotDirections[16];
  void main() {
    vec4 clipPosition = u_matrix * a_position;
    vec4 worldPosition = u_objectToWorld * a_position;
    gl_Position = clipPosition;
    v_clipPos = u_clipMatrix * a_position;
    v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
    v_worldNormal = normalize(mat3(u_objectToWorld) * a_normal.xyz);
    vec3 accumulatedColor = vec3(0.0);
    vec3 accumulatedDirection = vec3(0.0);
    float totalAttenuation = 0.0;
    for (int index = 0; index < 16; index++) {
      if (float(index) >= u_additionalLightCount) break;
      vec4 lightPosition = u_additionalLightPositions[index];
      vec4 lightAttenuation = u_additionalLightAttenuations[index];
      vec3 lightVector = -worldPosition.xyz * lightPosition.w + lightPosition.xyz;
      float distanceSquared = max(dot(lightVector, lightVector), 6.10351562e-05);
      vec3 lightDirection = lightVector * inversesqrt(distanceSquared);
      float rangeFactor = distanceSquared * lightAttenuation.x;
      float smoothFactor = max(1.0 - rangeFactor * rangeFactor, 0.0);
      float distanceAttenuation = smoothFactor * smoothFactor / distanceSquared;
      float spotAttenuation = clamp(
        dot(u_additionalLightSpotDirections[index].xyz, lightDirection) * lightAttenuation.z +
          lightAttenuation.w,
        0.0,
        1.0
      );
      float attenuation = distanceAttenuation * spotAttenuation * spotAttenuation;
      accumulatedDirection += lightDirection * attenuation;
      accumulatedColor += u_additionalLightColors[index].xyz * attenuation;
      totalAttenuation += attenuation;
    }
    v_vertexLightColor = accumulatedColor;
    v_vertexLightDirection = totalAttenuation > 0.0
      ? normalize(accumulatedDirection / totalAttenuation)
      : vec3(0.0, 0.0, 1.0);
    v_screenPos = vec4(
      clipPosition.x * 0.5 + clipPosition.w * 0.5,
      clipPosition.y * 0.5 + clipPosition.w * 0.5,
      clipPosition.z,
      clipPosition.w
    );
  }
`;

const fragmentShaderSrcAdvCommon = `
  precision highp float;
  varying vec2 v_texCoord;
  varying vec3 v_worldNormal;
  varying vec4 v_screenPos;
  varying vec3 v_vertexLightColor;
  varying vec3 v_vertexLightDirection;
  uniform vec4 u_baseColor;
  uniform sampler2D s_texture0;
  uniform sampler2D s_multiplyTexture;
  uniform vec4 u_multiplyColor;
  uniform float u_lightingEnabled;
  uniform vec4 u_mainLightPosition;
  uniform vec3 u_mainLightColor;
  uniform vec4 u_unitySHAr;
  uniform vec4 u_unitySHAg;
  uniform vec4 u_unitySHAb;
  uniform vec4 u_unitySHBr;
  uniform vec4 u_unitySHBg;
  uniform vec4 u_unitySHBb;
  uniform vec4 u_unitySHC;
  uniform float u_useMultiplyTexture;
  uniform vec4 u_multiplyUv;
  uniform float u_multiplyTextureIntensity;
  uniform vec2 u_multiplyTextureAmplitude;
  uniform float u_multiplyTextureFrequency;
  uniform float u_timeSeconds;

  vec3 unityLinearToSrgb(vec3 linearColor) {
    vec3 highColor = pow(abs(linearColor), vec3(0.416666657));
    highColor = highColor * 1.05499995 - 0.0549999997;
    vec3 lowColor = linearColor * 12.9232101;
    bvec3 useLow = lessThanEqual(linearColor, vec3(0.00313080009));
    return vec3(
      useLow.x ? lowColor.x : highColor.x,
      useLow.y ? lowColor.y : highColor.y,
      useLow.z ? lowColor.z : highColor.z
    );
  }

  vec3 unityShadeSH9(vec3 normal) {
    float difference = normal.x * normal.x - normal.y * normal.y;
    vec4 quadratic = normal.yzzx * normal.xyzz;
    vec3 result = vec3(
      dot(u_unitySHBr, quadratic),
      dot(u_unitySHBg, quadratic),
      dot(u_unitySHBb, quadratic)
    );
    result += u_unitySHC.xyz * difference;
    vec4 normal4 = vec4(normal, 1.0);
    result += vec3(
      dot(u_unitySHAr, normal4),
      dot(u_unitySHAg, normal4),
      dot(u_unitySHAb, normal4)
    );
    return result;
  }

  vec4 unityCubismAdvColor() {
    vec3 normal = normalize(v_worldNormal);
    vec3 ambient = unityLinearToSrgb(unityShadeSH9(normal));
    vec3 mainDirection = normalize(u_mainLightPosition.xyz);
    float mainNdotL = max(dot(normal, -mainDirection), 0.0);
    vec3 vertexLightDirection = normalize(v_vertexLightDirection);
    float vertexNdotL = max(dot(normal, vertexLightDirection), 0.0);
    vec3 enabledLight = ambient * (
      u_mainLightColor * mainNdotL + v_vertexLightColor * vertexNdotL
    );
    vec3 lightFactor = (enabledLight - 1.0) * u_lightingEnabled + 1.0;

    vec4 textureColor = texture2D(s_texture0, v_texCoord);
    vec3 rgb = lightFactor * textureColor.rgb * u_multiplyColor.rgb * u_baseColor.rgb;
    float alpha = textureColor.a * u_baseColor.a;

    float wave = sin(u_timeSeconds * u_multiplyTextureFrequency * 6.28318548);
    vec2 screenUv = v_screenPos.xy / v_screenPos.w;
    vec2 multiplyUv = screenUv * u_multiplyUv.xy + u_multiplyUv.zw;
    multiplyUv += u_multiplyTextureAmplitude * wave;
    vec3 multiplySample = texture2D(s_multiplyTexture, multiplyUv).rgb;
    rgb += u_useMultiplyTexture * ((rgb * multiplySample - rgb) * u_multiplyTextureIntensity);

    // The compiled shader premultiplies after lighting and multiply texture.
    return vec4(rgb * alpha, alpha);
  }
`;

//----- フラグメントシェーダプログラム -----
// Normal & Add & Mult 共通 （PremultipliedAlpha）
export const fragmentShaderSrcPremultipliedAlpha = `${fragmentShaderSrcAdvCommon}
  void main() {
    gl_FragColor = unityCubismAdvColor();
  }
`;

// Normal （クリッピングされたものの描画用、PremultipliedAlpha兼用）
export const fragmentShaderSrcMaskPremultipliedAlpha = `${fragmentShaderSrcAdvCommon}
  varying vec4 v_clipPos;
  uniform vec4 u_channelFlag;
  uniform sampler2D s_texture1;
  void main() {
    vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;
    float maskValue = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
    gl_FragColor = unityCubismAdvColor() * maskValue;
  }
`;

// Normal & Add & Mult 共通（クリッピングされて反転使用の描画用、PremultipliedAlphaの場合）
export const fragmentShaderSrcMaskInvertedPremultipliedAlpha = `${fragmentShaderSrcAdvCommon}
  varying vec4 v_clipPos;
  uniform vec4 u_channelFlag;
  uniform sampler2D s_texture1;
  void main() {
    vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;
    float maskValue = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
    gl_FragColor = unityCubismAdvColor() * (1.0 - maskValue);
  }
`;

// Namespace definition for compatibility.
import * as $ from './cubismshader_webgl';
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Live2DCubismFramework {
  export const CubismShaderSet = $.CubismShaderSet;
  export type CubismShaderSet = $.CubismShaderSet;
  export const CubismShader_WebGL = $.CubismShader_WebGL;
  export type CubismShader_WebGL = $.CubismShader_WebGL;
  export const CubismShaderManager_WebGL = $.CubismShaderManager_WebGL;
  export type CubismShaderManager_WebGL = $.CubismShaderManager_WebGL;
  export const acquireCubismShaderContext = $.acquireCubismShaderContext;
  export const releaseCubismShaderContext = $.releaseCubismShaderContext;
  export const ShaderNames = $.ShaderNames;
  export type ShaderNames = $.ShaderNames;
}
