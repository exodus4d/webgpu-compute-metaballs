import { BACKGROUND_COLOR, DEPTH_FORMAT } from './constants'

export class WebGPURenderer {
  adapter: GPUAdapter

  #outputSize: [number, number] = [512, 512]
  devicePixelRatio = 1
  canvas = document.createElement('canvas')
  context = this.canvas.getContext('webgpu')!

  bindGroupsLayouts: { [key: string]: GPUBindGroupLayout } = {}
  bindGroups: { [key: string]: GPUBindGroup } = {}
  ubos: { [key: string]: GPUBuffer } = {}
  textures: { [key: string]: GPUTexture } = {}

  device!: GPUDevice
  colorAttachment!: GPURenderPassColorAttachment
  depthAndStencilAttachment!: GPURenderPassDepthStencilAttachment

  defaultSampler: GPUSampler

  get presentationFormat(): GPUTextureFormat {
    return navigator.gpu?.getPreferredCanvasFormat
      ? navigator.gpu?.getPreferredCanvasFormat()
      : 'bgra8unorm'
  }

  set outputSize(size: [number, number]) {
    const [w, h] = size
    this.#outputSize = size
    this.canvas.width = w
    this.canvas.height = h
    const delta = innerWidth / w
    this.canvas.style.setProperty('width', `${w * delta}px`)
    this.canvas.style.setProperty('height', `${h * delta}px`)
  }

  get outputSize(): [number, number] {
    return this.#outputSize
  }

  constructor(adapter: GPUAdapter) {
    this.adapter = adapter
  }

  async init() {
    this.device = await this.adapter.requestDevice()

    // HACK: WebGPU does not expose maxAnisotropy (yet?)
    // Let's use a separate WebGL2 context to obtain the max anisotropy supported by the GPU
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext =
      gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('MOZ_EXT_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
    const maxAnisotropy = ext
      ? gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
      : 1
    this.defaultSampler = this.device.createSampler({
      minFilter: 'linear',
      mipmapFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy,
    })

    const projectionUBOByteLength =
      16 * Float32Array.BYTES_PER_ELEMENT + // matrix
      16 * Float32Array.BYTES_PER_ELEMENT + // inverse matrix
      8 * Float32Array.BYTES_PER_ELEMENT + // screen size
      1 * Float32Array.BYTES_PER_ELEMENT + // near
      1 * Float32Array.BYTES_PER_ELEMENT // far

    this.ubos.projectionUBO = this.device.createBuffer({
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      size: projectionUBOByteLength,
    })

    const viewUBOByteLength =
      16 * Float32Array.BYTES_PER_ELEMENT + // matrix
      16 * Float32Array.BYTES_PER_ELEMENT + // inverse matrix
      3 * Float32Array.BYTES_PER_ELEMENT + // camera position
      1 * Float32Array.BYTES_PER_ELEMENT + // time
      1 * Float32Array.BYTES_PER_ELEMENT + // delta time
      3 * Float32Array.BYTES_PER_ELEMENT // padding required for struct alignment: size % 8 == 0

    this.ubos.viewUBO = this.device.createBuffer({
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      size: viewUBOByteLength,
    })

    const screenProjectionUBOByteLength = 16 * Float32Array.BYTES_PER_ELEMENT // matrix

    this.ubos.screenProjectionUBO = this.device.createBuffer({
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      size: screenProjectionUBOByteLength,
    })

    const screenViewUBOByteLength = 16 * Float32Array.BYTES_PER_ELEMENT // matrix
    this.ubos.screenViewUBO = this.device.createBuffer({
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      size: screenViewUBOByteLength,
    })

    const presentationFormat = this.presentationFormat
    this.context.configure({
      device: this.device,
      format: presentationFormat,
    })

    this.colorAttachment = {
      view: null,
      resolveTarget: undefined,
      clearValue: {
        r: BACKGROUND_COLOR[0],
        g: BACKGROUND_COLOR[1],
        b: BACKGROUND_COLOR[2],
        a: BACKGROUND_COLOR[3],
      },
      loadOp: 'clear',
      storeOp: 'store',
    }

    this.textures.depthTexture = this.device.createTexture({
      size: {
        width: this.outputSize[0],
        height: this.outputSize[1],
      },
      format: DEPTH_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })

    this.depthAndStencilAttachment = {
      view: this.textures.depthTexture.createView(),
      depthLoadOp: 'clear',
      depthStoreOp: 'discard',
    }

    this.bindGroupsLayouts.frame = this.device.createBindGroupLayout({
      label: 'frame bind group layout',
      entries: [
        {
          binding: 0,
          visibility:
            GPUShaderStage.VERTEX |
            GPUShaderStage.FRAGMENT |
            GPUShaderStage.COMPUTE,
          buffer: {},
        },
        {
          binding: 1,
          visibility:
            GPUShaderStage.VERTEX |
            GPUShaderStage.FRAGMENT |
            GPUShaderStage.COMPUTE,
          buffer: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: {
            type: 'filtering',
          },
        },
      ],
    })
    this.bindGroups.frame = this.device.createBindGroup({
      label: 'frame bind group',
      layout: this.bindGroupsLayouts.frame,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.ubos.projectionUBO },
        },
        {
          binding: 1,
          resource: { buffer: this.ubos.viewUBO },
        },
        {
          binding: 2,
          resource: this.device.createSampler({}),
        },
      ],
    })
  }

  onRender() {
    this.colorAttachment.view = this.context.getCurrentTexture().createView()
  }
}
