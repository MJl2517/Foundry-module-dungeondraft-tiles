import { DEFAULT_IMPORT_PATH, LibraryStore, MODULE_ID, MODULE_PATH } from "./library-store.js";
import { labels, t } from "./i18n.js";
import { TileLibraryApp } from "./tile-library-app.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export const THUMBNAIL_PRESETS = {
  small: 120,
  medium: 160,
  big: 220
};

export class ModuleSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-settings`,
    classes: [MODULE_ID, "ddb-settings"],
    window: {
      title: "DDBrowser.SettingsTitle",
      icon: "fa-solid fa-gear",
      resizable: false
    },
    position: {
      width: 560,
      height: "auto"
    }
  };

  static PARTS = {
    main: {
      template: `${MODULE_PATH}/templates/settings.hbs`
    }
  };

  async _prepareContext(options) {
    const thumbnailSize = Number(game.settings.get(MODULE_ID, "thumbnailSize")) || THUMBNAIL_PRESETS.medium;
    const language = game.settings.get(MODULE_ID, "language");
    const thumbnailPreset = presetFromSize(thumbnailSize);
    return {
      ...(await super._prepareContext(options)),
      labels: labels(),
      canEditWorldSettings: game.user.isGM,
      languageOptions: [
        { value: "ru", label: labels().Russian, selected: language === "ru" },
        { value: "en", label: labels().English, selected: language === "en" }
      ],
      thumbnailOptions: [
        { value: "small", label: labels().Small, selected: thumbnailPreset === "small" },
        { value: "medium", label: labels().Medium, selected: thumbnailPreset === "medium" },
        { value: "big", label: labels().Big, selected: thumbnailPreset === "big" }
      ],
      values: {
        language,
        importPath: game.settings.get(MODULE_ID, "importPath") || DEFAULT_IMPORT_PATH,
        thumbnailPreset,
        optimizedMode: Boolean(game.settings.get(MODULE_ID, "optimizedMode")),
        rotationStep: Number(game.settings.get(MODULE_ID, "rotationStep")) || 15,
        scaleStep: Number(game.settings.get(MODULE_ID, "scaleStep")) || 0.1
      }
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    root.querySelector("[data-settings-form]")?.addEventListener("submit", (event) => this.onSubmit(event));
    root.querySelector("[data-browse-import-path]")?.addEventListener("click", () => this.browseImportPath());
    root.querySelector("[data-reset-settings]")?.addEventListener("click", () => this.resetDefaults());
    root.querySelector("[data-rebuild-library]")?.addEventListener("click", () => this.rebuildLibrary());
    root.querySelector("[data-generate-thumbnails]")?.addEventListener("click", (event) => this.generateThumbnails(event.currentTarget));
    root.querySelector("[data-delete-module-tiles]")?.addEventListener("click", () => this.deleteModuleTiles());
    root.querySelector("[data-delete-all-module-data]")?.addEventListener("click", () => this.deleteAllModuleData());

    for (const slider of root.querySelectorAll("[data-setting-slider]")) {
      slider.addEventListener("input", (event) => {
        const output = root.querySelector(`[data-slider-output="${event.currentTarget.name}"]`);
        if (output) output.value = event.currentTarget.value;
      });
    }
  }

  async onSubmit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const language = data.get("language") === "en" ? "en" : "ru";
    const thumbnailPreset = data.get("thumbnailPreset");
    const optimizedMode = data.get("optimizedMode") === "on";
    const rotationStep = clampNumber(Number(data.get("rotationStep")), 1, 90, 15);
    const scaleStep = clampNumber(Number(data.get("scaleStep")), 0.05, 1, 0.1);

    await game.settings.set(MODULE_ID, "language", language);
    await game.settings.set(MODULE_ID, "thumbnailSize", THUMBNAIL_PRESETS[thumbnailPreset] ?? THUMBNAIL_PRESETS.medium);
    await game.settings.set(MODULE_ID, "optimizedMode", optimizedMode);
    await game.settings.set(MODULE_ID, "rotationStep", rotationStep);
    await game.settings.set(MODULE_ID, "scaleStep", scaleStep);

    if (game.user.isGM) {
      const importPath = sanitizePath(data.get("importPath") || DEFAULT_IMPORT_PATH);
      await game.settings.set(MODULE_ID, "importPath", importPath);
    }

    ui.notifications.info(t("SettingsSaved"));
    await TileLibraryApp.instance?.renderPreservingScroll();
  }

  browseImportPath() {
    if (!game.user.isGM) return;
    const input = this.element.querySelector("[name='importPath']");
    const current = input?.value || DEFAULT_IMPORT_PATH;
    const picker = new FilePicker({
      type: "folder",
      current,
      callback: (path) => {
        if (input) input.value = sanitizePath(path);
      }
    });
    picker.render(true);
  }

  async resetDefaults() {
    await game.settings.set(MODULE_ID, "language", "ru");
    await game.settings.set(MODULE_ID, "thumbnailSize", THUMBNAIL_PRESETS.medium);
    await game.settings.set(MODULE_ID, "optimizedMode", false);
    await game.settings.set(MODULE_ID, "rotationStep", 15);
    await game.settings.set(MODULE_ID, "scaleStep", 0.1);
    if (game.user.isGM) await game.settings.set(MODULE_ID, "importPath", DEFAULT_IMPORT_PATH);
    this.updateFormValues({
      language: "ru",
      thumbnailPreset: "medium",
      optimizedMode: false,
      importPath: DEFAULT_IMPORT_PATH,
      rotationStep: 15,
      scaleStep: 0.1
    });
    await TileLibraryApp.instance?.renderPreservingScroll();
  }

  updateFormValues(values) {
    const form = this.element?.querySelector("[data-settings-form]");
    if (!form) return;

    for (const [name, value] of Object.entries(values)) {
      const field = form.elements.namedItem(name);
      if (field?.type === "checkbox") field.checked = Boolean(value);
      else if (field) field.value = String(value);
      const output = form.querySelector(`[data-slider-output="${name}"]`);
      if (output) output.value = String(value);
    }
  }

  async rebuildLibrary() {
    if (!game.user.isGM) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("RebuildLibrary") },
      content: `<p>${formatLabel("RebuildLibraryConfirm", {
        path: game.settings.get(MODULE_ID, "importPath") || DEFAULT_IMPORT_PATH
      })}</p>`,
      modal: true
    });
    if (!confirmed) return;

    try {
      const result = await LibraryStore.rebuildLibraryFromFiles();
      if (!result.assets) {
        ui.notifications.warn(t("RebuildLibraryEmpty"));
        return;
      }

      await TileLibraryApp.instance?.renderPreservingScroll();
      ui.notifications.info(formatLabel("RebuildLibraryDone", {
        packs: result.packs,
        assets: result.assets
      }));
    } catch (error) {
      console.error(`${MODULE_ID} | Could not rebuild library from files`, error);
      ui.notifications.error(error.message || String(error));
    }
  }

  async generateThumbnails(button) {
    if (!game.user.isGM) return;

    button.disabled = true;
    ui.notifications.info(t("GenerateThumbnailsStarted"));
    try {
      const result = await LibraryStore.generateMissingThumbnails();
      if (!result.total) {
        ui.notifications.info(t("GenerateThumbnailsNone"));
        return;
      }

      await TileLibraryApp.instance?.renderPreservingScroll();
      ui.notifications.info(formatLabel("GenerateThumbnailsDone", {
        generated: result.generated,
        failed: result.failed,
        total: result.total
      }));
    } catch (error) {
      console.error(`${MODULE_ID} | Could not generate thumbnails`, error);
      ui.notifications.error(error.message || String(error));
    } finally {
      button.disabled = false;
    }
  }

  async deleteModuleTiles() {
    if (!game.user.isGM) return;

    const moduleTiles = getModuleTilesByScene();
    const total = moduleTiles.reduce((sum, { tileIds }) => sum + tileIds.length, 0);
    if (!total) {
      ui.notifications.warn(t("NoModuleTiles"));
      return;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("DeleteModuleTiles") },
      content: `<p>${formatLabel("DeleteModuleTilesConfirm", { count: total })}</p>`,
      modal: true
    });
    if (!confirmed) return;

    const deleted = await deleteSceneTiles(moduleTiles);

    ui.notifications.info(formatLabel("ModuleTilesDeleted", { count: deleted }));
  }

  async deleteAllModuleData() {
    if (!game.user.isGM) return;

    const library = LibraryStore.library;
    const moduleTiles = getModuleTilesByScene();
    const tileCount = moduleTiles.reduce((sum, { tileIds }) => sum + tileIds.length, 0);
    const packCount = Object.keys(library.packs).length;
    const assetCount = Object.keys(library.assets).length;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("DeleteAllModuleData") },
      content: `<p>${formatLabel("DeleteAllModuleDataConfirm", {
        tiles: tileCount,
        packs: packCount,
        assets: assetCount
      })}</p><p class="ddb-delete-warning">${t("ManualDeleteWarning")}</p>`,
      modal: true
    });
    if (!confirmed) return;

    const deletedTiles = await deleteSceneTiles(moduleTiles);
    const deletedLibrary = await LibraryStore.clearLibrary({ deleteFiles: true });
    await TileLibraryApp.instance?.renderPreservingScroll();

    ui.notifications.info(formatLabel("AllModuleDataDeleted", {
      tiles: deletedTiles,
      packs: deletedLibrary.packs,
      assets: deletedLibrary.assets,
      files: deletedLibrary.files
    }));
    if (!deletedLibrary.fileDeleteSupported) ui.notifications.warn(t("FileDeleteUnsupported"));
  }
}

function presetFromSize(size) {
  const entry = Object.entries(THUMBNAIL_PRESETS).find(([, value]) => value === size);
  return entry?.[0] ?? "medium";
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sanitizePath(path) {
  return String(path).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || DEFAULT_IMPORT_PATH;
}

function getModuleTilesByScene() {
  return Array.from(game.scenes ?? [])
    .map((scene) => ({
      scene,
      tileIds: Array.from(scene.tiles ?? [])
        .filter((tile) => isModuleTile(tile))
        .map((tile) => tile.id)
    }))
    .filter(({ tileIds }) => tileIds.length > 0);
}

async function deleteSceneTiles(moduleTiles) {
  let deleted = 0;
  for (const { scene, tileIds } of moduleTiles) {
    if (!tileIds.length) continue;
    await scene.deleteEmbeddedDocuments("Tile", tileIds);
    deleted += tileIds.length;
  }
  return deleted;
}

function isModuleTile(tile) {
  return Boolean(tile.getFlag?.(MODULE_ID, "assetId") || tile.flags?.[MODULE_ID]?.assetId);
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
