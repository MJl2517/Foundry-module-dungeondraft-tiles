import { LibraryStore, MODULE_ID } from "./library-store.js";
import { t } from "./i18n.js";
import { ModuleSettingsApp } from "./settings-app.js";
import { TileLibraryApp } from "./tile-library-app.js";
import { TilePlacer } from "./tile-placer.js";

Hooks.once("init", () => {
  LibraryStore.registerSettings();
  game.settings.registerMenu(MODULE_ID, "moduleSettings", {
    name: "DDBrowser.SettingsTitle",
    label: "DDBrowser.SettingsOpen",
    hint: "DDBrowser.SettingsHint",
    icon: "fas fa-cog",
    type: ModuleSettingsApp,
    restricted: false
  });
});

Hooks.once("ready", () => {
  if (game.user.isGM) {
    (async () => {
      await LibraryStore.migrateImportPathDefault();
      await LibraryStore.syncSharedLibraryIndex();
      await LibraryStore.migrateImportedTags();
    })().catch((error) => {
      console.warn(`${MODULE_ID} | Could not prepare shared library`, error);
    });
  }
});

Hooks.on("getSceneControlButtons", (controls) => {
  const tilesControl = findTilesControl(controls);
  if (!tilesControl) return;

  const tool = {
    name: MODULE_ID,
    title: t("OpenLibrary"),
    icon: "fa-solid fa-layer-group",
    button: true,
    visible: true,
    onClick: () => TileLibraryApp.open(),
    onChange: () => TileLibraryApp.open()
  };

  if (Array.isArray(tilesControl.tools)) {
    if (!tilesControl.tools.some((existing) => existing.name === MODULE_ID)) tilesControl.tools.push(tool);
    return;
  }

  if (tilesControl.tools instanceof Map && !tilesControl.tools.has(MODULE_ID)) {
    tilesControl.tools.set(MODULE_ID, tool);
    return;
  }

  if (tilesControl.tools && typeof tilesControl.tools === "object" && !tilesControl.tools[MODULE_ID]) {
    tilesControl.tools[MODULE_ID] = tool;
  }
});

Hooks.on("canvasTearDown", () => {
  TilePlacer.cancel();
});

function findTilesControl(controls) {
  if (Array.isArray(controls)) return controls.find((control) => control.name === "tiles");
  if (controls instanceof Map) return controls.get("tiles");
  return controls?.tiles;
}
