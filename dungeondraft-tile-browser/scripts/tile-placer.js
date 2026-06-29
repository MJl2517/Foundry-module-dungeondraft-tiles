import { MODULE_ID } from "./library-store.js";

const RIGHT_CLICK_CANCEL_MS = 260;
const RIGHT_CLICK_CANCEL_DISTANCE = 6;
const DEFAULT_MAP_DPI = 256;

export class TilePlacer {
  static active = null;

  static async start(asset, { src, color = null, snapToGrid = true, lockPlacedTiles = false, mapDpi = DEFAULT_MAP_DPI } = {}) {
    this.cancel();
    this.active = new TilePlacementSession(asset, { src: src || asset.src, color, snapToGrid, lockPlacedTiles, mapDpi });
    await this.active.start();
  }

  static cancel() {
    this.active?.destroy();
    this.active = null;
  }

  static updateOptions(options = {}) {
    this.active?.updateOptions(options);
  }
}

class TilePlacementSession {
  constructor(asset, { src, color, snapToGrid, lockPlacedTiles, mapDpi }) {
    this.asset = asset;
    this.src = src;
    this.color = color;
    this.snapToGrid = Boolean(snapToGrid);
    this.lockPlacedTiles = Boolean(lockPlacedTiles);
    this.mapDpi = normalizeMapDpi(mapDpi);
    this.rotation = 0;
    this.scale = 1;
    this.position = { x: 0, y: 0 };
    this.textureSize = null;
    this.view = canvas.app?.view ?? null;
    this.preview = null;
    this.rightClickCandidate = null;
    this.ctrlDown = false;
    this.rightCtrlDown = false;

    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);
  }

  async start() {
    if (!canvas.ready || !canvas.scene) throw new Error("No active canvas scene is ready.");
    canvas.tiles?.activate?.();

    this.preview = await this.createPreview();
    canvas.stage.addChild(this.preview);
    this.addListeners();
  }

  async createPreview() {
    const texture = typeof loadTexture === "function"
      ? await loadTexture(this.src)
      : PIXI.Texture.from(this.src);
    this.textureSize = getTextureSize(texture);
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5, 0.5);
    sprite.alpha = 0.55;
    sprite.eventMode = "none";
    this.applyRememberedSize(texture);
    const size = this.getBaseSize(texture);
    sprite.width = size.width * this.scale;
    sprite.height = size.height * this.scale;
    return sprite;
  }

  addListeners() {
    this.view.addEventListener("pointermove", this.onPointerMove);
    this.view.addEventListener("pointerdown", this.onPointerDown);
    this.view.addEventListener("pointerup", this.onPointerUp);
    this.view.addEventListener("wheel", this.onWheel, { passive: false, capture: true });
    this.view.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  removeListeners() {
    this.view?.removeEventListener("pointermove", this.onPointerMove);
    this.view?.removeEventListener("pointerdown", this.onPointerDown);
    this.view?.removeEventListener("pointerup", this.onPointerUp);
    this.view?.removeEventListener("wheel", this.onWheel, { capture: true });
    this.view?.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  onPointerMove(event) {
    this.updateRightClickCandidate(event);
    this.position = eventToCanvasPoint(event);
    this.updatePreview();
  }

  async onPointerDown(event) {
    if (event.button === 2) {
      this.rightClickCandidate = {
        x: event.clientX,
        y: event.clientY,
        startedAt: performance.now(),
        moved: false
      };
      return;
    }
    if (event.button !== 0) return;

    event.preventDefault();
    await this.placeTile();
    this.rememberMultiPlacementModifier(event);
    if (!this.isMultiPlacementActive()) TilePlacer.cancel();
  }

  onPointerUp(event) {
    if (event.button !== 2 || !this.rightClickCandidate) return;

    const candidate = this.rightClickCandidate;
    this.updateRightClickCandidate(event);
    this.rightClickCandidate = null;

    const elapsed = performance.now() - candidate.startedAt;
    if (!candidate.moved && elapsed <= RIGHT_CLICK_CANCEL_MS) {
      event.preventDefault();
      event.stopPropagation();
      TilePlacer.cancel();
    }
  }

  onWheel(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const direction = Math.sign(event.deltaY) || 1;

    if (event.shiftKey) {
      const scaleStep = Number(game.settings.get(MODULE_ID, "scaleStep")) || 0.1;
      this.scale = Math.max(scaleStep, this.scale - direction * scaleStep);
    } else {
      const rotationStep = Number(game.settings.get(MODULE_ID, "rotationStep")) || 15;
      this.rotation = normalizeRotation(this.rotation + direction * rotationStep);
    }

    this.updatePreview();
  }

  onKeyDown(event) {
    if (event.key === "Control") this.ctrlDown = true;
    if (event.code === "ControlRight") this.rightCtrlDown = true;
    if (event.key === "Escape") {
      event.preventDefault();
      TilePlacer.cancel();
    }
  }

  onKeyUp(event) {
    if (event.code === "ControlRight") this.rightCtrlDown = false;
    if (event.key === "Control") this.ctrlDown = event.ctrlKey;
  }

  onContextMenu(event) {
    event.preventDefault();
  }

  updateRightClickCandidate(event) {
    if (!this.rightClickCandidate) return;
    const dx = event.clientX - this.rightClickCandidate.x;
    const dy = event.clientY - this.rightClickCandidate.y;
    const distance = Math.hypot(dx, dy);
    if (distance > RIGHT_CLICK_CANCEL_DISTANCE) this.rightClickCandidate.moved = true;
  }

  rememberMultiPlacementModifier(event) {
    if (event.ctrlKey) this.ctrlDown = true;
  }

  isMultiPlacementActive() {
    return this.rightCtrlDown || this.ctrlDown;
  }

  updateOptions({ snapToGrid, lockPlacedTiles, mapDpi } = {}) {
    const currentRect = this.getPlacementRect();

    if (typeof snapToGrid === "boolean") this.snapToGrid = snapToGrid;
    if (typeof lockPlacedTiles === "boolean") this.lockPlacedTiles = lockPlacedTiles;
    if (mapDpi !== undefined) {
      this.mapDpi = normalizeMapDpi(mapDpi);
      const base = this.getBaseSize();
      const scale = currentRect.width / base.width;
      if (Number.isFinite(scale) && scale > 0) this.scale = scale;
    }

    this.updatePreview();
  }

  updatePreview() {
    if (!this.preview) return;
    const placement = this.getPlacementRect();
    this.preview.position.set(placement.x + placement.width / 2, placement.y + placement.height / 2);
    this.preview.width = placement.width;
    this.preview.height = placement.height;
    this.preview.rotation = (this.rotation * Math.PI) / 180;
  }

  getBaseSize(texture = null) {
    const gridSize = getGridSize();
    if (Number(this.asset.gridWidth) > 0 && Number(this.asset.gridHeight) > 0) {
      return {
        width: Math.max(1, Number(this.asset.gridWidth) * gridSize),
        height: Math.max(1, Number(this.asset.gridHeight) * gridSize)
      };
    }

    const textureSize = texture ? getTextureSize(texture) : this.textureSize;
    const dpiScale = gridSize / this.mapDpi;
    return {
      width: Math.max(1, (this.asset.width || textureSize?.width || 100) * dpiScale),
      height: Math.max(1, (this.asset.height || textureSize?.height || 100) * dpiScale)
    };
  }

  applyRememberedSize(texture = null) {
    const remembered = getRememberedPlacementSize(this.asset.id);
    if (!remembered) return;

    const base = this.getBaseSize(texture);
    if (!hasCompatibleAspectRatio(remembered, base)) return;
    const scale = remembered.width / base.width;
    if (Number.isFinite(scale) && scale > 0) this.scale = scale;
  }

  getPlacementRect() {
    const base = this.getBaseSize();
    const width = Math.max(1, base.width * this.scale);
    const height = Math.max(1, base.height * this.scale);
    let x = this.position.x - width / 2;
    let y = this.position.y - height / 2;

    if (this.snapToGrid) {
      x = snapCoordinate(x);
      y = snapCoordinate(y);
    }

    return {
      x,
      y,
      width,
      height
    };
  }

  async placeTile() {
    const placement = this.getPlacementRect();
    const width = Math.round(placement.width);
    const height = Math.round(placement.height);
    const x = Math.round(placement.x);
    const y = Math.round(placement.y);

    const data = {
      x,
      y,
      width,
      height,
      rotation: this.rotation,
      locked: this.lockPlacedTiles,
      alpha: 1,
      texture: { src: this.src },
      flags: {
        [MODULE_ID]: {
          assetId: this.asset.id,
          packId: this.asset.packId,
          color: this.color,
          mapDpi: this.mapDpi,
          snapToGrid: this.snapToGrid,
          lockPlacedTiles: this.lockPlacedTiles,
          originalSrc: this.asset.src
        }
      }
    };

    await canvas.scene.createEmbeddedDocuments("Tile", [data]);
    try {
      await rememberPlacementSize(this.asset.id, { width, height });
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not remember tile size`, error);
    }
  }

  destroy() {
    this.removeListeners();
    this.preview?.destroy({ children: true });
    this.preview = null;
  }
}

function eventToCanvasPoint(event) {
  if (typeof canvas.canvasCoordinatesFromClient === "function") {
    return canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  }

  const rect = canvas.app.view.getBoundingClientRect();
  const screenPoint = new PIXI.Point(event.clientX - rect.left, event.clientY - rect.top);
  return canvas.stage.worldTransform.applyInverse(screenPoint);
}

function normalizeRotation(rotation) {
  return ((rotation % 360) + 360) % 360;
}

function normalizeMapDpi(value) {
  const dpi = Math.round(Number(value));
  return Number.isFinite(dpi) && dpi > 0 ? Math.min(dpi, 4096) : DEFAULT_MAP_DPI;
}

function getGridSize() {
  return Number(canvas.grid?.size || canvas.scene?.grid?.size || 100) || 100;
}

function getTextureSize(texture) {
  const width = Number(texture?.orig?.width || texture?.frame?.width || texture?.baseTexture?.realWidth || texture?.baseTexture?.width || texture?.width);
  const height = Number(texture?.orig?.height || texture?.frame?.height || texture?.baseTexture?.realHeight || texture?.baseTexture?.height || texture?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function hasCompatibleAspectRatio(size, base) {
  const rememberedRatio = Number(size.width) / Number(size.height);
  const baseRatio = Number(base.width) / Number(base.height);
  if (!Number.isFinite(rememberedRatio) || !Number.isFinite(baseRatio) || rememberedRatio <= 0 || baseRatio <= 0) return false;
  return Math.abs(Math.log(rememberedRatio / baseRatio)) <= Math.log(1.15);
}

function snapCoordinate(value) {
  const gridSize = getGridSize();
  return Math.round(value / gridSize) * gridSize;
}

function getRememberedPlacementSize(assetId) {
  const sizes = game.settings.get(MODULE_ID, "assetPlacementSizes") ?? {};
  const size = sizes[assetId];
  if (!size) return null;

  const width = Number(size.width);
  const height = Number(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

async function rememberPlacementSize(assetId, { width, height }) {
  const sizes = { ...(game.settings.get(MODULE_ID, "assetPlacementSizes") ?? {}) };
  sizes[assetId] = {
    width,
    height,
    updatedAt: Date.now()
  };
  await game.settings.set(MODULE_ID, "assetPlacementSizes", trimRememberedPlacementSizes(sizes));
}

function trimRememberedPlacementSizes(sizes) {
  const entries = Object.entries(sizes)
    .filter(([, size]) => Number(size?.width) > 0 && Number(size?.height) > 0)
    .sort(([, a], [, b]) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    .slice(0, 2000);
  return Object.fromEntries(entries);
}
