import { readThemePalette, observeTheme } from "./theme-palette.mjs";
import {
  applyLayoutCommand,
  validateLayoutDocument
} from "./anontokyo-layout-engine.mjs";
import { normalizeAssignmentState } from "./anontokyo-staff-assignment.mjs";
import {
  depthForFootprint,
  footprintPolygon as projectedFootprintPolygon,
  globalTileToLocal,
  tileToWorld as projectTileToWorld,
  worldToTile,
} from "./anontokyo-scene-projection.mjs";
import {
  createModeDefaults,
  modeStorageKey,
  restoreModeDocuments,
} from "./anontokyo-studio-mode-state.mjs";
import {
  finishCanvasGesture,
  moveCanvasGesture,
  startCanvasGesture,
} from "./anontokyo-studio-pointer-gesture.mjs";

const TILE_WIDTH = 76;
const TILE_HEIGHT = 38;
const MAX_HISTORY = 80;


function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


function clone(value) {
  return structuredClone(value);
}


class AnonTokyoStudioElement extends HTMLElement {
  async connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    const source = this.querySelector("[data-studio-data]")?.textContent;
    if (!source) return;
    const payload = JSON.parse(source);
    this.payload = payload;
    this.catalog = {
      map: payload.studio.map,
      scene: payload.studio.scene,
      furniture: payload.studio.furniture,
      storeSizes: payload.studio.storeSizes,
      initialLayout: payload.studio.initialLayout
    };
    this.imageByKey = payload.imageByKey;
    this.staffDataset = payload.staff;
    this.staffStorageKey = "ournotes:anontokyo-staff-assignment:v1";
    this.furnitureById = new Map(
      this.catalog.furniture.map((item) => [item.id, item])
    );
    this.histories = {
      gameFaithful: { history: [], future: [] },
      free: { history: [], future: [] },
    };
    this.activeMode = "gameFaithful";
    this.selectedId = null;
    this.pendingFurnitureId = null;
    this.storageKey = this.dataset.storageKey;
    this.legacyStorageKey = this.dataset.legacyStorageKey || `${this.storageKey}:v1`;
    this.isMobile = matchMedia("(max-width: 760px), (pointer: coarse) and (orientation: portrait)").matches;
    this.modeStates = createModeDefaults(this.payload);
    this.document = clone(this.modeStates[this.activeMode].document);
    this.history = this.histories[this.activeMode].history;
    this.future = this.histories[this.activeMode].future;
    this.bindDom();
    this.restoreAutosave();
    this.bindControls();
    this.setupAudio();
    try {
      await this.initPixi();
      this.render();
      if (this.saveStatus.textContent === "准备编辑器…") {
        this.saveStatus.textContent = "空白布局 · 等待修改";
      }
      this.setFeedback("拖动空白区域可平移；从左侧拖入家具，或点选家具后再点画布。", "ready");
    } catch (error) {
      this.setFeedback(`画布启动失败：${error instanceof Error ? error.message : "WebGL 不可用"}`, "error");
      this.canvasHost.classList.add("is-unavailable");
    }
  }

  bindDom() {
    this.canvasHost = this.querySelector("[data-canvas]");
    this.feedback = this.querySelector("[data-feedback]");
    this.saveStatus = this.querySelector("[data-save-status]");
    this.storeSelect = this.querySelector("[data-store-size]");
    this.summary = this.querySelector("[data-layout-summary]");
    this.inspector = this.querySelector("[data-inspector]");
    this.inspectorEmpty = this.querySelector("[data-inspector-empty]");
    this.searchInput = this.querySelector("[data-furniture-search]");
    this.categorySelect = this.querySelector("[data-furniture-category]");
    this.importInput = this.querySelector("[data-import-file]");
    this.deliverySelect = this.querySelector("[data-delivery-select]");
    this.deliveryVisible = this.querySelector("[data-delivery-visible]");
    this.warehouseVisible = this.querySelector("[data-warehouse-visible]");
    this.modeDescription = this.querySelector("[data-mode-description]");
  }

  bindControls() {
    this.addEventListener("click", (event) => {
      const furnitureButton = event.target.closest("[data-furniture-id]");
      if (furnitureButton) {
        if (this.isMobile) {
          this.setFeedback("手机端为查看模式，请使用横屏平板或桌面设备编辑。", "error");
          return;
        }
        this.selectCatalogFurniture(furnitureButton.dataset.furnitureId);
        return;
      }
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action) this.handleAction(action);
      const mode = event.target.closest("[data-studio-mode]")?.dataset.studioMode;
      if (mode) this.switchMode(mode);
    });
    this.querySelectorAll("[data-furniture-id]").forEach((button) => {
      button.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("application/x-anontokyo-furniture", button.dataset.furnitureId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      });
    });
    this.searchInput?.addEventListener("input", () => this.filterFurniture());
    this.categorySelect?.addEventListener("change", () => this.filterFurniture());
    this.storeSelect?.addEventListener("change", () => this.resizeStore());
    this.importInput?.addEventListener("change", () => this.importJson());
    this.deliverySelect?.addEventListener("change", () => {
      this.modeStates[this.activeMode].delivery.optionId = this.deliverySelect.value;
      this.save();
      this.render();
    });
    this.deliveryVisible?.addEventListener("change", () => {
      this.modeStates[this.activeMode].delivery.visible = this.deliveryVisible.checked;
      this.save();
      this.render();
    });
    this.warehouseVisible?.addEventListener("change", () => {
      this.modeStates.free.warehouse.visible = this.warehouseVisible.checked;
      this.save();
      this.render();
    });
    this.addEventListener("keydown", (event) => this.handleShortcut(event));
  }

  async initPixi() {
    const PIXI = await import("pixi.js");
    this.PIXI = PIXI;
    this.palette = readThemePalette(this);
    this.app = new PIXI.Application({
      resizeTo: this.canvasHost,
      backgroundColor: this.palette.inverseSurface,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(devicePixelRatio || 1, 2),
      preserveDrawingBuffer: true
    });
    this.canvasHost.append(this.app.view);
    this.world = new PIXI.Container();
    this.world.sortableChildren = true;
    this.gridLayer = new PIXI.Container();
    this.furnitureLayer = new PIXI.Container();
    this.ghostLayer = new PIXI.Container();
    this.world.addChild(this.gridLayer, this.furnitureLayer, this.ghostLayer);
    this.app.stage.addChild(this.world);
    this.resetView();
    this.disconnectTheme = observeTheme(this, () => {
      this.palette = readThemePalette(this);
      this.app.renderer.background.color = this.palette.inverseSurface;
      this.clearGhost();
      this.render();
    });

    const canvas = this.app.view;
    canvas.addEventListener("dragover", (event) => event.preventDefault());
    canvas.addEventListener("drop", (event) => {
      event.preventDefault();
      if (this.isMobile) return;
      const id = event.dataTransfer?.getData("application/x-anontokyo-furniture");
      if (id) this.placeAtPointer(id, event);
    });
    canvas.addEventListener("pointerup", (event) => this.finishPointer(event));
    canvas.addEventListener("pointerdown", (event) => {
      const gesture = startCanvasGesture(event, { x: this.world.x, y: this.world.y });
      if (!gesture || (this.draggingId && gesture.phase === "pending")) return;
      if (gesture.phase === "panning") event.preventDefault();
      this.pointerGesture = gesture;
      this.canvasHost.toggleAttribute("data-panning", gesture.phase === "panning");
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (this.draggingId && this.pointerGesture?.phase === "pending") {
        this.cancelPointerGesture(event.pointerId);
      }
      if (this.pointerGesture) {
        const moved = moveCanvasGesture(this.pointerGesture, event);
        this.pointerGesture = moved.gesture;
        if (moved.panTo) {
          event.preventDefault();
          this.canvasHost.setAttribute("data-panning", "");
          this.world.position.set(moved.panTo.x, moved.panTo.y);
          return;
        }
      }
      if (this.pendingFurnitureId || this.draggingId) this.renderGhost(event);
    });
    canvas.addEventListener("pointercancel", (event) => this.cancelCanvasInput(event));
    canvas.addEventListener("pointerleave", (event) => this.cancelCanvasInput(event));
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoom(event.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });
  }

  setupAudio() {
    const select = this.querySelector("[data-audio-select]");
    const player = this.querySelector("[data-audio]");
    if (!select || !player) return;
    const preferenceKey = `${this.storageKey}:audio`;
    try {
      const preference = JSON.parse(localStorage.getItem(preferenceKey) || "null");
      if (preference?.src && [...select.options].some((option) => option.value === preference.src)) {
        select.value = preference.src;
      }
      if (typeof preference?.volume === "number") player.volume = preference.volume;
    } catch { /* optional preference */ }
    player.src = select.value;
    const save = () => {
      try {
        localStorage.setItem(preferenceKey, JSON.stringify({ src: select.value, volume: player.volume }));
      } catch { /* audio remains usable without persistence */ }
    };
    select.addEventListener("change", () => {
      const wasPlaying = !player.paused;
      player.src = select.value;
      if (wasPlaying) player.play().catch(() => {});
      save();
    });
    player.addEventListener("volumechange", save);
  }

  restoreAutosave() {
    const read = (key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return { broken: true }; }
    };
    try {
      const restored = restoreModeDocuments(this.payload, {
        gameFaithful: read(modeStorageKey(this.storageKey, "gameFaithful")),
        free: read(modeStorageKey(this.storageKey, "free")),
        legacy: read(this.legacyStorageKey),
      });
      for (const mode of ["gameFaithful", "free"]) {
        const validated = validateLayoutDocument(restored[mode].document, this.catalog, {
          sourceReleaseId: this.payload.sourceReleaseId,
          catalogHash: this.payload.studio.catalogHash,
        });
        if (validated.ok) {
          restored[mode].document = validated.document;
          this.modeStates[mode] = restored[mode];
        }
      }
      this.document = clone(this.modeStates[this.activeMode].document);
      const notes = [];
      if (restored.migratedLegacy) notes.push("旧布局已迁入完全自由模式");
      if (restored.warnings.length) notes.push("损坏模式已单独重置");
      this.saveStatus.textContent = notes.join(" · ") || "已恢复双模式本机布局";
    } catch {
      this.modeStates = createModeDefaults(this.payload);
      this.document = clone(this.modeStates[this.activeMode].document);
      this.saveStatus.textContent = "本机布局不可读，已使用双模式默认布局";
    }
  }

  save() {
    this.document = { ...this.document, updatedAt: new Date().toISOString() };
    this.modeStates[this.activeMode].document = clone(this.document);
    this.modeStates[this.activeMode].viewport = this.world
      ? { scale: this.world.scale.x, x: this.world.x, y: this.world.y }
      : this.modeStates[this.activeMode].viewport;
    try {
      localStorage.setItem(
        modeStorageKey(this.storageKey, this.activeMode),
        JSON.stringify(this.modeStates[this.activeMode]),
      );
      this.saveStatus.textContent = `已自动保存 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    } catch {
      this.saveStatus.textContent = "自动保存不可用，请手动导出 JSON";
    }
  }

  switchMode(mode) {
    if (!(mode in this.modeStates) || mode === this.activeMode) return;
    this.save();
    this.activeMode = mode;
    this.document = clone(this.modeStates[mode].document);
    this.history = this.histories[mode].history;
    this.future = this.histories[mode].future;
    this.selectedId = null;
    this.pendingFurnitureId = null;
    this.pendingSceneMove = null;
    this.render();
    const viewport = this.modeStates[mode].viewport;
    if (viewport && this.world) {
      this.world.scale.set(viewport.scale);
      this.world.position.set(viewport.x, viewport.y);
    } else {
      this.resetView();
    }
    this.setFeedback(
      mode === "gameFaithful" ? "已切换到贴合游戏场景。" : "已切换到完全自由画布。",
      "success",
    );
  }

  execute(command, successMessage = "布局已更新") {
    if (this.isMobile) {
      this.setFeedback("当前设备为查看模式。", "error");
      return false;
    }
    const previous = this.document;
    const result = applyLayoutCommand(previous, this.catalog, command);
    if (!result.ok) {
      this.setFeedback(result.error.message, "error");
      return false;
    }
    this.history.push(clone(previous));
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future.length = 0;
    this.document = result.document;
    this.save();
    this.render();
    this.setFeedback(successMessage, "success");
    return true;
  }

  render() {
    if (!this.app) return;
    this.renderGrid();
    this.renderFurniture();
    this.renderStaff();
    this.renderInspector();
    this.renderModeControls();
    this.storeSelect.value = `${this.document.storeSize.level}:${this.document.storeSize.width}:${this.document.storeSize.height}`;
    this.summary.textContent = `${this.document.placements.length} 件家具 · ${this.document.storeSize.width}×${this.document.storeSize.height}`;
    this.querySelector('[data-action="undo"]').disabled = this.history.length === 0;
    this.querySelector('[data-action="redo"]').disabled = this.future.length === 0;
  }

  renderGrid() {
    this.gridLayer.removeChildren().forEach((child) => child.destroy());
    const { Graphics } = this.PIXI;
    const size = this.document.storeSize;
    const sceneBounds = this.catalog.scene?.bounds;
    const bounds = this.activeMode === "gameFaithful" && sceneBounds
      ? sceneBounds
      : { minX: -2, minY: -2, maxX: size.width + 2, maxY: size.height + 2 };
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        const inside = x >= 0 && y >= 0 && x < size.width && y < size.height;
        const point = this.tileToWorld(x, y);
        const tile = new Graphics();
        tile.lineStyle(inside ? 1.2 : 1, inside ? this.palette.secondary : this.palette.border, inside ? 0.72 : 0.18);
        tile.beginFill(inside ? this.palette.surface : this.palette.inverseSurface, inside ? 0.92 : 0.34);
        tile.drawPolygon([0, TILE_HEIGHT / 2, TILE_WIDTH / 2, 0, TILE_WIDTH, TILE_HEIGHT / 2, TILE_WIDTH / 2, TILE_HEIGHT]);
        tile.endFill();
        tile.position.set(point.x, point.y);
        tile.zIndex = x + y - 1000;
        this.gridLayer.addChild(tile);
      }
    }
    for (const tileIndex of this.catalog.map.fixedTileIndexes ?? []) {
      const local = this.globalTileToLocal(tileIndex);
      if (local.x < -2 || local.y < -2 || local.x > size.width + 2 || local.y > size.height + 2) continue;
      const point = this.tileToWorld(local.x, local.y);
      const marker = new Graphics();
      marker.beginFill(this.palette.accentBright, 0.35);
      marker.drawPolygon([0, TILE_HEIGHT / 2, TILE_WIDTH / 2, 0, TILE_WIDTH, TILE_HEIGHT / 2, TILE_WIDTH / 2, TILE_HEIGHT]);
      marker.endFill();
      marker.position.set(point.x, point.y);
      marker.zIndex = local.x + local.y - 900;
      this.gridLayer.addChild(marker);
    }
  }

  renderFurniture() {
    this.furnitureLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    const { Container, Graphics, Sprite, Text } = this.PIXI;
    this.renderSceneObjects();
    for (const placement of this.document.placements) {
      const furniture = this.furnitureById.get(placement.furnitureId);
      if (!furniture) continue;
      const url = this.imageByKey[String(furniture.imageKey).toLocaleLowerCase("en-US")];
      const footprint = placement.direction % 2 === 1
        ? { width: furniture.footprint.height, height: furniture.footprint.width }
        : furniture.footprint;
      const container = new Container();
      const point = this.tileToWorld(placement.x, placement.y);
      const footprintGraphic = new Graphics();
      const corners = this.footprintPolygon(footprint.width, footprint.height);
      footprintGraphic.lineStyle(2, this.selectedId === placement.instanceId ? this.palette.accentBright : this.palette.secondary, this.selectedId === placement.instanceId ? 1 : 0.45);
      footprintGraphic.beginFill(this.palette.secondary, this.selectedId === placement.instanceId ? 0.18 : 0.06);
      footprintGraphic.drawPolygon(corners);
      footprintGraphic.endFill();
      container.addChild(footprintGraphic);
      if (url) {
        const sprite = Sprite.from(url);
        sprite.anchor.set(0.5, 0.88);
        const width = Math.max(TILE_WIDTH * 0.85, footprint.width * TILE_WIDTH * 0.82);
        const configureSprite = () => {
          if (sprite.destroyed || !sprite.texture) return;
          const scale = Math.min(
            width / Math.max(sprite.texture.width, 1),
            150 / Math.max(sprite.texture.height, 1)
          );
          sprite.scale.set(
            scale * (placement.direction === 1 || placement.direction === 2 ? -1 : 1),
            scale
          );
          sprite.visible = true;
        };
        if (sprite.texture.baseTexture.valid) {
          configureSprite();
        } else {
          sprite.visible = false;
          sprite.texture.baseTexture.once("loaded", configureSprite);
        }
        const center = this.tileToWorld((footprint.width - 1) / 2, (footprint.height - 1) / 2);
        sprite.position.set(center.x + TILE_WIDTH / 2, center.y + TILE_HEIGHT * 0.88);
        container.addChild(sprite);
      } else {
        const label = new Text(furniture.name, {
          fontFamily: "sans-serif", fontSize: 10, fill: this.palette.inverseText,
          stroke: this.palette.inverseSurface, strokeThickness: 3,
        });
        label.anchor.set(0.5, 1);
        label.position.set(TILE_WIDTH / 2, TILE_HEIGHT / 2);
        container.addChild(label);
      }
      container.position.set(point.x, point.y);
      container.zIndex = depthForFootprint(placement, footprint) * 100;
      container.eventMode = "static";
      container.cursor = this.isMobile ? "pointer" : "grab";
      container.on("pointerdown", (event) => {
        event.stopPropagation();
        this.selectedId = placement.instanceId;
        if (!this.isMobile) this.draggingId = placement.instanceId;
        this.render();
      });
      this.furnitureLayer.addChild(container);
    }
    this.renderDeliveryMarker();
  }

  renderSceneObjects() {
    const scene = this.catalog.scene;
    if (!scene) return;
    const objects = this.activeMode === "gameFaithful"
      ? [...(scene.staticObjects ?? []), scene.warehouse]
      : this.modeStates.free.warehouse.visible
        ? [{ ...scene.warehouse, ...this.modeStates.free.warehouse, fixed: false }]
        : [];
    for (const item of objects.filter(Boolean)) {
      const point = this.tileToWorld(item.x, item.y);
      const footprint = item.footprint ?? { width: 1, height: 1 };
      const container = new this.PIXI.Container();
      container.position.set(point.x, point.y);
      container.zIndex = depthForFootprint(item, footprint) * 100 - 10;
      const url = item.imageKey
        ? this.imageByKey[String(item.imageKey).toLocaleLowerCase("en-US")]
        : null;
      if (url) {
        const sprite = this.PIXI.Sprite.from(url);
        const isGround = String(item.imageKey).includes("_Tile ");
        sprite.anchor.set(0.5, isGround ? 0.5 : 0.88);
        const targetWidth = Math.max(TILE_WIDTH, footprint.width * TILE_WIDTH * 0.92);
        const configure = () => {
          if (sprite.destroyed || !sprite.texture) return;
          const scale = Math.min(
            targetWidth / Math.max(sprite.texture.width, 1),
            180 / Math.max(sprite.texture.height, 1),
          );
          sprite.scale.set(scale);
          sprite.visible = true;
        };
        if (sprite.texture.baseTexture.valid) configure();
        else {
          sprite.visible = false;
          sprite.texture.baseTexture.once("loaded", configure);
        }
        const center = this.tileToWorld((footprint.width - 1) / 2, (footprint.height - 1) / 2);
        sprite.position.set(
          center.x + TILE_WIDTH / 2,
          center.y + (isGround ? TILE_HEIGHT / 2 : TILE_HEIGHT * 0.88),
        );
        container.addChild(sprite);
      } else if (item.id === "warehouse") {
        const outline = new this.PIXI.Graphics();
        outline.lineStyle(3, this.palette.warning, 1);
        outline.beginFill(this.palette.inverseSurface, 0.82);
        outline.drawPolygon(this.footprintPolygon(footprint.width, footprint.height));
        outline.endFill();
        const label = new this.PIXI.Text("补货仓库", {
          fontFamily: "sans-serif", fontSize: 12, fontWeight: "700", fill: this.palette.inverseText,
        });
        label.anchor.set(0.5);
        label.position.set(TILE_WIDTH / 2, TILE_HEIGHT);
        container.addChild(outline, label);
      }
      this.furnitureLayer.addChild(container);
    }
  }

  renderDeliveryMarker() {
    const state = this.modeStates[this.activeMode].delivery;
    if (!state.visible) return;
    const option = this.payload.studio.deliveryOptions.find((item) => item.id === state.optionId)
      ?? this.payload.studio.deliveryOptions[0];
    const point = this.tileToWorld(state.x, state.y);
    const container = new this.PIXI.Container();
    const marker = new this.PIXI.Graphics();
    marker.beginFill(this.palette.warning, 0.98);
    marker.lineStyle(3, this.palette.surface, 1);
    marker.drawCircle(0, 0, 23);
    marker.endFill();
    const icon = new this.PIXI.Text("📦", { fontSize: 20 });
    icon.anchor.set(0.5);
    const label = new this.PIXI.Text(`${option?.name ?? "配送员"} · 位置预览`, {
      fontFamily: "sans-serif", fontSize: 10, fontWeight: "700",
      fill: this.palette.text, stroke: this.palette.surface, strokeThickness: 4,
    });
    label.anchor.set(0.5, 0);
    label.position.set(0, 26);
    container.addChild(marker, icon, label);
    container.position.set(point.x + TILE_WIDTH / 2, point.y + TILE_HEIGHT / 2);
    container.zIndex = depthForFootprint(state) * 100 + 40;
    this.furnitureLayer.addChild(container);
  }

  staffAssignmentState() {
    if (!this.staffDataset?.assignmentStudio) return null;
    try {
      const stored = JSON.parse(localStorage.getItem(this.staffStorageKey) || "null");
      return normalizeAssignmentState(this.staffDataset, stored ?? undefined).state;
    } catch {
      return normalizeAssignmentState(this.staffDataset, undefined).state;
    }
  }

  staffAnchor(role, index) {
    const { width, height } = this.document.storeSize;
    if (role === "cashier") return { x: Math.max(0, width - 2 - index), y: Math.max(0, height - 2) };
    if (role === "sales") return { x: Math.max(0, Math.floor(width / 2) + index), y: Math.max(0, Math.floor(height / 2)) };
    return { x: Math.min(1, width - 1), y: Math.max(0, height - 2) };
  }

  renderStaff() {
    const state = this.staffAssignmentState();
    if (!state) return;
    const roleIndexes = { cashier: 0, sales: 0, restock: 0 };
    const { Container, Graphics, Sprite, Text } = this.PIXI;
    for (const character of this.staffDataset.records) {
      const role = state.assignments[character.id];
      if (!(role in roleIndexes)) continue;
      const url = character.imageKey
        ? this.imageByKey[String(character.imageKey).toLocaleLowerCase("en-US")]
        : null;
      if (!url) continue;
      const index = roleIndexes[role]++;
      const anchor = this.staffAnchor(role, index);
      const point = this.tileToWorld(anchor.x, anchor.y);
      const container = new Container();
      const badge = new Graphics();
      badge.beginFill(this.palette.surface, 0.96);
      // Match the role identities used by the staff-assignment panel.
      badge.lineStyle(3, role === "cashier" ? 0xec7f83 : role === "sales" ? 0x8ad3cf : 0xf0c56e, 1);
      badge.drawCircle(0, 0, 27);
      badge.endFill();
      const sprite = Sprite.from(url);
      sprite.anchor.set(0.5, 0.58);
      sprite.width = 50;
      sprite.height = 50;
      const label = new Text(character.name, {
        fontFamily: "sans-serif",
        fontSize: 11,
        fontWeight: "700",
        fill: this.palette.text,
        stroke: this.palette.surface,
        strokeThickness: 3,
      });
      label.anchor.set(0.5, 0);
      label.position.set(0, 29);
      container.addChild(badge, sprite, label);
      container.position.set(point.x + TILE_WIDTH / 2, point.y - 14);
      container.zIndex = depthForFootprint(anchor) * 100 + 20;
      this.furnitureLayer.addChild(container);
    }
  }

  renderModeControls() {
    this.querySelectorAll("[data-studio-mode]").forEach((button) => {
      const active = button.dataset.studioMode === this.activeMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (this.modeDescription) {
      this.modeDescription.textContent = this.activeMode === "gameFaithful"
        ? "固定店外环境与真实配送起点；家具和未解锁尺寸仍可预览。"
        : "空白画布；仓库和配送标记可自由定位。";
    }
    const state = this.modeStates[this.activeMode];
    if (this.deliverySelect) this.deliverySelect.value = state.delivery.optionId ?? "";
    if (this.deliveryVisible) this.deliveryVisible.checked = state.delivery.visible;
    if (this.warehouseVisible) {
      this.warehouseVisible.checked = this.modeStates.free.warehouse.visible;
      this.warehouseVisible.closest("label").hidden = this.activeMode !== "free";
    }
    this.querySelectorAll("[data-free-only]").forEach((element) => {
      element.hidden = this.activeMode !== "free";
    });
  }

  footprintPolygon(width, height) {
    return projectedFootprintPolygon(width, height, {
      tileWidth: TILE_WIDTH,
      tileHeight: TILE_HEIGHT,
    });
  }

  tileToWorld(x, y) {
    return projectTileToWorld(x, y, { tileWidth: TILE_WIDTH, tileHeight: TILE_HEIGHT });
  }

  globalTileToLocal(tileIndex) {
    return globalTileToLocal(
      tileIndex,
      this.catalog.map.grid.width,
      this.catalog.map.storeAnchorTileIndex,
    );
  }

  pointerToTile(event) {
    const rect = this.app.view.getBoundingClientRect();
    const global = new this.PIXI.Point(
      (event.clientX - rect.left) * this.app.renderer.screen.width / rect.width,
      (event.clientY - rect.top) * this.app.renderer.screen.height / rect.height
    );
    const local = this.world.toLocal(global);
    return worldToTile(local, { tileWidth: TILE_WIDTH, tileHeight: TILE_HEIGHT });
  }

  finishPointer(event) {
    this.clearGhost();
    const gestureResult = finishCanvasGesture(this.pointerGesture, event);
    if (gestureResult.handled) this.cancelPointerGesture(event.pointerId);
    if (gestureResult.didPan) {
      this.draggingId = null;
      return;
    }
    if (this.draggingId) {
      const instanceId = this.draggingId;
      this.draggingId = null;
      const tile = this.pointerToTile(event);
      this.execute({ type: "move", instanceId, ...tile }, "家具已移动");
      return;
    }
    if (!gestureResult.shouldActivateCanvas) return;
    if (this.pendingSceneMove) {
      const tile = this.pointerToTile(event);
      const target = this.modeStates.free[this.pendingSceneMove];
      target.x = tile.x;
      target.y = tile.y;
      target.visible = true;
      const label = this.pendingSceneMove === "warehouse" ? "仓库" : "配送点";
      this.pendingSceneMove = null;
      this.save();
      this.render();
      this.setFeedback(`${label}已移动到 X ${tile.x} · Y ${tile.y}`, "success");
      return;
    }
    if (this.pendingFurnitureId) {
      this.placeAtPointer(this.pendingFurnitureId, event);
    }
  }

  cancelPointerGesture(pointerId) {
    if (!this.pointerGesture || this.pointerGesture.pointerId !== pointerId) return;
    this.pointerGesture = null;
    this.canvasHost?.removeAttribute("data-panning");
    const canvas = this.app?.view;
    try {
      if (canvas?.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
    } catch { /* capture may already have ended */ }
  }

  cancelCanvasInput(event) {
    this.cancelPointerGesture(event.pointerId);
    this.draggingId = null;
    this.clearGhost();
  }

  placeAtPointer(furnitureId, event) {
    this.clearGhost();
    const tile = this.pointerToTile(event);
    const furniture = this.furnitureById.get(furnitureId);
    if (!furniture) return;
    const instanceId = crypto.randomUUID?.() || `furniture-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousSelectedId = this.selectedId;
    this.selectedId = instanceId;
    const placed = this.execute({
      type: "place",
      placement: { instanceId, furnitureId, ...tile, direction: furniture.directions[0] }
    }, `${furniture.name} 已放入店铺`);
    if (placed) {
      this.pendingFurnitureId = null;
      this.updateCatalogSelection();
    } else {
      this.selectedId = previousSelectedId;
    }
  }

  selectCatalogFurniture(id) {
    this.pendingFurnitureId = id;
    this.updateCatalogSelection();
    this.setFeedback(`已选择 ${this.furnitureById.get(id)?.name}，请点击画布落点。`, "ready");
    this.canvasHost.focus();
  }

  updateCatalogSelection() {
    this.querySelectorAll("[data-furniture-id]").forEach((button) => {
      button.classList.toggle("is-selected", button.dataset.furnitureId === this.pendingFurnitureId);
    });
  }

  renderGhost(event) {
    this.clearGhost();
    const tile = this.pointerToTile(event);
    let placement;
    let result;
    if (this.draggingId) {
      const current = this.document.placements.find((item) => item.instanceId === this.draggingId);
      if (!current) return;
      placement = { ...current, ...tile };
      result = applyLayoutCommand(this.document, this.catalog, {
        type: "move",
        instanceId: current.instanceId,
        ...tile
      });
    } else {
      const furniture = this.furnitureById.get(this.pendingFurnitureId);
      if (!furniture) return;
      placement = {
        instanceId: "studio-ghost",
        furnitureId: furniture.id,
        ...tile,
        direction: furniture.directions[0]
      };
      result = applyLayoutCommand(this.document, this.catalog, { type: "place", placement });
    }
    const furniture = this.furnitureById.get(placement.furnitureId);
    const footprint = placement.direction % 2 === 1
      ? { width: furniture.footprint.height, height: furniture.footprint.width }
      : furniture.footprint;
    const ghost = new this.PIXI.Graphics();
    const color = result.ok ? this.palette.success : this.palette.danger;
    ghost.lineStyle(3, color, 1);
    ghost.beginFill(color, 0.26);
    ghost.drawPolygon(this.footprintPolygon(footprint.width, footprint.height));
    ghost.endFill();
    const point = this.tileToWorld(placement.x, placement.y);
    ghost.position.set(point.x, point.y);
    ghost.zIndex = 100000;
    this.ghostLayer.addChild(ghost);
  }

  clearGhost() {
    this.ghostLayer?.removeChildren().forEach((child) => child.destroy());
  }

  renderInspector() {
    const placement = this.document.placements.find((item) => item.instanceId === this.selectedId);
    if (!placement) {
      this.selectedId = null;
      this.inspector.hidden = true;
      this.inspectorEmpty.hidden = false;
      return;
    }
    const furniture = this.furnitureById.get(placement.furnitureId);
    this.inspector.hidden = false;
    this.inspectorEmpty.hidden = true;
    const image = this.querySelector("[data-inspector-image]");
    image.src = this.imageByKey[String(furniture.imageKey).toLocaleLowerCase("en-US")];
    this.querySelector("[data-inspector-name]").textContent = furniture.name;
    this.querySelector("[data-inspector-meta]").textContent = `${furniture.category} · ${furniture.subCategory}`;
    this.querySelector("[data-inspector-position]").textContent = `X ${placement.x} · Y ${placement.y}`;
    this.querySelector("[data-inspector-direction]").textContent = `${placement.direction * 90}°`;
    const footprint = placement.direction % 2 === 1
      ? { width: furniture.footprint.height, height: furniture.footprint.width }
      : furniture.footprint;
    this.querySelector("[data-inspector-size]").textContent = `${footprint.width}×${footprint.height}`;
  }

  handleAction(action) {
    if (action === "undo") return this.undo();
    if (action === "redo") return this.redo();
    if (action === "restore") return this.restoreInitial();
    if (action === "clear") {
      if (this.document.placements.length && !confirm("清空当前店铺布局？之后仍可立即撤销。")) return;
      return this.execute({ type: "clear" }, "店铺已清空，可使用撤销恢复");
    }
    if (action === "import") return this.importInput.click();
    if (action === "export-json") return this.exportJson();
    if (action === "export-png") return this.exportPng();
    if (action === "zoom-in") return this.zoom(1.12);
    if (action === "zoom-out") return this.zoom(0.88);
    if (action === "reset-view") return this.resetView();
    if (action === "view-store") return this.centerOn({ x: 4, y: 4 });
    if (action === "view-warehouse") {
      const warehouse = this.activeMode === "gameFaithful"
        ? this.catalog.scene.warehouse
        : this.modeStates.free.warehouse;
      return this.centerOn(warehouse);
    }
    if (action === "view-delivery") return this.centerOn(this.modeStates[this.activeMode].delivery);
    if (action === "fit-scene") return this.fitScene();
    if (action === "move-warehouse" || action === "move-delivery") {
      if (this.activeMode !== "free") return;
      this.pendingSceneMove = action === "move-warehouse" ? "warehouse" : "delivery";
      this.setFeedback(`请在画布中点击新的${this.pendingSceneMove === "warehouse" ? "仓库" : "配送点"}位置。`, "ready");
      return;
    }
    if (!this.selectedId) return this.setFeedback("请先选择一件家具。", "error");
    if (action === "rotate") return this.rotateSelected();
    if (action === "duplicate") return this.duplicateSelected();
    if (action === "remove") {
      const selected = this.selectedId;
      this.selectedId = null;
      return this.execute({ type: "remove", instanceId: selected }, "家具已回到库存");
    }
    if (action === "center-selected") return this.centerSelected();
  }

  rotateSelected() {
    const placement = this.document.placements.find((item) => item.instanceId === this.selectedId);
    if (!placement) return this.setFeedback("请先选择一件家具。", "error");
    const furniture = this.furnitureById.get(placement.furnitureId);
    const index = furniture.directions.indexOf(placement.direction);
    const direction = furniture.directions[(index + 1) % furniture.directions.length];
    this.execute({ type: "rotate", instanceId: placement.instanceId, direction }, "家具已旋转");
  }

  duplicateSelected() {
    const placement = this.document.placements.find((item) => item.instanceId === this.selectedId);
    if (!placement) return this.setFeedback("请先选择一件家具。", "error");
    const offsets = [[1, 0], [0, 1], [2, 0], [0, 2], [-1, 0], [0, -1]];
    for (const [x, y] of offsets) {
      const newInstanceId = crypto.randomUUID?.() || `copy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      if (this.execute({
        type: "duplicate",
        instanceId: placement.instanceId,
        newInstanceId,
        x: placement.x + x,
        y: placement.y + y
      }, "家具已复制")) {
        this.selectedId = newInstanceId;
        this.render();
        return;
      }
    }
    this.setFeedback("附近没有可用于复制的合法空位。", "error");
  }

  restoreInitial() {
    const initialSize = this.activeMode === "gameFaithful"
      ? this.catalog.storeSizes[0]
      : this.catalog.storeSizes.at(-1);
    const candidate = {
      ...this.document,
      storeSize: { ...initialSize },
      placements: clone(this.payload.studio.modes[this.activeMode].defaultLayout)
    };
    const validated = validateLayoutDocument(candidate, this.catalog, {
      sourceReleaseId: this.payload.sourceReleaseId,
      catalogHash: this.payload.studio.catalogHash
    });
    if (!validated.ok) return this.setFeedback(`初始布局不可用：${validated.error.message}`, "error");
    this.history.push(clone(this.document));
    this.future.length = 0;
    this.document = validated.document;
    this.selectedId = null;
    this.save();
    this.render();
    this.resetView();
    this.setFeedback(
      this.activeMode === "gameFaithful"
        ? "已恢复游戏初始店铺面积与家具布局。"
        : "已恢复完全自由空白画布。",
      "success",
    );
  }

  resizeStore() {
    const [level, width, height] = this.storeSelect.value.split(":").map(Number);
    if (!this.execute({ type: "resizeStore", storeSize: { level, width, height } }, `店铺面积已切换为 ${width}×${height}`)) {
      this.storeSelect.value = `${this.document.storeSize.level}:${this.document.storeSize.width}:${this.document.storeSize.height}`;
    }
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(clone(this.document));
    this.document = this.history.pop();
    this.save();
    this.render();
    this.setFeedback("已撤销上一步。", "success");
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(clone(this.document));
    this.document = this.future.pop();
    this.save();
    this.render();
    this.setFeedback("已重做。", "success");
  }

  handleShortcut(event) {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      return event.shiftKey ? this.redo() : this.undo();
    }
    if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault();
      return this.redo();
    }
    if (event.key.toLowerCase() === "r" && !modifier) return this.rotateSelected();
    if ((event.key === "Delete" || event.key === "Backspace") && this.selectedId) {
      event.preventDefault();
      return this.handleAction("remove");
    }
  }

  filterFurniture() {
    const query = this.searchInput.value.trim().toLocaleLowerCase("zh-CN");
    const category = this.categorySelect.value;
    this.querySelectorAll("[data-furniture-id]").forEach((button) => {
      button.hidden = Boolean(
        (query && !button.dataset.name.includes(query)) ||
        (category && button.dataset.category !== category)
      );
    });
  }

  exportJson() {
    downloadBlob(
      new Blob([`${JSON.stringify(this.document, null, 2)}\n`], { type: "application/json" }),
      `anontokyo-${this.activeMode === "gameFaithful" ? "faithful" : "free"}-${new Date().toISOString().slice(0, 10)}.json`
    );
    this.setFeedback("布局 JSON 已导出。", "success");
  }

  async importJson() {
    const file = this.importInput.files?.[0];
    this.importInput.value = "";
    if (!file) return;
    try {
      const value = JSON.parse(await file.text());
      const result = validateLayoutDocument(value, this.catalog, {
        sourceReleaseId: this.payload.sourceReleaseId,
        catalogHash: this.payload.studio.catalogHash
      });
      if (!result.ok) throw new Error(result.error.details?.length
        ? `${result.error.message}：${result.error.details.join("、")}`
        : result.error.message);
      this.history.push(clone(this.document));
      this.future.length = 0;
      this.document = result.document;
      this.selectedId = null;
      this.save();
      this.render();
      this.resetView();
      this.setFeedback("布局 JSON 已完整校验并导入。", "success");
    } catch (error) {
      this.setFeedback(`导入失败：${error instanceof Error ? error.message : "文件不可读"}`, "error");
    }
  }

  exportPng() {
    if (!this.app) return this.setFeedback("画布尚未准备好。", "error");
    try {
      const canvas = this.app.renderer.extract.canvas(this.app.stage);
      canvas.toBlob((blob) => {
        if (!blob) return this.setFeedback("PNG 生成失败。", "error");
        downloadBlob(blob, `anontokyo-studio-${new Date().toISOString().slice(0, 10)}.png`);
        this.setFeedback("当前可见场景已导出为 PNG。", "success");
      }, "image/png");
    } catch (error) {
      this.setFeedback(`PNG 导出失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  zoom(factor) {
    if (!this.world) return;
    const scale = Math.max(0.45, Math.min(1.65, this.world.scale.x * factor));
    this.world.scale.set(scale);
  }

  resetView() {
    if (!this.world) return;
    this.world.scale.set(0.78);
    if (this.activeMode === "gameFaithful") {
      this.centerOn({ x: 4, y: 4 }, false);
    } else {
      this.world.position.set(this.canvasHost.clientWidth / 2 - TILE_WIDTH / 2, 54);
    }
  }

  centerOn(position, keepScale = true) {
    if (!this.world || !position) return;
    if (!keepScale) this.world.scale.set(0.78);
    const point = this.tileToWorld(position.x, position.y);
    this.world.position.set(
      this.canvasHost.clientWidth / 2 - point.x * this.world.scale.x,
      this.canvasHost.clientHeight / 2 - point.y * this.world.scale.y,
    );
  }

  fitScene() {
    if (!this.world) return;
    const bounds = this.activeMode === "gameFaithful"
      ? this.catalog.scene.bounds
      : { minX: -2, minY: -2, maxX: this.document.storeSize.width + 2, maxY: this.document.storeSize.height + 2 };
    const corners = [
      this.tileToWorld(bounds.minX, bounds.minY),
      this.tileToWorld(bounds.maxX, bounds.minY),
      this.tileToWorld(bounds.maxX, bounds.maxY),
      this.tileToWorld(bounds.minX, bounds.maxY),
    ];
    const minX = Math.min(...corners.map((point) => point.x));
    const maxX = Math.max(...corners.map((point) => point.x)) + TILE_WIDTH;
    const minY = Math.min(...corners.map((point) => point.y));
    const maxY = Math.max(...corners.map((point) => point.y)) + TILE_HEIGHT;
    const scale = Math.max(0.35, Math.min(
      1,
      (this.canvasHost.clientWidth - 48) / Math.max(maxX - minX, 1),
      (this.canvasHost.clientHeight - 48) / Math.max(maxY - minY, 1),
    ));
    this.world.scale.set(scale);
    this.world.position.set(
      this.canvasHost.clientWidth / 2 - (minX + maxX) / 2 * scale,
      this.canvasHost.clientHeight / 2 - (minY + maxY) / 2 * scale,
    );
  }

  centerSelected() {
    const placement = this.document.placements.find((item) => item.instanceId === this.selectedId);
    if (!placement) return;
    const point = this.tileToWorld(placement.x, placement.y);
    this.world.position.set(
      this.canvasHost.clientWidth / 2 - point.x * this.world.scale.x,
      this.canvasHost.clientHeight / 2 - point.y * this.world.scale.y
    );
  }

  setFeedback(message, tone) {
    this.feedback.textContent = message;
    this.feedback.dataset.tone = tone;
  }

  disconnectedCallback() {
    this.disconnectTheme?.();
    this.pointerGesture = null;
    this.draggingId = null;
    this.canvasHost?.removeAttribute("data-panning");
    this.clearGhost();
  }
}


export function defineAnonTokyoStudio() {
  if (!customElements.get("anon-tokyo-studio")) {
    customElements.define("anon-tokyo-studio", AnonTokyoStudioElement);
  }
}
