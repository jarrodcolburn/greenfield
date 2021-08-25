// Copyright 2020 Erik De Rijcke
//
// This file is part of Greenfield.
//
// Greenfield is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Greenfield is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Greenfield.  If not, see <https://www.gnu.org/licenses/>.

import {
  IDENTITY,
  invert,
  Mat4RO,
  scalarVector,
  timesMat4,
  timesPoint,
  timesRectToBoundingBox,
  translation,
} from './math/Mat4'
import { plusPoint, PointRO } from './math/Point'
import { RectROWithInfo, withInfo } from './math/Rect'
import { createVec4_2D } from './math/Vec4'
import { copyTo, createPixmanRegion, destroyPixmanRegion, fini, initRect, intersect, notEmpty } from './Region'
import RenderState from './render/RenderState'
import Scene from './render/Scene'
import Surface from './Surface'

export default class View {
  readonly pixmanRegion: number = createPixmanRegion()
  relevantScene?: Scene
  regionRect: RectROWithInfo = withInfo({
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
  })
  private inverseTransformation: Mat4RO
  private readonly destroyPromise: Promise<void>
  // @ts-ignore
  private destroyResolve: (value?: PromiseLike<void> | void) => void
  prepareRender?: (renderState: RenderState) => void

  private constructor(
    public readonly surface: Surface,
    private _transformation: Mat4RO = IDENTITY,
    public renderStates: { [sceneId: string]: RenderState } = {},
    private _positionOffset: PointRO = { x: 0, y: 0 },
    public destroyed = false,
    public mapped = true,
    private _dirty: boolean = true,
    private _windowGeometryOffset: Mat4RO = IDENTITY,
    public transformationUpdatedListeners: ((transformation: Mat4RO) => void)[] = [],
  ) {
    this.inverseTransformation = invert(this._transformation)
    this.destroyPromise = new Promise<void>((resolve) => {
      this.destroyResolve = resolve
    })
  }

  private _customTransformation?: Mat4RO

  get customTransformation(): Mat4RO | undefined {
    return this._customTransformation
  }

  set customTransformation(customTransformation: Mat4RO | undefined) {
    if (this._customTransformation === customTransformation) {
      return
    }

    this._customTransformation = customTransformation
    this.markDirty()
  }

  get parent(): View | undefined {
    return this.surface.parent?.role?.view
  }

  get dirty(): boolean {
    return this.parent?.dirty || this._dirty
  }

  get windowGeometryOffset(): Mat4RO {
    return this._windowGeometryOffset
  }

  set windowGeometryOffset(windowGeometryOffset: Mat4RO) {
    this._windowGeometryOffset = windowGeometryOffset
    this.markDirty()
  }

  get positionOffset(): PointRO {
    return this._positionOffset
  }

  set positionOffset(positionOffset: PointRO) {
    if (this._positionOffset.x === positionOffset.x && this._positionOffset.y === positionOffset.y) {
      return
    }
    this._positionOffset = positionOffset
    this.markDirty()
  }

  get transformation(): Mat4RO {
    return this._transformation
  }

  private set transformation(transformation: Mat4RO) {
    if (this.destroyed) {
      return
    }

    this._transformation = transformation
    this.inverseTransformation = invert(transformation)
  }

  static create(surface: Surface): View {
    return new View(surface)
  }

  markDirty(): void {
    this._dirty = true
  }

  applyTransformations(): void {
    if (this.destroyed) {
      return
    }

    if (this.dirty) {
      this.transformation = this.calculateTransformation()
      this.updateRegion()
      this.applyTransformationsChild()
      this._dirty = false
      this.transformationUpdatedListeners.forEach((listener) => listener(this.transformation))
    }
  }

  toViewSpaceFromCompositor(browserPoint: PointRO): PointRO {
    // normalize first by subtracting view offset
    return timesPoint(this.inverseTransformation, browserPoint)
  }

  toViewSpaceFromSurface(surfacePoint: PointRO): PointRO {
    const { width, height } = this.regionRect.size
    if (this.surface.size) {
      const { height: surfaceHeight, width: surfaceWidth } = this.surface.size
      if (surfaceWidth === width && surfaceHeight === height) {
        return surfacePoint
      } else {
        return timesPoint(scalarVector(createVec4_2D(width / surfaceWidth, height / surfaceHeight)), surfacePoint)
      }
    } else {
      return surfacePoint
    }
  }

