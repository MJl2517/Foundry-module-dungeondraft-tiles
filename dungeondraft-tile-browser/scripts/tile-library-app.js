import { LibraryStore, MODULE_ID, MODULE_PATH } from "./library-store.js";
import { labels, t } from "./i18n.js";
import { TilePlacer } from "./tile-placer.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const COLOR_LIMIT = 20;
const DEFAULT_MAP_DPI = 256;

export class TileLibraryApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-app`,
    classes: [MODULE_ID],
    window: {
      title: "DDBrowser.Title",
      icon: "fa-solid fa-layer-group",
      resizable: true
    },
    position: {
      width: 980,
      height: 720
    }
  };

  static PARTS = {
    main: {
      template: `${MODULE_PATH}/templates/tile-library.hbs`
    }
  };

  constructor(options = {}) {
    super(options);
    this.filters = { assetSearch: "", author: "" };
    this.selectedAssetTagFilters = new Set();
    this.palette = getStoredPalette();
    this.color = this.palette.selected;
    this.snapToGrid = Boolean(game.settings.get(MODULE_ID, "snapToGrid"));
    this.lockPlacedTiles = Boolean(game.settings.get(MODULE_ID, "lockPlacedTiles"));
    this.mapDpi = normalizeMapDpi(game.settings.get(MODULE_ID, "mapDpi"));
    this.visibleAssets = [];
    this.itemSize = Number(game.settings.get(MODULE_ID, "thumbnailSize")) || 160;
    this.rowHeight = this.itemSize + 64;
    this.resizeObserver = null;
    this.contextMenu = null;
    this.tagDialog = null;
    this.boundCloseContextMenu = (event) => {
      if (event?.type === "keydown" && event.key !== "Escape") return;
      this.closeContextMenu();
    };
  }

  static open() {
    this.instance ??= new TileLibraryApp();
    return this.instance.render(true);
  }

  async _prepareContext(options) {
    const library = LibraryStore.library;
    const filterOptions = LibraryStore.getFilterOptions();
    this.itemSize = Number(game.settings.get(MODULE_ID, "thumbnailSize")) || 160;
    this.rowHeight = this.itemSize + 64;
    return {
      ...(await super._prepareContext(options)),
      canImport: game.user.isGM,
      packs: Object.values(library.packs).filter((pack) => pack.hidden !== true).sort((a, b) => a.name.localeCompare(b.name)),
      authors: filterOptions.authors.map((author) => ({
        value: author,
        selected: this.filters.author === author
      })),
      filters: this.filters,
      selectedTagFilterCount: this.selectedAssetTagFilters.size,
      labels: labels(),
      color: this.color,
      paletteSwatches: getPaletteSwatches(this.palette, this.color),
      hasEyeDropper: typeof window.EyeDropper === "function",
      snapToGrid: this.snapToGrid,
      lockPlacedTiles: this.lockPlacedTiles,
      mapDpi: this.mapDpi,
      hasAssets: Object.keys(library.assets).length > 0
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.activateListeners();
    this.refreshGrid();
    this.updatePackVisibility();
  }

  async _onClose(options) {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.closeContextMenu();
    this.closeTagDialog();
    await super._onClose(options);
  }

  activateListeners() {
    const root = this.element;
    root.querySelector("[data-import-pack]")?.addEventListener("click", () => this.importPack());
    root.querySelector("[data-import-folder]")?.addEventListener("click", () => this.importFolder());
    root.querySelector("[data-clear-filters]")?.addEventListener("click", () => this.clearFilters());
    root.querySelector("[data-filter-asset-tags]")?.addEventListener("click", () => this.openAssetTagFilterDialog());
    root.querySelector("[data-manage-packs]")?.addEventListener("click", () => this.openPackManager());
    root.querySelector("[data-manage-pack-tags]")?.addEventListener("click", () => this.openTagManager("pack"));
    root.querySelector("[data-manage-assets]")?.addEventListener("click", () => this.openAssetManager());
    root.querySelector("[data-manage-asset-tags]")?.addEventListener("click", () => this.openTagManager("asset"));
    root.querySelector("[data-asset-search]")?.addEventListener("input", (event) => {
      this.filters.assetSearch = event.currentTarget.value;
      this.refreshGrid();
      this.updatePackVisibility();
    });
    root.querySelector("[data-author]")?.addEventListener("change", (event) => {
      this.filters.author = event.currentTarget.value;
      this.refreshGrid();
      this.updatePackVisibility();
    });
    root.querySelector("[data-color]")?.addEventListener("input", (event) => {
      this.color = event.currentTarget.value;
      this.updateColorableState();
    });
    root.querySelector("[data-color]")?.addEventListener("change", (event) => {
      this.setCurrentColor(event.currentTarget.value, { remember: true });
    });
    root.querySelector("[data-eyedropper]")?.addEventListener("click", () => this.pickColorFromScreen());
    root.querySelector("[data-snap-to-grid]")?.addEventListener("change", async (event) => {
      this.snapToGrid = event.currentTarget.checked;
      await game.settings.set(MODULE_ID, "snapToGrid", this.snapToGrid);
      this.applyPlacementOptions();
    });
    root.querySelector("[data-lock-placed-tiles]")?.addEventListener("change", async (event) => {
      this.lockPlacedTiles = event.currentTarget.checked;
      await game.settings.set(MODULE_ID, "lockPlacedTiles", this.lockPlacedTiles);
      this.applyPlacementOptions();
    });
    root.querySelector("[data-map-dpi]")?.addEventListener("change", async (event) => {
      this.mapDpi = normalizeMapDpi(event.currentTarget.value);
      event.currentTarget.value = String(this.mapDpi);
      await game.settings.set(MODULE_ID, "mapDpi", this.mapDpi);
      this.applyPlacementOptions();
    });

    this.bindPaletteSwatches();

    for (const input of root.querySelectorAll("[data-pack-enabled]")) {
      input.addEventListener("change", async (event) => {
        await LibraryStore.setPackEnabled(event.currentTarget.dataset.packEnabled, event.currentTarget.checked);
        this.refreshGrid();
      });
    }
    root.querySelector("[data-enable-visible-packs]")?.addEventListener("click", () => this.setVisiblePacksEnabled(true));
    root.querySelector("[data-disable-visible-packs]")?.addEventListener("click", () => this.setVisiblePacksEnabled(false));

    for (const row of root.querySelectorAll("[data-pack-row]")) {
      row.addEventListener("contextmenu", (event) => this.openPackContextMenu(event, row.dataset.packId));
    }

    root.addEventListener("dragover", (event) => this.onDragOver(event));
    root.addEventListener("dragleave", (event) => this.onDragLeave(event));
    root.addEventListener("drop", (event) => this.onDrop(event));

    const viewport = root.querySelector("[data-tile-grid-viewport]");
    viewport?.addEventListener("scroll", () => this.renderVisibleRows());
    viewport?.addEventListener("scroll", () => this.closeContextMenu());
    root.querySelector(".ddb-pack-list")?.addEventListener("scroll", () => this.closeContextMenu());
    this.resizeObserver?.disconnect();
    if (viewport && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.renderVisibleRows());
      this.resizeObserver.observe(viewport);
    }
  }

  async importPack() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".dungeondraft_pack";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        await this.importPackFile(file);
      } catch (error) {
        console.error(`${MODULE_ID} | Pack import failed`, error);
        ui.notifications.error(error.message || String(error));
        this.setStatus("");
      }
    });
    input.click();
  }

  async importFolder() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;

      try {
        await this.importImageFiles(files);
      } catch (error) {
        console.error(`${MODULE_ID} | Folder import failed`, error);
        ui.notifications.error(error.message || String(error));
        this.setStatus("");
      }
    });
    input.click();
  }

  async importPackFile(file, { notify = true, render = true, statusPrefix = "" } = {}) {
    this.setStatus(t("Importing"));
    await LibraryStore.importPack(file, {
      onProgress: (message) => this.setStatus(statusPrefix ? `${statusPrefix}: ${message}` : message)
    });
    if (notify) ui.notifications.info(`Imported ${file.name}`);
    if (render) await this.renderPreservingScroll();
  }

  async importImageFiles(files, options = {}) {
    this.setStatus(t("ImportingFolder"));
    await LibraryStore.importImageFiles(files, {
      ...options,
      onProgress: (message) => this.setStatus(message)
    });
    ui.notifications.info(`Imported ${files.length} image file(s)`);
    await this.renderPreservingScroll();
  }

  async pickColorFromScreen() {
    if (typeof window.EyeDropper !== "function") {
      ui.notifications.warn("EyeDropper is not supported in this Foundry browser.");
      return;
    }

    try {
      const result = await new window.EyeDropper().open();
      await this.setCurrentColor(result.sRGBHex, { remember: true });
    } catch (error) {
      if (error?.name !== "AbortError") console.debug(`${MODULE_ID} | EyeDropper cancelled`, error);
    }
  }

  async setCurrentColor(color, { remember = false } = {}) {
    const normalized = normalizeHexColor(color);
    this.color = normalized;
    this.palette.selected = normalized;
    if (remember) rememberPaletteColor(this.palette, normalized);
    await savePalette(this.palette);
    this.renderPalette();
  }

  async toggleFavoriteColor(color) {
    const normalized = normalizeHexColor(color);
    const favoriteIndex = this.palette.favorites.indexOf(normalized);
    if (favoriteIndex >= 0) {
      this.palette.favorites.splice(favoriteIndex, 1);
      rememberPaletteColor(this.palette, normalized);
    } else {
      this.palette.favorites.unshift(normalized);
      this.palette.recent = this.palette.recent.filter((entry) => entry !== normalized);
    }
    this.palette.selected = this.color;
    trimPalette(this.palette);
    await savePalette(this.palette);
    this.renderPalette();
  }

  onDragOver(event) {
    if (!game.user.isGM) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    this.element.classList.add("ddb-is-dragging");
  }

  onDragLeave(event) {
    if (this.element.contains(event.relatedTarget)) return;
    this.element.classList.remove("ddb-is-dragging");
  }

  async onDrop(event) {
    if (!game.user.isGM) return;
    event.preventDefault();
    this.element.classList.remove("ddb-is-dragging");

    try {
      const files = await collectDroppedFiles(event.dataTransfer);
      const packs = files.filter((file) => file.name.toLowerCase().endsWith(".dungeondraft_pack"));
      const images = files.filter((file) => isImageFile(file.name));
      const failures = [];
      let importedPacks = 0;

      for (let index = 0; index < packs.length; index += 1) {
        const pack = packs[index];
        try {
          await this.importPackFile(pack, {
            notify: false,
            render: false,
            statusPrefix: `${index + 1} / ${packs.length} ${pack.name}`
          });
          importedPacks += 1;
        } catch (error) {
          failures.push({ name: pack.name, error });
          console.error(`${MODULE_ID} | Drop import failed for ${pack.name}`, error);
          this.setStatus("");
        }
      }

      if (images.length) {
        try {
          await this.importImageFiles(images);
        } catch (error) {
          failures.push({ name: "Dropped image files", error });
          console.error(`${MODULE_ID} | Drop image import failed`, error);
          this.setStatus("");
        }
      } else if (importedPacks) {
        await this.renderPreservingScroll();
      }

      if (!packs.length && !images.length) {
        ui.notifications.warn("Drop .dungeondraft_pack files, image files, or folders with images.");
      }

      if (importedPacks) ui.notifications.info(`Imported ${importedPacks} pack(s)`);

      if (failures.length) {
        const failedNames = failures.map(({ name }) => name).join(", ");
        ui.notifications.warn(`Imported with ${failures.length} failed item(s): ${failedNames}`);
      }

      this.setStatus("");
    } catch (error) {
      console.error(`${MODULE_ID} | Drop import failed`, error);
      ui.notifications.error(error.message || String(error));
      this.setStatus("");
    }
  }

  clearFilters() {
    this.filters = { assetSearch: "", author: "" };
    this.selectedAssetTagFilters.clear();
    this.updateFilterControls();
    this.updateTagFilterButton();
    this.refreshGrid();
    this.updatePackVisibility();
  }

  updatePackVisibility() {
    const assetSearch = this.filters.assetSearch.trim().toLowerCase();
    for (const row of this.element.querySelectorAll("[data-pack-row]")) {
      const haystack = (row.dataset.packHaystack ?? "").toLowerCase();
      const matchesSearch = !assetSearch || haystack.includes(assetSearch);
      const matchesAuthor = !this.filters.author || row.dataset.packAuthor === this.filters.author;
      row.hidden = !(matchesSearch && matchesAuthor);
    }
  }

  async setVisiblePacksEnabled(enabled) {
    if (!game.user.isGM) return;

    this.updatePackVisibility();
    const packIds = Array.from(this.element.querySelectorAll("[data-pack-row]"))
      .filter((row) => !row.hidden)
      .map((row) => row.dataset.packId)
      .filter(Boolean);
    if (!packIds.length) return;

    await LibraryStore.setPacksEnabled(packIds, enabled);
    for (const input of this.element.querySelectorAll("[data-pack-enabled]")) {
      if (packIds.includes(input.dataset.packEnabled)) input.checked = enabled;
    }
    this.refreshGrid();
  }

  refreshGrid() {
    this.visibleAssets = LibraryStore.getAssets({
      ...this.filters,
      assetTagIds: Array.from(this.selectedAssetTagFilters)
    });
    this.clampGridScroll();
    this.renderVisibleRows();
    this.updateColorableState();
  }

  clampGridScroll() {
    const viewport = this.element?.querySelector("[data-tile-grid-viewport]");
    if (!viewport) return;

    const gap = 10;
    const columns = Math.max(1, Math.floor((viewport.clientWidth + gap) / (this.itemSize + gap)));
    const totalRows = Math.ceil(this.visibleAssets.length / columns);
    const maxScroll = Math.max(0, totalRows * this.rowHeight - viewport.clientHeight);
    if (viewport.scrollTop > maxScroll) viewport.scrollTop = maxScroll;
  }

  updateFilterControls() {
    const search = this.element?.querySelector("[data-asset-search]");
    if (search) search.value = this.filters.assetSearch;

    const author = this.element?.querySelector("[data-author]");
    if (author) author.value = this.filters.author;
  }

  updateTagFilterButton() {
    const button = this.element?.querySelector("[data-filter-asset-tags]");
    if (!button) return;

    const count = this.selectedAssetTagFilters.size;
    button.classList.toggle("is-active", count > 0);

    let badge = button.querySelector(".ddb-filter-count");
    if (!count) {
      badge?.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ddb-filter-count";
      button.append(badge);
    }
    badge.textContent = String(count);
  }

  bindPaletteSwatches() {
    for (const swatch of this.element.querySelectorAll("[data-palette-color]")) {
      swatch.addEventListener("click", (event) => {
        this.setCurrentColor(event.currentTarget.dataset.paletteColor, { remember: true });
      });
      swatch.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.toggleFavoriteColor(event.currentTarget.dataset.paletteColor);
      });
    }
  }

  renderPalette() {
    const colorInput = this.element?.querySelector("[data-color]");
    if (colorInput) colorInput.value = this.color;

    const swatches = this.element?.querySelector(".ddb-palette__swatches");
    if (!swatches) return;

    swatches.innerHTML = getPaletteSwatches(this.palette, this.color).map((swatch) => `
      <button
        type="button"
        class="ddb-swatch ${swatch.favorite ? "is-favorite" : ""} ${swatch.selected ? "is-selected" : ""}"
        data-palette-color="${escapeAttribute(swatch.color)}"
        style="--swatch-color: ${escapeAttribute(swatch.color)}"
        title="${escapeAttribute(swatch.color)}"
        aria-label="${escapeAttribute(swatch.color)}"
      ></button>
    `).join("");
    this.bindPaletteSwatches();
  }

  async renderPreservingScroll() {
    const scroll = this.captureScrollState();
    await this.render({ force: true });
    this.restoreScrollState(scroll);
  }

  captureScrollState() {
    return {
      gridTop: this.element?.querySelector("[data-tile-grid-viewport]")?.scrollTop ?? 0,
      packTop: this.element?.querySelector(".ddb-pack-list")?.scrollTop ?? 0
    };
  }

  restoreScrollState({ gridTop = 0, packTop = 0 } = {}) {
    const grid = this.element?.querySelector("[data-tile-grid-viewport]");
    if (grid) {
      grid.scrollTop = Math.max(0, gridTop);
      this.renderVisibleRows();
    }

    const packList = this.element?.querySelector(".ddb-pack-list");
    if (packList) packList.scrollTop = Math.max(0, packTop);
  }

  renderVisibleRows() {
    const root = this.element;
    const viewport = root.querySelector("[data-tile-grid-viewport]");
    const canvas = root.querySelector("[data-tile-grid-canvas]");
    const empty = root.querySelector("[data-empty]");
    if (!viewport || !canvas) return;

    const gap = 10;
    const columns = Math.max(1, Math.floor((viewport.clientWidth + gap) / (this.itemSize + gap)));
    const totalRows = Math.ceil(this.visibleAssets.length / columns);
    const firstRow = Math.max(0, Math.floor(viewport.scrollTop / this.rowHeight) - 2);
    const lastRow = Math.min(totalRows, Math.ceil((viewport.scrollTop + viewport.clientHeight) / this.rowHeight) + 2);
    const firstIndex = firstRow * columns;
    const lastIndex = Math.min(this.visibleAssets.length, lastRow * columns);

    viewport.classList.toggle("is-empty", this.visibleAssets.length === 0);
    canvas.style.height = this.visibleAssets.length ? `${totalRows * this.rowHeight}px` : "0px";
    canvas.innerHTML = "";

    for (let index = firstIndex; index < lastIndex; index += 1) {
      const asset = this.visibleAssets[index];
      const column = index % columns;
      const row = Math.floor(index / columns);
      canvas.appendChild(this.createAssetCard(asset, column * (this.itemSize + gap), row * this.rowHeight));
    }

    empty.hidden = this.visibleAssets.length > 0;
  }

  createAssetCard(asset, x, y) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "ddb-tile-card";
    card.dataset.assetId = asset.id;
    card.dataset.colorable = String(asset.colorable);
    card.style.width = `${this.itemSize}px`;
    card.style.height = `${this.rowHeight - 8}px`;
    card.style.transform = `translate(${x}px, ${y}px)`;
    card.title = asset.name;

    const image = document.createElement("img");
    image.loading = "lazy";
    image.decoding = "async";
    image.src = asset.thumbSrc || asset.src;
    image.alt = asset.name;

    const label = document.createElement("span");
    label.className = "ddb-tile-card__name";
    label.textContent = asset.name;

    const meta = document.createElement("span");
    meta.className = "ddb-tile-card__meta";
    meta.textContent = asset.colorable ? "Colorable" : asset.author;

    card.append(image, label, meta);
    card.addEventListener("click", () => this.selectAsset(asset));
    card.addEventListener("contextmenu", (event) => this.openAssetContextMenu(event, asset));
    return card;
  }

  openAssetContextMenu(event, asset) {
    event.preventDefault();
    event.stopPropagation();
    this.closeContextMenu();

    const menu = document.createElement("div");
    menu.className = "ddb-context-menu";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.dataset.assetContextMenu = asset.id;
    menu.addEventListener("pointerdown", (pointerEvent) => pointerEvent.stopPropagation());

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "ddb-context-menu__settings";
    settingsButton.innerHTML = `<i class="fa-solid fa-gear"></i><span>${t("EntrySettings")}</span>`;
    settingsButton.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      this.closeContextMenu();
      this.openEntrySettingsDialog("asset", asset.id);
    });

    const tagsButton = document.createElement("button");
    tagsButton.type = "button";
    tagsButton.className = "ddb-context-menu__tags";
    tagsButton.innerHTML = `<i class="fa-solid fa-tags"></i><span>${t("Tags")}</span>`;
    tagsButton.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      this.closeContextMenu();
      this.openEntryTagDialog("asset", asset.id, asset.name);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "ddb-context-menu__delete";
    deleteButton.innerHTML = `<i class="fa-solid fa-trash-can"></i><span>${t("DeleteAsset")}</span>`;
    deleteButton.addEventListener("click", async (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      await this.deleteAsset(asset.id);
    });

    menu.append(settingsButton, tagsButton, deleteButton);
    document.body.append(menu);
    this.contextMenu = menu;
    this.constrainContextMenu(menu);

    setTimeout(() => {
      document.addEventListener("pointerdown", this.boundCloseContextMenu, { once: true });
      document.addEventListener("keydown", this.boundCloseContextMenu, { once: true });
      window.addEventListener("blur", this.boundCloseContextMenu, { once: true });
    }, 0);
  }

  openPackContextMenu(event, packId) {
    event.preventDefault();
    event.stopPropagation();
    this.closeContextMenu();

    const pack = LibraryStore.library.packs[packId];
    if (!pack) return;

    const menu = document.createElement("div");
    menu.className = "ddb-context-menu";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.dataset.packContextMenu = packId;
    menu.addEventListener("pointerdown", (pointerEvent) => pointerEvent.stopPropagation());

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "ddb-context-menu__settings";
    settingsButton.innerHTML = `<i class="fa-solid fa-gear"></i><span>${t("EntrySettings")}</span>`;
    settingsButton.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      this.closeContextMenu();
      this.openEntrySettingsDialog("pack", packId);
    });

    const tagsButton = document.createElement("button");
    tagsButton.type = "button";
    tagsButton.className = "ddb-context-menu__tags";
    tagsButton.innerHTML = `<i class="fa-solid fa-tags"></i><span>${t("Tags")}</span>`;
    tagsButton.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      this.closeContextMenu();
      this.openEntryTagDialog("pack", packId, pack.name);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "ddb-context-menu__delete";
    deleteButton.innerHTML = `<i class="fa-solid fa-trash-can"></i><span>${t("DeletePack")}</span>`;
    deleteButton.addEventListener("click", async (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      await this.deletePack(packId);
    });

    menu.append(settingsButton, tagsButton, deleteButton);
    document.body.append(menu);
    this.contextMenu = menu;
    this.constrainContextMenu(menu);

    setTimeout(() => {
      document.addEventListener("pointerdown", this.boundCloseContextMenu, { once: true });
      document.addEventListener("keydown", this.boundCloseContextMenu, { once: true });
      window.addEventListener("blur", this.boundCloseContextMenu, { once: true });
    }, 0);
  }

  openTagManager(scope) {
    if (!game.user.isGM) return;
    this.closeContextMenu();
    const tagLabels = labels();
    const title = scope === "pack" ? tagLabels.PackTags : tagLabels.AssetTags;
    const { body, close } = this.createTagDialog(title, "ddb-tag-manager");

    const render = (search = "", focusSearch = false) => {
      const tags = LibraryStore.getUserTags(scope);
      const query = search.trim().toLowerCase();
      const visibleTags = tags.filter((tag) => !query || tag.name.toLowerCase().includes(query));
      body.innerHTML = `
        <div class="ddb-tag-tools">
          <input type="search" data-tag-search value="${escapeAttribute(search)}" placeholder="${escapeAttribute(tagLabels.SearchTags)}">
          ${scope === "asset" ? `<button type="button" data-bulk-assign-tags><i class="fa-solid fa-list-check"></i><span>${escapeHtml(tagLabels.BulkAssignTags)}</span></button>` : ""}
        </div>
        <div class="ddb-tag-create">
          <input type="text" data-new-tag-name placeholder="${escapeAttribute(tagLabels.NewTag)}" maxlength="60">
          <button type="button" data-create-tag><i class="fa-solid fa-plus"></i><span>${escapeHtml(tagLabels.AddTag)}</span></button>
        </div>
        <div class="ddb-tag-list">
          ${visibleTags.length ? visibleTags.map((tag) => `
            <div class="ddb-tag-row ${isServiceTag(tag) ? "is-service" : ""}" data-tag-id="${escapeAttribute(tag.id)}">
              <span>${escapeHtml(tag.name)}</span>
              <button type="button" class="ddb-icon-button" data-delete-tag title="${escapeAttribute(isServiceTag(tag) ? tagLabels.ServiceTag : tagLabels.DeleteTag)}" ${isServiceTag(tag) ? "disabled" : ""}>
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          `).join("") : `<p class="ddb-tag-empty">${escapeHtml(tagLabels.NoTags)}</p>`}
        </div>
      `;

      body.querySelector("[data-tag-search]")?.addEventListener("input", (event) => render(event.currentTarget.value, true));
      body.querySelector("[data-create-tag]")?.addEventListener("click", async () => {
        const input = body.querySelector("[data-new-tag-name]");
        const name = input?.value ?? "";
        try {
          await LibraryStore.createUserTag(scope, name);
          ui.notifications.info(t("TagCreated"));
          render(body.querySelector("[data-tag-search]")?.value ?? "");
        } catch (error) {
          ui.notifications.error(error.message || String(error));
        }
      });
      body.querySelector("[data-new-tag-name]")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          body.querySelector("[data-create-tag]")?.click();
        }
      });
      body.querySelector("[data-bulk-assign-tags]")?.addEventListener("click", () => this.openBulkAssetTagDialog());
      for (const button of body.querySelectorAll("[data-delete-tag]")) {
        button.addEventListener("click", async (event) => {
          const tagId = event.currentTarget.closest("[data-tag-id]")?.dataset.tagId;
          if (!tagId) return;
          await LibraryStore.deleteUserTag(scope, tagId);
          ui.notifications.info(t("TagDeleted"));
          render(body.querySelector("[data-tag-search]")?.value ?? "");
        });
      }
      if (focusSearch) focusInput(body.querySelector("[data-tag-search]"));
    };

    render();
    return close;
  }

  openEntryTagDialog(scope, entryId, entryName) {
    if (!game.user.isGM) return;
    const tagLabels = labels();
    const { body, close } = this.createTagDialog(`${tagLabels.Tags}: ${entryName}`, "ddb-tag-assignment");
    const selected = new Set(LibraryStore.getEntryTagIds(scope, entryId));

    const render = (search = "", focusSearch = false) => {
      const tags = LibraryStore.getUserTags(scope);
      const query = search.trim().toLowerCase();
      const visibleTags = tags.filter((tag) => !query || tag.name.toLowerCase().includes(query));
      body.innerHTML = `
        <input type="search" data-tag-search value="${escapeAttribute(search)}" placeholder="${escapeAttribute(tagLabels.SearchTags)}">
        <div class="ddb-tag-list ddb-tag-list--assign">
          ${visibleTags.length ? visibleTags.map((tag) => `
            <label class="ddb-tag-check ${isServiceTag(tag) ? "is-service" : ""}">
              <input type="checkbox" data-tag-check="${escapeAttribute(tag.id)}" ${selected.has(tag.id) ? "checked" : ""} ${isServiceTag(tag) ? "disabled" : ""}>
              <span>${escapeHtml(tag.name)}</span>
            </label>
          `).join("") : `<p class="ddb-tag-empty">${escapeHtml(tagLabels.NoTags)}</p>`}
        </div>
        <footer class="ddb-tag-actions">
          <button type="button" data-close-tags>${escapeHtml(tagLabels.Cancel)}</button>
          <button type="button" data-save-tags>${escapeHtml(tagLabels.Save)}</button>
        </footer>
      `;

      body.querySelector("[data-tag-search]")?.addEventListener("input", (event) => render(event.currentTarget.value, true));
      for (const checkbox of body.querySelectorAll("[data-tag-check]")) {
        checkbox.addEventListener("change", (event) => {
          const tagId = event.currentTarget.dataset.tagCheck;
          if (event.currentTarget.checked) selected.add(tagId);
          else selected.delete(tagId);
        });
      }
      body.querySelector("[data-close-tags]")?.addEventListener("click", close);
      body.querySelector("[data-save-tags]")?.addEventListener("click", async () => {
        await LibraryStore.setEntryTagIds(scope, entryId, Array.from(selected));
        ui.notifications.info(t("TagsSaved"));
        close();
        if (scope === "asset") {
          this.updateTagFilterButton();
          this.refreshGrid();
        }
      });
      if (focusSearch) focusInput(body.querySelector("[data-tag-search]"));
    };

    render();
  }

  openAssetTagFilterDialog() {
    const tagLabels = labels();
    const { body, close } = this.createTagDialog(tagLabels.FilterTags, "ddb-tag-filter");
    const selected = new Set(this.selectedAssetTagFilters);

    const render = (search = "", focusSearch = false) => {
      const tags = LibraryStore.getUserTags("asset");
      const query = search.trim().toLowerCase();
      const visibleTags = tags.filter((tag) => !query || tag.name.toLowerCase().includes(query));

      body.innerHTML = `
        <input type="search" data-tag-search value="${escapeAttribute(search)}" placeholder="${escapeAttribute(tagLabels.SearchTags)}">
        <div class="ddb-tag-list ddb-tag-list--assign">
          ${visibleTags.length ? visibleTags.map((tag) => `
            <label class="ddb-tag-check ${isServiceTag(tag) ? "is-service" : ""}">
              <input type="checkbox" data-tag-filter="${escapeAttribute(tag.id)}" ${selected.has(tag.id) ? "checked" : ""}>
              <span>${escapeHtml(tag.name)}</span>
            </label>
          `).join("") : `<p class="ddb-tag-empty">${escapeHtml(tagLabels.NoTags)}</p>`}
        </div>
        <footer class="ddb-tag-actions">
          <button type="button" data-clear-tag-filters>${escapeHtml(tagLabels.ClearAll)}</button>
          <button type="button" data-close-tags>${escapeHtml(tagLabels.Cancel)}</button>
          <button type="button" data-apply-tag-filters>${escapeHtml(tagLabels.ApplyFilters)}</button>
        </footer>
      `;

      body.querySelector("[data-tag-search]")?.addEventListener("input", (event) => render(event.currentTarget.value, true));
      for (const checkbox of body.querySelectorAll("[data-tag-filter]")) {
        checkbox.addEventListener("change", (event) => {
          const tagId = event.currentTarget.dataset.tagFilter;
          if (event.currentTarget.checked) selected.add(tagId);
          else selected.delete(tagId);
        });
      }
      body.querySelector("[data-clear-tag-filters]")?.addEventListener("click", () => {
        selected.clear();
        for (const checkbox of body.querySelectorAll("[data-tag-filter]")) checkbox.checked = false;
      });
      body.querySelector("[data-close-tags]")?.addEventListener("click", close);
      body.querySelector("[data-apply-tag-filters]")?.addEventListener("click", async () => {
        this.selectedAssetTagFilters = selected;
        close();
        this.updateTagFilterButton();
        this.refreshGrid();
      });
      if (focusSearch) focusInput(body.querySelector("[data-tag-search]"));
    };

    render();
  }

  openPackManager() {
    if (!game.user.isGM) return;
    const tagLabels = labels();
    const { body, close } = this.createTagDialog(tagLabels.PackManager, "ddb-pack-manager");
    const visiblePackIds = new Set(Object.values(LibraryStore.library.packs).filter((pack) => pack.hidden !== true).map((pack) => pack.id));

    const render = (search = "", focusSearch = false) => {
      const library = LibraryStore.library;
      const query = search.trim().toLowerCase();
      const packs = Object.values(library.packs)
        .filter((pack) => {
          if (!query) return true;
          const haystack = `${pack.name} ${pack.author} ${pack.sourceId ?? ""}`.toLowerCase();
          return haystack.includes(query);
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      body.innerHTML = `
        <div class="ddb-pack-manager-tools">
          <input type="search" data-pack-manager-search value="${escapeAttribute(search)}" placeholder="${escapeAttribute(tagLabels.SearchPacks)}">
          <button type="button" data-show-visible-packs>${escapeHtml(tagLabels.ShowAll)}</button>
          <button type="button" data-hide-visible-packs>${escapeHtml(tagLabels.HideAll)}</button>
        </div>
        <div class="ddb-pack-manager-list">
          ${packs.length ? packs.map((pack) => `
            <label class="ddb-pack-manager-row ${visiblePackIds.has(pack.id) ? "" : "is-hidden"}">
              <input type="checkbox" data-pack-visible="${escapeAttribute(pack.id)}" ${visiblePackIds.has(pack.id) ? "checked" : ""}>
              <span>
                <strong>${escapeHtml(pack.name)}</strong>
                <small>${escapeHtml(pack.author || tagLabels.Author)} - ${escapeHtml(pack.assetCount ?? 0)}</small>
              </span>
            </label>
          `).join("") : `<p class="ddb-tag-empty">${escapeHtml(tagLabels.NoTiles)}</p>`}
        </div>
        <footer class="ddb-tag-actions">
          <button type="button" data-close-tags>${escapeHtml(tagLabels.Cancel)}</button>
          <button type="button" data-save-pack-manager>${escapeHtml(tagLabels.Save)}</button>
        </footer>
      `;

      body.querySelector("[data-pack-manager-search]")?.addEventListener("input", (event) => render(event.currentTarget.value, true));
      for (const checkbox of body.querySelectorAll("[data-pack-visible]")) {
        checkbox.addEventListener("change", (event) => {
          const packId = event.currentTarget.dataset.packVisible;
          if (event.currentTarget.checked) visiblePackIds.add(packId);
          else visiblePackIds.delete(packId);
          event.currentTarget.closest(".ddb-pack-manager-row")?.classList.toggle("is-hidden", !event.currentTarget.checked);
        });
      }
      body.querySelector("[data-show-visible-packs]")?.addEventListener("click", () => {
        for (const pack of packs) visiblePackIds.add(pack.id);
        updatePackManagerChecks(body, visiblePackIds);
      });
      body.querySelector("[data-hide-visible-packs]")?.addEventListener("click", () => {
        for (const pack of packs) visiblePackIds.delete(pack.id);
        updatePackManagerChecks(body, visiblePackIds);
      });
      body.querySelector("[data-close-tags]")?.addEventListener("click", close);
      body.querySelector("[data-save-pack-manager]")?.addEventListener("click", async () => {
        const allPackIds = Object.keys(LibraryStore.library.packs);
        const hiddenPackIds = allPackIds.filter((packId) => !visiblePackIds.has(packId));
        const shownPackIds = allPackIds.filter((packId) => visiblePackIds.has(packId));
        await LibraryStore.setPacksHidden(hiddenPackIds, true);
        await LibraryStore.setPacksHidden(shownPackIds, false);
        ui.notifications.info(t("PackManagerSaved"));
        close();
        await this.renderPreservingScroll();
      });
      if (focusSearch) focusInput(body.querySelector("[data-pack-manager-search]"));
    };

    render();
  }

  openEntrySettingsDialog(scope, entryId) {
    if (!game.user.isGM) return;

    const library = LibraryStore.library;
    const entry = scope === "pack" ? library.packs[entryId] : library.assets[entryId];
    if (!entry) return;

    const tagLabels = labels();
    const selected = new Set(LibraryStore.getEntryTagIds(scope, entryId));
    const { body, close } = this.createTagDialog(`${tagLabels.EntrySettings}: ${entry.name}`, "ddb-entry-settings");

    const renderTags = (search = "", focusSearch = false) => {
      const tags = LibraryStore.getUserTags(scope);
      const query = search.trim().toLowerCase();
      const visibleTags = tags.filter((tag) => !query || tag.name.toLowerCase().includes(query));
      const currentName = body.querySelector("[name='entryName']")?.value ?? entry.name;
      const currentAuthor = body.querySelector("[name='entryAuthor']")?.value ?? entry.author ?? "";

      body.innerHTML = `
        <form class="ddb-entry-settings-form" data-entry-settings-form>
          <label class="ddb-form-row">
            <span>${escapeHtml(tagLabels.Name)}</span>
            <input type="text" name="entryName" value="${escapeAttribute(currentName)}" maxlength="120" required>
          </label>
          <label class="ddb-form-row">
            <span>${escapeHtml(tagLabels.Author)}</span>
            <input type="text" name="entryAuthor" value="${escapeAttribute(currentAuthor)}" maxlength="120">
          </label>
          <label class="ddb-form-row">
            <span>${escapeHtml(tagLabels.Tags)}</span>
            <input type="search" data-tag-search value="${escapeAttribute(search)}" placeholder="${escapeAttribute(tagLabels.SearchTags)}">
          </label>
          <div class="ddb-tag-list ddb-tag-list--assign">
            ${visibleTags.length ? visibleTags.map((tag) => `
              <label class="ddb-tag-check ${isServiceTag(tag) ? "is-service" : ""}">
                <input type="checkbox" data-tag-check="${escapeAttribute(tag.id)}" ${selected.has(tag.id) ? "checked" : ""} ${isServiceTag(tag) ? "disabled" : ""}>
                <span>${escapeHtml(tag.name)}</span>
              </label>
            `).join("") : `<p class="ddb-tag-empty">${escapeHtml(tagLabels.NoTags)}</p>`}
          </div>
          <footer class="ddb-tag-actions">
            <button type="button" data-close-tags>${escapeHtml(tagLabels.Cancel)}</button>
            <button type="submit">${escapeHtml(tagLabels.Save)}</button>
          </footer>
        </form>
      `;

      body.querySelector("[data-tag-search]")?.addEventListener("input", (event) => renderTags(event.currentTarget.value, true));
      for (const checkbox of body.querySelectorAll("[data-tag-check]")) {
        checkbox.addEventListener("change", (event) => {
          const tagId = event.currentTarget.dataset.tagCheck;
          if (event.currentTarget.checked) selected.add(tagId);
          else selected.delete(tagId);
        });
      }
      body.querySelector("[data-close-tags]")?.addEventListener("click", close);
      body.querySelector("[data-entry-settings-form]")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        await LibraryStore.updateEntryMetadata(scope, entryId, {
          name: data.get("entryName"),
          author: data.get("entryAuthor")
        });
        await LibraryStore.setEntryTagIds(scope, entryId, Array.from(selected));
        ui.notifications.info(t("EntrySettingsSaved"));
        close();
        await this.renderPreservingScroll();
      });
      if (focusSearch) focusInput(body.querySelector("[data-tag-search]"));
    };

    renderTags();
  }

  openBulkAssetTagDialog() {
    if (!game.user.isGM) return;
    const tagLabels = labels();
    const { body, close } = this.createTagDialog(tagLabels.BulkAssignTags, "ddb-tag-bulk");
    const selectedTags = new Set();
    const selectedAssets = new Set();

    const render = (tagSearch = "", assetSearch = "", focusTarget = "") => {
      const library = LibraryStore.library;
      const tags = LibraryStore.getUserTags("asset");
      const tagQuery = tagSearch.trim().toLowerCase();
      const assetQuery = assetSearch.trim().toLowerCase();
      const visibleTags = tags.filter((tag) => !tagQuery || tag.name.toLowerCase().includes(tagQuery));
      const visibleAssets = Object.values(library.assets)
        .map((asset) => ({
          ...asset,
          packName: library.packs[asset.packId]?.name ?? asset.packId
        }))
        .filter((asset) => {
          if (!assetQuery) return true;
          const haystack = `${asset.name} ${asset.author} ${asset.packName}`.toLowerCase();
          return haystack.includes(assetQuery);
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      body.innerHTML = `
        <div class="ddb-bulk-grid">
          <section>
            <h3>${escapeHtml(tagLabels.SelectTags)}</h3>
            <input type="search" data-bulk-tag-search value="${escapeAttribute(tagSearch)}" placeholder="${escapeAttribute(tagLabels.SearchTags)}">
            <div class="ddb-tag-list ddb-tag-list--assign">
              ${visibleTags.length ? visibleTags.map((tag) => `
                <label class="ddb-tag-check ${isServiceTag(tag) ? "is-service" : ""}">
                  <input type="checkbox" data-bulk-tag="${escapeAttribute(tag.id)}" ${selectedTags.has(tag.id) ? "checked" : ""} ${isServiceTag(tag) ? "disabled" : ""}>
                  <span>${escapeHtml(tag.name)}</span>
                </label>
              `).join("") : `<p class="ddb-tag-empty">${escapeHtml(tagLabels.NoTags)}</p>`}
            </div>
          </section>
          <section class="ddb-bulk-asset-section">
            <h3>${escapeHtml(tagLabels.SelectAssets)}</h3>
            <input type="search" data-bulk-asset-search value="${escapeAttribute(assetSearch)}" placeholder="${escapeAttribute(tagLabels.SearchAssets)}">
            <div class="ddb-bulk-selection-actions">
              <button type="button" data-select-visible-assets>${escapeHtml(tagLabels.SelectAll)}</button>
              <button type="button" data-clear-visible-assets>${escapeHtml(tagLabels.ClearAll)}</button>
            </div>
            <div class="ddb-asset-check-list">
              ${visibleAssets.map((asset) => `
                <label class="ddb-asset-check">
                  <input type="checkbox" data-bulk-asset="${escapeAttribute(asset.id)}" ${selectedAssets.has(asset.id) ? "checked" : ""}>
                  <span class="ddb-asset-check__thumb">
                    <img src="${escapeAttribute(asset.thumbSrc || asset.src)}" alt="" loading="lazy">
                  </span>
                  <span class="ddb-asset-check__meta">
                    <strong>${escapeHtml(asset.name)}</strong>
                    <small>${escapeHtml(asset.packName)}</small>
                  </span>
                </label>
              `).join("")}
            </div>
          </section>
        </div>
        <footer class="ddb-tag-actions">
          <button type="button" data-close-tags>${escapeHtml(tagLabels.Cancel)}</button>
          <button type="button" data-apply-tags>${escapeHtml(tagLabels.ApplyTags)}</button>
        </footer>
      `;

      body.querySelector("[data-bulk-tag-search]")?.addEventListener("input", (event) => render(event.currentTarget.value, assetSearch, "tag"));
      body.querySelector("[data-bulk-asset-search]")?.addEventListener("input", (event) => render(tagSearch, event.currentTarget.value, "asset"));
      for (const checkbox of body.querySelectorAll("[data-bulk-tag]")) {
        checkbox.addEventListener("change", (event) => {
          const tagId = event.currentTarget.dataset.bulkTag;
          if (event.currentTarget.checked) selectedTags.add(tagId);
          else selectedTags.delete(tagId);
        });
      }
      for (const checkbox of body.querySelectorAll("[data-bulk-asset]")) {
        checkbox.addEventListener("change", (event) => {
          const assetId = event.currentTarget.dataset.bulkAsset;
          if (event.currentTarget.checked) selectedAssets.add(assetId);
          else selectedAssets.delete(assetId);
        });
      }
      body.querySelector("[data-select-visible-assets]")?.addEventListener("click", () => {
        for (const asset of visibleAssets) selectedAssets.add(asset.id);
        updateAssetChecks(body, "[data-bulk-asset]", selectedAssets, "bulkAsset");
      });
      body.querySelector("[data-clear-visible-assets]")?.addEventListener("click", () => {
        for (const asset of visibleAssets) selectedAssets.delete(asset.id);
        updateAssetChecks(body, "[data-bulk-asset]", selectedAssets, "bulkAsset");
      });
      body.querySelector("[data-close-tags]")?.addEventListener("click", close);
      body.querySelector("[data-apply-tags]")?.addEventListener("click", async () => {
        if (!selectedTags.size) {
          ui.notifications.warn(t("NoTagsSelected"));
          return;
        }
        if (!selectedAssets.size) {
          ui.notifications.warn(t("NoAssetsSelected"));
          return;
        }
        const changed = await LibraryStore.addTagsToAssets(Array.from(selectedAssets), Array.from(selectedTags));
        ui.notifications.info(formatLabel("AssetsTagged", { count: changed }));
        close();
        this.updateTagFilterButton();
        this.refreshGrid();
      });
      if (focusTarget === "tag") focusInput(body.querySelector("[data-bulk-tag-search]"));
      if (focusTarget === "asset") focusInput(body.querySelector("[data-bulk-asset-search]"));
    };

    render();
  }

  openAssetManager() {
    if (!game.user.isGM) return;
    const tagLabels = labels();
    const { body, close } = this.createTagDialog(tagLabels.AssetManager, "ddb-asset-manager");
    const selectedAssets = new Set();
    const gap = 8;
    const itemWidth = 150;
    const rowHeight = 166;
    let assetSearch = "";
    let allAssets = [];
    let visibleAssets = [];
    let renderFrame = null;

    const rebuildAssetSource = () => {
      const library = LibraryStore.library;
      allAssets = Object.values(library.assets)
        .map((asset) => ({
          ...asset,
          packName: library.packs[asset.packId]?.name ?? asset.packId
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    };

    const updateVisibleAssets = () => {
      const assetQuery = assetSearch.trim().toLowerCase();
      visibleAssets = allAssets.filter((asset) => {
        if (!assetQuery) return true;
        const haystack = `${asset.name} ${asset.author} ${asset.packName}`.toLowerCase();
        return haystack.includes(assetQuery);
      });

      const count = body.querySelector("[data-asset-manager-count]");
      if (count) count.textContent = `${visibleAssets.length} / ${allAssets.length}`;
    };

    const renderVisibleAssets = () => {
      renderFrame = null;
      const viewport = body.querySelector("[data-asset-manager-viewport]");
      const canvas = body.querySelector("[data-asset-manager-canvas]");
      const empty = body.querySelector("[data-asset-manager-empty]");
      if (!viewport || !canvas) return;

      const columns = Math.max(1, Math.floor((viewport.clientWidth + gap) / (itemWidth + gap)));
      const totalRows = Math.ceil(visibleAssets.length / columns);
      const maxScroll = Math.max(0, totalRows * rowHeight - viewport.clientHeight);
      if (viewport.scrollTop > maxScroll) viewport.scrollTop = maxScroll;

      const firstRow = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 2);
      const lastRow = Math.min(totalRows, Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight) + 2);
      const firstIndex = firstRow * columns;
      const lastIndex = Math.min(visibleAssets.length, lastRow * columns);

      viewport.classList.toggle("is-empty", visibleAssets.length === 0);
      canvas.style.height = visibleAssets.length ? `${totalRows * rowHeight}px` : "0px";
      canvas.innerHTML = "";

      for (let index = firstIndex; index < lastIndex; index += 1) {
        const asset = visibleAssets[index];
        const column = index % columns;
        const row = Math.floor(index / columns);
        canvas.appendChild(createAssetManagerCard(asset, {
          x: column * (itemWidth + gap),
          y: row * rowHeight,
          width: itemWidth,
          height: rowHeight - 8,
          selected: selectedAssets.has(asset.id),
          onChange: (checked) => {
            if (checked) selectedAssets.add(asset.id);
            else selectedAssets.delete(asset.id);
          }
        }));
      }

      if (empty) empty.hidden = visibleAssets.length > 0;
    };

    const scheduleVisibleRender = () => {
      if (renderFrame !== null) cancelAnimationFrame(renderFrame);
      renderFrame = requestAnimationFrame(renderVisibleAssets);
    };

    const refreshManager = ({ resetScroll = false } = {}) => {
      updateVisibleAssets();
      const viewport = body.querySelector("[data-asset-manager-viewport]");
      if (resetScroll && viewport) viewport.scrollTop = 0;
      scheduleVisibleRender();
    };

    rebuildAssetSource();
    body.innerHTML = `
      <div class="ddb-asset-manager-tools">
        <input type="search" data-asset-manager-search value="" placeholder="${escapeAttribute(tagLabels.SearchAssets)}">
        <span class="ddb-asset-manager-count" data-asset-manager-count></span>
        <button type="button" data-select-visible-assets>${escapeHtml(tagLabels.SelectAll)}</button>
        <button type="button" data-clear-visible-assets>${escapeHtml(tagLabels.ClearAll)}</button>
      </div>
      <div class="ddb-asset-manager-viewport" data-asset-manager-viewport>
        <div class="ddb-asset-manager-canvas" data-asset-manager-canvas></div>
        <p class="ddb-tag-empty ddb-asset-manager-empty" data-asset-manager-empty hidden>${escapeHtml(tagLabels.NoTiles)}</p>
      </div>
      <footer class="ddb-tag-actions">
        <button type="button" data-close-tags>${escapeHtml(tagLabels.Cancel)}</button>
        <button type="button" class="ddb-danger-button" data-delete-selected-assets>
          <i class="fa-solid fa-trash-can"></i>
          <span>${escapeHtml(tagLabels.DeleteSelectedAssets)}</span>
        </button>
      </footer>
    `;

    body.querySelector("[data-asset-manager-search]")?.addEventListener("input", (event) => {
      assetSearch = event.currentTarget.value;
      refreshManager({ resetScroll: true });
    });
    body.querySelector("[data-asset-manager-viewport]")?.addEventListener("scroll", scheduleVisibleRender);
    body.querySelector("[data-select-visible-assets]")?.addEventListener("click", () => {
      for (const asset of visibleAssets) selectedAssets.add(asset.id);
      scheduleVisibleRender();
    });
    body.querySelector("[data-clear-visible-assets]")?.addEventListener("click", () => {
      for (const asset of visibleAssets) selectedAssets.delete(asset.id);
      scheduleVisibleRender();
    });
    body.querySelector("[data-close-tags]")?.addEventListener("click", () => {
      if (renderFrame !== null) cancelAnimationFrame(renderFrame);
      close();
    });
    body.querySelector("[data-delete-selected-assets]")?.addEventListener("click", async () => {
      if (!selectedAssets.size) {
        ui.notifications.warn(t("NoAssetsSelected"));
        return;
      }

      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: t("DeleteSelectedAssets") },
        content: `<p>${formatLabel("DeleteSelectedAssetsConfirm", { count: selectedAssets.size })}</p>`,
        modal: true
      });
      if (!confirmed) return;

      const viewport = body.querySelector("[data-asset-manager-viewport]");
      const listScroll = viewport?.scrollTop ?? 0;
      const removed = await LibraryStore.removeAssets(Array.from(selectedAssets));
      selectedAssets.clear();
      ui.notifications.info(formatLabel("SelectedAssetsDeleted", { count: removed.length }));
      await this.renderPreservingScroll();
      rebuildAssetSource();
      refreshManager();
      if (viewport) viewport.scrollTop = Math.max(0, listScroll);
    });

    refreshManager();
    focusInput(body.querySelector("[data-asset-manager-search]"));
  }

  createTagDialog(title, className) {
    this.closeTagDialog();

    const overlay = document.createElement("div");
    overlay.className = `ddb-tag-overlay ${className}`;
    overlay.innerHTML = `
      <section class="ddb-tag-window">
        <header class="ddb-tag-header">
          <h2>${escapeHtml(title)}</h2>
          <button type="button" class="ddb-icon-button" data-close-tag-dialog>
            <i class="fa-solid fa-xmark"></i>
          </button>
        </header>
        <div class="ddb-tag-body"></div>
      </section>
    `;

    const close = () => this.closeTagDialog();
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) close();
    });
    overlay.querySelector("[data-close-tag-dialog]")?.addEventListener("click", close);
    document.body.append(overlay);
    this.tagDialog = overlay;
    return {
      body: overlay.querySelector(".ddb-tag-body"),
      close
    };
  }

  closeTagDialog() {
    this.tagDialog?.remove();
    this.tagDialog = null;
  }

  constrainContextMenu(menu) {
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(rect.left, window.innerWidth - rect.width - margin);
    const top = Math.min(rect.top, window.innerHeight - rect.height - margin);
    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
  }

  closeContextMenu() {
    this.contextMenu?.remove();
    this.contextMenu = null;
    document.removeEventListener("pointerdown", this.boundCloseContextMenu);
    document.removeEventListener("keydown", this.boundCloseContextMenu);
    window.removeEventListener("blur", this.boundCloseContextMenu);
  }

  async deleteAsset(assetId) {
    if (!game.user.isGM) {
      ui.notifications.warn(t("GMOnlyDelete"));
      this.closeContextMenu();
      return;
    }

    const asset = LibraryStore.library.assets[assetId];
    if (!asset) {
      this.closeContextMenu();
      return;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("DeleteAsset") },
      content: `<p>${formatLabel("DeleteAssetConfirm", { name: asset.name })}</p>`,
      modal: true
    });
    if (!confirmed) {
      this.closeContextMenu();
      return;
    }

    try {
      await LibraryStore.removeAsset(assetId);
      this.closeContextMenu();
      ui.notifications.info(formatLabel("AssetDeleted", { name: asset.name }));
      await this.renderPreservingScroll();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not remove asset`, error);
      ui.notifications.error(error.message || String(error));
    }
  }

  async deletePack(packId) {
    if (!game.user.isGM) {
      ui.notifications.warn(t("GMOnlyDelete"));
      this.closeContextMenu();
      return;
    }

    const pack = LibraryStore.library.packs[packId];
    if (!pack) {
      this.closeContextMenu();
      return;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("DeletePack") },
      content: `<p>${formatLabel("DeletePackConfirm", { name: pack.name })}</p>`,
      modal: true
    });
    if (!confirmed) {
      this.closeContextMenu();
      return;
    }

    try {
      await LibraryStore.removePack(packId);
      this.closeContextMenu();
      ui.notifications.info(formatLabel("PackDeleted", { name: pack.name }));
      await this.renderPreservingScroll();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not remove pack`, error);
      ui.notifications.error(error.message || String(error));
    }
  }

  async selectAsset(asset) {
    try {
      const color = asset.colorable ? this.color : null;
      const src = await LibraryStore.resolveAssetSource(asset, color);
      await TilePlacer.start(asset, {
        src,
        color,
        snapToGrid: this.snapToGrid,
        lockPlacedTiles: this.lockPlacedTiles,
        mapDpi: this.mapDpi
      });
    } catch (error) {
      console.error(`${MODULE_ID} | Could not start tile placement`, error);
      ui.notifications.error(error.message || String(error));
    }
  }

  applyPlacementOptions() {
    TilePlacer.updateOptions({
      snapToGrid: this.snapToGrid,
      lockPlacedTiles: this.lockPlacedTiles,
      mapDpi: this.mapDpi
    });
  }

  updateColorableState() {
    const colorControl = this.element.querySelector("[data-color-control]");
    if (!colorControl) return;
    colorControl.hidden = !this.visibleAssets.some((asset) => asset.colorable);
  }

  setStatus(message) {
    const status = this.element?.querySelector("[data-status]");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  }
}

function updatePackManagerChecks(root, visiblePackIds) {
  for (const checkbox of root.querySelectorAll("[data-pack-visible]")) {
    const checked = visiblePackIds.has(checkbox.dataset.packVisible);
    checkbox.checked = checked;
    checkbox.closest(".ddb-pack-manager-row")?.classList.toggle("is-hidden", !checked);
  }
}

function createAssetManagerCard(asset, { x, y, width, height, selected, onChange }) {
  const card = document.createElement("label");
  card.className = "ddb-asset-check ddb-asset-manager-card";
  card.style.width = `${width}px`;
  card.style.height = `${height}px`;
  card.style.transform = `translate(${x}px, ${y}px)`;
  card.title = asset.name;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.managerAsset = asset.id;
  checkbox.checked = selected;
  checkbox.addEventListener("change", (event) => onChange(event.currentTarget.checked));

  const thumb = document.createElement("span");
  thumb.className = "ddb-asset-check__thumb";

  const image = document.createElement("img");
  image.src = asset.thumbSrc || asset.src;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  thumb.append(image);

  const meta = document.createElement("span");
  meta.className = "ddb-asset-check__meta";

  const name = document.createElement("strong");
  name.textContent = asset.name;

  const pack = document.createElement("small");
  pack.textContent = asset.packName;

  meta.append(name, pack);
  card.append(checkbox, thumb, meta);
  return card;
}

function updateAssetChecks(root, selector, selectedAssets, datasetKey) {
  for (const checkbox of root.querySelectorAll(selector)) {
    checkbox.checked = selectedAssets.has(checkbox.dataset[datasetKey]);
  }
}

async function collectDroppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer.items ?? []);
  const transferFiles = Array.from(dataTransfer.files ?? []);
  if (items.length && items.some((item) => typeof item.webkitGetAsEntry === "function")) {
    const files = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (!entry) continue;
      files.push(...await readEntryFiles(entry, ""));
    }

    const seen = new Set(files.map(fileDropKey));
    for (const file of transferFiles) {
      const key = fileDropKey(file);
      if (!seen.has(key)) files.push(file);
    }

    return files;
  }

  return transferFiles;
}

function fileDropKey(file) {
  return `${file.name}:${file.size}:${file.lastModified ?? 0}`;
}

async function readEntryFiles(entry, parentPath) {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await entryFile(entry);
    assignRelativePath(file, path);
    return [file];
  }

  if (!entry.isDirectory) return [];

  const reader = entry.createReader();
  const children = await readAllDirectoryEntries(reader);
  const files = [];
  for (const child of children) {
    files.push(...await readEntryFiles(child, path));
  }
  return files;
}

function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function assignRelativePath(file, relativePath) {
  try {
    Object.defineProperty(file, "relativePath", {
      value: relativePath,
      configurable: true
    });
  } catch {
    file.relativePath = relativePath;
  }
}

function isImageFile(name) {
  return /\.(apng|avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i.test(name);
}

function normalizeMapDpi(value) {
  const dpi = Math.round(Number(value));
  return Number.isFinite(dpi) && dpi > 0 ? Math.min(dpi, 4096) : DEFAULT_MAP_DPI;
}

function formatLabel(key, replacements = {}) {
  let text = t(key);
  for (const [token, value] of Object.entries(replacements)) {
    text = text.replaceAll(`{${token}}`, escapeHtml(value));
  }
  return text;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function focusInput(input) {
  if (!input) return;
  input.focus();
  const length = input.value.length;
  input.setSelectionRange?.(length, length);
}

function isServiceTag(tag) {
  return String(tag?.name ?? "").trim().toLowerCase() === "colorable";
}

function getStoredPalette() {
  const palette = game.settings.get(MODULE_ID, "colorPalette") ?? {};
  return trimPalette({
    selected: normalizeHexColor(palette.selected ?? "#ffffff"),
    recent: normalizeColorList(palette.recent ?? ["#ffffff"]),
    favorites: normalizeColorList(palette.favorites ?? [])
  });
}

async function savePalette(palette) {
  await game.settings.set(MODULE_ID, "colorPalette", trimPalette(palette));
}

function rememberPaletteColor(palette, color) {
  const normalized = normalizeHexColor(color);
  if (palette.favorites.includes(normalized)) return palette;
  palette.recent = [
    normalized,
    ...palette.recent.filter((entry) => entry !== normalized)
  ];
  return trimPalette(palette);
}

function trimPalette(palette) {
  palette.selected = normalizeHexColor(palette.selected ?? "#ffffff");
  palette.favorites = normalizeColorList(palette.favorites);
  palette.recent = normalizeColorList(palette.recent)
    .filter((color) => !palette.favorites.includes(color))
    .slice(0, COLOR_LIMIT);
  if (!palette.favorites.length && !palette.recent.length) palette.recent = ["#ffffff"];
  return palette;
}

function getPaletteSwatches(palette, selectedColor) {
  const selected = normalizeHexColor(selectedColor);
  return [
    ...palette.favorites.map((color) => ({ color, favorite: true, selected: color === selected })),
    ...palette.recent
      .filter((color) => !palette.favorites.includes(color))
      .map((color) => ({ color, favorite: false, selected: color === selected }))
  ].slice(0, COLOR_LIMIT);
}

function normalizeColorList(colors = []) {
  return Array.from(new Set(
    colors
      .map((color) => normalizeHexColor(color))
      .filter(Boolean)
  ));
}

function normalizeHexColor(color) {
  const value = String(color || "#ffffff").trim().toLowerCase();
  const match = value.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toLowerCase()}` : "#ffffff";
}
