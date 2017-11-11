'use strict'

import ViewState from './ViewState'
import BrowserDcBufferFactory from '../BrowserDcBufferFactory'
import YUVSurfaceShader from './YUVSurfaceShader'
import Size from '../Size'

export default class Renderer {
  /**
   *
   * @param {BrowserSession} browserSession
   * @returns {Renderer}
   */
  static create (browserSession) {
    // create offscreen gl context
    const canvas = document.createElement('canvas')
    let gl = canvas.getContext('webgl')
    if (!gl) {
      throw new Error('This browser doesn\'t support WebGL!')
    }

    gl.clearColor(0, 0, 0, 0)
    const yuvShader = YUVSurfaceShader.create(gl)
    yuvShader.use()
    return new Renderer(browserSession, gl, yuvShader, canvas)
  }

  /**
   *
   * @param browserSession
   * @param gl
   * @param yuvShader
   * @param canvas
   */
  constructor (browserSession, gl, yuvShader, canvas) {
    this.browserSession = browserSession
    this.gl = gl
    this.yuvShader = yuvShader
    this.canvas = canvas

    this._timeOffset = new Date().getTime()
  }

  /**
   * @param {BrowserSurface}browserSurface
   * @return Size
   */
  surfaceSize (browserSurface) {
    const grBuffer = browserSurface.grBuffer
    const bufferSize = this.bufferSize(grBuffer)
    const surfaceWidth = bufferSize.w / browserSurface.bufferScale
    const surfaceHeight = bufferSize.h / browserSurface.bufferScale
    return Size.create(surfaceWidth, surfaceHeight)
  }

  /**
   * @param {GrBuffer}grBuffer
   * @return Size
   */
  bufferSize (grBuffer) {
    if (grBuffer === null) {
      return Size.create(0, 0)
    }
    // TODO we could check for null here in case we are dealing with a different kind of buffer
    const browserRtcDcBuffer = BrowserDcBufferFactory.get(grBuffer)
    return browserRtcDcBuffer.geo
  }

  /**
   *
   * @param {BrowserSurface} browserSurface
   */
  render (browserSurface) {
    window.requestAnimationFrame(() => {
      this._render(browserSurface)
      this.browserSession.flush()
    })
  }

  /**
   * @param {BrowserSurface} browserSurface
   * @private
   */
  _render (browserSurface) {
    const grBuffer = browserSurface.grBuffer
    if (grBuffer === null) {
      browserSurface.renderState = null
      return
    }

    const gl = this.gl
    // TODO we could check for null here in case we are dealing with a different kind of buffer
    const browserRtcDcBuffer = BrowserDcBufferFactory.get(grBuffer)

    const drawSyncSerial = browserRtcDcBuffer.syncSerial
    if (browserRtcDcBuffer.isComplete(drawSyncSerial)) {
      const bufferSize = this.bufferSize(grBuffer)

      // canvas units are in pixels, so we can simply use the buffer size
      browserSurface.browserSurfaceViews.forEach((view) => {
        view.canvas.width = bufferSize.w
        view.canvas.height = bufferSize.h
      })

      if (!browserSurface.renderState) {
        browserSurface.renderState = ViewState.create(gl)
        // FIXME don't create views here, instead let role manage views
        if (browserSurface.browserSurfaceViews.length === 0) {
          browserSurface.createView(bufferSize).unfade()
        }
      }

      // update textures
      browserSurface.renderState.update(browserRtcDcBuffer.yuvContent, browserRtcDcBuffer.yuvWidth, browserRtcDcBuffer.yuvHeight)
      this._nextFrame(browserSurface)
    } else {
      // buffer contents have not yet arrived, reschedule a scene repaint as soon as the buffer arrives.
      // The old state will be used to draw the view
      browserRtcDcBuffer.whenComplete(drawSyncSerial).then(() => {
        this.render(browserSurface)
      }).catch((error) => {
        console.log(error)
      })
    }

    // paint the textures
    if (browserSurface.renderState) {
      this._paint(browserSurface.renderState, browserRtcDcBuffer.geo)

      // blit rendered texture into view canvas
      browserSurface.browserSurfaceViews.forEach((view) => {
        view.context2d.drawImage(this.canvas, 0, 0)
      })
    }
  }

  _paint (renderState, bufferSize) {
    this.canvas.width = bufferSize.w
    this.canvas.height = bufferSize.h
    this.yuvShader.draw(renderState.YTexture, renderState.UTexture, renderState.VTexture, bufferSize)
  }

  _nextFrame (browserSurface) {
    if (browserSurface.frameCallback) {
      const time = new Date().getTime() - this._timeOffset
      browserSurface.frameCallback.done(time)
      browserSurface.frameCallback = null
    }
  }
}