  toSurfaceSpace(scenePoint: PointRO): PointRO {
    const viewPoint = this.toViewSpaceFromCompositor(scenePoint)

    const surfaceSize = this.surface.size
    if (surfaceSize) {
      const surfaceWidth = surfaceSize.width
      const surfaceHeight = surfaceSize.height
      if (surfaceWidth === this.regionRect.size.width && surfaceHeight === this.regionRect.size.height) {
        return viewPoint
      } else {
        return timesPoint(
          scalarVector(
            createVec4_2D(surfaceWidth / this.regionRect.size.width, surfaceHeight / this.regionRect.size.height),
          ),
          viewPoint,
        )
      }
    } else {
      return scenePoint
    }
  }

  destroy(): void {
    if (this.renderStates) {
      Object.values(this.renderStates).forEach((renderState) => renderState.destroy())
      this.renderStates = {}
    }

    this.destroyed = true
    this.destroyResolve()
  }

  onDestroy(): Promise<void> {
    return this.destroyPromise
  }

  private findChildViews(): View[] {
    return this.surface.children
      .filter((surfaceChild) => surfaceChild.surface !== this.surface)
      .map((surfaceChild) => surfaceChild.surface.role?.view)
      .filter((view): view is View => view !== undefined)
  }

  private applyTransformationsChild() {
    this.findChildViews().forEach((childView) => childView.applyTransformations())
  }

  private updateRegion() {
    const x0 = 0
    const y0 = 0
    const x1 = this.surface.size?.width ?? 0
    const y1 = this.surface.size?.height ?? 0

    this.regionRect = withInfo(timesRectToBoundingBox(this.transformation, { x0, y0, x1, y1 }))

    fini(this.pixmanRegion)
    initRect(this.pixmanRegion, this.regionRect)

    this.ensureRenderStatesForMatchingScenes()
  }

  private ensureRenderStatesForMatchingScenes() {
    // find visible region for scenes where this view is visible
    const scenesWithVisibleRegion = Object.values(this.surface.session.renderer.scenes)
      .map((scene) => {
        const visibleRegion = createPixmanRegion()
        intersect(visibleRegion, this.pixmanRegion, scene.region)
        return [scene.id, { scene, visibleRegion }] as const
      })
      .filter(([, { visibleRegion }]) => {
        return notEmpty(visibleRegion)
      })

    // update & add new renderstates for scenes where this view is visible
    scenesWithVisibleRegion.forEach(([sceneId, { scene, visibleRegion }]) => {
      const renderState = this.renderStates[sceneId]
      if (renderState === undefined) {
        const bufferSize = this.surface.state.bufferContents
          ? this.surface.state.bufferContents.size
          : { width: 0, height: 0 }
        const { width, height } = bufferSize
        this.renderStates[sceneId] = RenderState.create(scene.sceneShader.gl, { width, height }, scene, visibleRegion)
      } else {
        copyTo(renderState.visibleSceneRegion, visibleRegion)
        fini(visibleRegion)
        destroyPixmanRegion(visibleRegion)
      }
    })

    // cleanup renderstates of scenes where this view is no longer visible on
    const visibleRegionBySceneId = Object.fromEntries(scenesWithVisibleRegion)
    Object.entries(this.renderStates).forEach(([sceneId, renderState]) => {
      const visibleRegion = visibleRegionBySceneId[renderState.scene.id]
      if (visibleRegion === undefined) {
        renderState.destroy()
        delete this.renderStates[sceneId]
      }
    })

    // TODO use scene with most visible coverage as relevant scene
    this.relevantScene = Object.values(this.renderStates)[0]?.scene
  }

  private calculateTransformation(): Mat4RO {
    if (this.customTransformation) {
      return this.customTransformation
    }

    const startingTransformation = this.parent ? this.parent.transformation : IDENTITY

    // position transformation
    const { x, y } = plusPoint(this.surface.surfaceChildSelf.position, this._positionOffset)
    const positionTransformation = translation(x, y)
    const vanillaTransformation = timesMat4(startingTransformation, positionTransformation)
    return this.windowGeometryOffset !== IDENTITY
      ? timesMat4(vanillaTransformation, this.windowGeometryOffset)
      : vanillaTransformation
  }
}
