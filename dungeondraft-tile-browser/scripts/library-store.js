import { parseDungeondraftPack } from "./pck-reader.js";

export const MODULE_ID = "dungeondraft-tile-browser";
export const MODULE_PATH = `modules/${MODULE_ID}`;
export const LIBRARY_VERSION = 1;
export const DEFAULT_IMPORT_PATH = `assets/${MODULE_ID}`;

const DEFAULT_THUMBNAIL_SIZE = 160;
const DEFAULT_MAP_DPI = 256;
const SHARED_LIBRARY_INDEX_FILE = "library-index.json";
const SERVICE_TAG_NAMES = new Set(["colorable"]);
const COLOR_VARIANT_VERSION = 2;
const THUMBNAIL_MAX_SIZE = 256;
const THUMBNAIL_QUALITY = 0.76;
const OBJECT_SIZE_RE = /(?:^|[^0-9])([1-9][0-9]*)x([1-9][0-9]*)(?:[^0-9]|$)/i;
const IMAGE_FILE_RE = /\.(apng|avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i;

export class LibraryStore {
  static registerSettings() {
    game.settings.register(MODULE_ID, "language", {
      name: "DDBrowser.Language",
      scope: "client",
      config: false,
      type: String,
      choices: {
        ru: "DDBrowser.Russian",
        en: "DDBrowser.English"
      },
      default: "ru"
    });

    game.settings.register(MODULE_ID, "library", {
      scope: "world",
      config: false,
      type: Object,
      default: createEmptyLibrary()
    });

    game.settings.register(MODULE_ID, "importPath", {
      name: "DDBrowser.ImportPath",
      hint: "DDBrowser.ImportPathHint",
      scope: "world",
      config: false,
      type: String,
      default: DEFAULT_IMPORT_PATH
    });

    game.settings.register(MODULE_ID, "thumbnailSize", {
      name: "DDBrowser.ThumbnailSize",
      scope: "client",
      config: false,
      type: Number,
      choices: {
        120: "DDBrowser.Small",
        160: "DDBrowser.Medium",
        220: "DDBrowser.Big"
      },
      default: DEFAULT_THUMBNAIL_SIZE
    });

    game.settings.register(MODULE_ID, "optimizedMode", {
      name: "DDBrowser.OptimizedMode",
      hint: "DDBrowser.OptimizedModeHint",
      scope: "client",
      config: false,
      type: Boolean,
      default: false
    });

    game.settings.register(MODULE_ID, "rotationStep", {
      name: "DDBrowser.RotationStep",
      scope: "client",
      config: false,
      type: Number,
      default: 15
    });

    game.settings.register(MODULE_ID, "scaleStep", {
      name: "DDBrowser.ScaleStep",
      scope: "client",
      config: false,
      type: Number,
      default: 0.1
    });

    game.settings.register(MODULE_ID, "snapToGrid", {
      name: "DDBrowser.SnapToGrid",
      scope: "client",
      config: false,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "lockPlacedTiles", {
      name: "DDBrowser.LockPlacedTiles",
      scope: "client",
      config: false,
      type: Boolean,
      default: false
    });

    game.settings.register(MODULE_ID, "mapDpi", {
      name: "DDBrowser.MapDpi",
      scope: "client",
      config: false,
      type: Number,
      default: DEFAULT_MAP_DPI
    });

    game.settings.register(MODULE_ID, "assetPlacementSizes", {
      scope: "client",
      config: false,
      type: Object,
      default: {}
    });

    game.settings.register(MODULE_ID, "colorPalette", {
      scope: "client",
      config: false,
      type: Object,
      default: {
        selected: "#ffffff",
        recent: ["#ffffff"],
        favorites: []
      }
    });
  }

  static get library() {
    const library = game.settings.get(MODULE_ID, "library") ?? createEmptyLibrary();
    return normalizeLibrary(library);
  }

  static async save(library, { syncShared = true } = {}) {
    const normalized = normalizeLibrary(library);
    if (syncShared && game.user?.isGM) normalized.sharedUpdatedAt = new Date().toISOString();

    const saved = await game.settings.set(MODULE_ID, "library", normalized);
    if (syncShared && game.user?.isGM) {
      try {
        await writeSharedLibraryIndex(normalized);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not write shared library index`, error);
      }
    }
    return saved;
  }

  static async syncSharedLibraryIndex() {
    if (!game.user.isGM) return false;

    const current = this.library;
    const shared = await readSharedLibraryIndex();
    if (shared === undefined) {
      if (!hasLibraryData(current)) {
        if (current.libraryClearedAt) return false;
        const rebuilt = await rebuildLibraryFromAssetFolder();
        if (rebuilt && hasLibraryData(rebuilt)) {
          await this.save(rebuilt);
          return true;
        }
      }
      return false;
    }
    if (!shared) {
      if (!hasLibraryData(current)) {
        if (current.libraryClearedAt) return false;
        const rebuilt = await rebuildLibraryFromAssetFolder();
        if (rebuilt && hasLibraryData(rebuilt)) {
          await this.save(rebuilt);
          return true;
        }
      }
      if (hasLibraryData(current)) await writeSharedLibraryIndex(current);
      return false;
    }

    if (!hasLibraryData(shared)) {
      if (shared.libraryClearedAt && isLibraryNewer(shared, current)) {
        await this.save(shared, { syncShared: false });
        return true;
      }
      if (hasLibraryData(current)) await writeSharedLibraryIndex(current);
      else {
        if (current.libraryClearedAt || shared.libraryClearedAt) return false;
        const rebuilt = await rebuildLibraryFromAssetFolder();
        if (rebuilt && hasLibraryData(rebuilt)) {
          await this.save(rebuilt);
          return true;
        }
      }
      return false;
    }

    let next = null;
    if (!hasLibraryData(current)) next = shared;
    else if (isLibraryNewer(shared, current)) next = shared;
    else if (isLibraryNewer(current, shared)) await writeSharedLibraryIndex(current);
    else next = mergeLibraries(current, shared);

    if (!next || librariesEqual(current, next)) return false;
    await this.save(next, { syncShared: false });
    return true;
  }

  static async migrateImportPathDefault() {
    const currentPath = sanitizeFoundryPath(game.settings.get(MODULE_ID, "importPath") || "");
    if (currentPath !== this.legacyWorldImportPath) return;
    await game.settings.set(MODULE_ID, "importPath", DEFAULT_IMPORT_PATH);
    console.info(`${MODULE_ID} | Import path default migrated to ${DEFAULT_IMPORT_PATH}. Existing tile file links were left unchanged.`);
  }

  static async migrateImportedTags() {
    if (!game.user.isGM) return false;

    const library = this.library;
    if (library.importedTagsMigrated) return false;

    for (const [assetId, asset] of Object.entries(library.assets)) {
      const tags = normalizeImportedTagNames([
        ...(asset.tags ?? []),
        ...(asset.colorable ? ["colorable"] : [])
      ]);
      if (!tags.length) continue;

      ensureImportedAssetTags(library, tags);
      assignImportedAssetTags(library, assetId, tags, {
        skip: Boolean(library.userTags.assetAssignments[assetId]?.length)
      });
    }

    library.importedTagsMigrated = true;
    await this.save(library);
    return true;
  }

  static async setPackEnabled(packId, enabled) {
    const library = this.library;
    if (!library.packs[packId]) return library;
    library.packs[packId].enabled = enabled;
    return this.save(library);
  }

  static async setPacksEnabled(packIds, enabled) {
    const library = this.library;
    let changed = 0;
    for (const packId of normalizeTagIds(packIds)) {
      if (!library.packs[packId]) continue;
      if (library.packs[packId].enabled === enabled) continue;
      library.packs[packId].enabled = enabled;
      changed += 1;
    }
    if (!changed) return { library, changed };
    await this.save(library);
    return { library, changed };
  }

  static async setPacksHidden(packIds, hidden) {
    if (!game.user.isGM) throw new Error("Only a GM can show or hide packs.");

    const library = this.library;
    let changed = 0;
    for (const packId of normalizeTagIds(packIds)) {
      if (!library.packs[packId]) continue;
      if (Boolean(library.packs[packId].hidden) === hidden) continue;
      library.packs[packId].hidden = hidden;
      changed += 1;
    }

    if (!changed) return { library, changed };
    await this.save(library);
    return { library, changed };
  }

  static async updateEntryMetadata(scope, entryId, metadata = {}) {
    if (!game.user.isGM) throw new Error("Only a GM can edit library entries.");

    const library = this.library;
    const collection = scope === "pack" ? library.packs : library.assets;
    const entry = collection[entryId];
    if (!entry) return null;

    const name = cleanMetadataField(metadata.name, 120);
    const author = cleanMetadataField(metadata.author, 120);
    if (name) entry.name = name;
    entry.author = author;

    if (scope === "pack") {
      for (const asset of Object.values(library.assets)) {
        if (asset.packId === entryId) asset.author = author;
      }
    }

    await this.save(library);
    return entry;
  }

  static async removeAsset(assetId) {
    if (!game.user.isGM) throw new Error("Only a GM can remove assets from the library.");

    const library = this.library;
    const asset = library.assets[assetId];
    if (!asset) return null;

    delete library.assets[assetId];

    for (const variantKey of Object.keys(library.colorVariants)) {
      if (variantKey.startsWith(`${assetId}:`)) delete library.colorVariants[variantKey];
    }

    const pack = library.packs[asset.packId];
    if (pack) {
      pack.assetCount = Object.values(library.assets).filter((entry) => entry.packId === asset.packId).length;
    }
    delete library.userTags.assetAssignments[assetId];

    await this.save(library);
    return asset;
  }

  static async removeAssets(assetIds) {
    if (!game.user.isGM) throw new Error("Only a GM can remove assets from the library.");

    const library = this.library;
    const removed = [];
    const removedAssetIds = new Set();
    const affectedPackIds = new Set();

    for (const assetId of normalizeTagIds(assetIds)) {
      const asset = library.assets[assetId];
      if (!asset) continue;

      removed.push(asset);
      removedAssetIds.add(assetId);
      affectedPackIds.add(asset.packId);
      delete library.assets[assetId];
      delete library.userTags.assetAssignments[assetId];
    }

    if (!removed.length) return [];

    for (const variantKey of Object.keys(library.colorVariants)) {
      const assetId = variantKey.split(":")[0];
      if (removedAssetIds.has(assetId)) delete library.colorVariants[variantKey];
    }

    for (const packId of affectedPackIds) {
      const pack = library.packs[packId];
      if (!pack) continue;
      pack.assetCount = Object.values(library.assets).filter((entry) => entry.packId === packId).length;
    }

    await this.save(library);
    return removed;
  }

  static async removePack(packId) {
    if (!game.user.isGM) throw new Error("Only a GM can remove packs from the library.");

    const library = this.library;
    const pack = library.packs[packId];
    if (!pack) return null;

    const removedAssetIds = new Set();
    for (const [assetId, asset] of Object.entries(library.assets)) {
      if (asset.packId !== packId) continue;
      removedAssetIds.add(assetId);
      delete library.assets[assetId];
    }

    for (const variantKey of Object.keys(library.colorVariants)) {
      const assetId = variantKey.split(":")[0];
      if (removedAssetIds.has(assetId)) delete library.colorVariants[variantKey];
    }

    delete library.userTags.packAssignments[packId];
    for (const assetId of removedAssetIds) delete library.userTags.assetAssignments[assetId];
    delete library.packs[packId];
    await this.save(library);
    return pack;
  }

  static async clearLibrary({ deleteFiles = false } = {}) {
    if (!game.user.isGM) throw new Error("Only a GM can clear the library.");

    const library = this.library;
    const counts = {
      packs: Object.keys(library.packs).length,
      assets: Object.keys(library.assets).length,
      files: 0,
      directories: 0,
      fileDeleteSupported: true
    };

    if (deleteFiles) {
      const deleted = await deleteImportPathContents();
      counts.files = deleted.files;
      counts.directories = deleted.directories;
      counts.fileDeleteSupported = deleted.supported;
    }

    const emptyLibrary = createEmptyLibrary();
    emptyLibrary.libraryClearedAt = new Date().toISOString();
    await this.save(emptyLibrary);
    return counts;
  }

  static async rebuildLibraryFromFiles() {
    if (!game.user.isGM) throw new Error("Only a GM can rebuild the library.");

    const rebuilt = await rebuildLibraryFromAssetFolder();
    if (!rebuilt || !hasLibraryData(rebuilt)) {
      return { packs: 0, assets: 0 };
    }

    await this.save(rebuilt);
    return {
      packs: Object.keys(rebuilt.packs).length,
      assets: Object.keys(rebuilt.assets).length
    };
  }

  static getUserTags(scope) {
    const library = this.library;
    return getUserTagList(library, scope);
  }

  static getEntryTagIds(scope, entryId) {
    const library = this.library;
    const assignments = getUserTagAssignments(library, scope);
    return normalizeTagIds(assignments[entryId] ?? []);
  }

  static async createUserTag(scope, name) {
    if (!game.user.isGM) throw new Error("Only a GM can create tags.");

    const cleanName = normalizeTagName(name);
    if (!cleanName) throw new Error("Tag name is required.");

    const library = this.library;
    const tags = getUserTagList(library, scope);
    const existing = tags.find((tag) => tag.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) return existing;

    const tag = {
      id: `tag-${hashString(`${scope}:${cleanName}:${Date.now()}`)}`,
      name: cleanName
    };
    tags.push(tag);
    tags.sort((a, b) => a.name.localeCompare(b.name));
    await this.save(library);
    return tag;
  }

  static async deleteUserTag(scope, tagId) {
    if (!game.user.isGM) throw new Error("Only a GM can delete tags.");

    const library = this.library;
    const tags = getUserTagList(library, scope);
    const index = tags.findIndex((tag) => tag.id === tagId);
    if (index < 0) return null;
    if (isServiceTag(tags[index])) return null;

    const [tag] = tags.splice(index, 1);
    const assignments = getUserTagAssignments(library, scope);
    for (const [entryId, tagIds] of Object.entries(assignments)) {
      const next = normalizeTagIds(tagIds).filter((id) => id !== tagId);
      if (next.length) assignments[entryId] = next;
      else delete assignments[entryId];
    }

    await this.save(library);
    return tag;
  }

  static async setEntryTagIds(scope, entryId, tagIds) {
    if (!game.user.isGM) throw new Error("Only a GM can assign tags.");

    const library = this.library;
    const assignments = getUserTagAssignments(library, scope);
    const validTagIds = new Set(getUserTagList(library, scope).map((tag) => tag.id));
    const serviceTagIds = new Set(getUserTagList(library, scope).filter(isServiceTag).map((tag) => tag.id));
    const currentServiceTagIds = normalizeTagIds(assignments[entryId] ?? []).filter((tagId) => serviceTagIds.has(tagId));
    const next = Array.from(new Set([
      ...currentServiceTagIds,
      ...normalizeTagIds(tagIds).filter((tagId) => validTagIds.has(tagId) && !serviceTagIds.has(tagId))
    ]));

    if (next.length) assignments[entryId] = next;
    else delete assignments[entryId];

    await this.save(library);
    return next;
  }

  static async addTagsToAssets(assetIds, tagIds) {
    if (!game.user.isGM) throw new Error("Only a GM can assign tags.");

    const library = this.library;
    const validAssetIds = new Set(Object.keys(library.assets));
    const validTagIds = new Set(getUserTagList(library, "asset").filter((tag) => !isServiceTag(tag)).map((tag) => tag.id));
    const tagsToAdd = normalizeTagIds(tagIds).filter((tagId) => validTagIds.has(tagId));
    if (!tagsToAdd.length) return 0;

    const assignments = getUserTagAssignments(library, "asset");
    let changed = 0;
    for (const assetId of normalizeTagIds(assetIds)) {
      if (!validAssetIds.has(assetId)) continue;
      const next = Array.from(new Set([...(assignments[assetId] ?? []), ...tagsToAdd]));
      if (next.length !== (assignments[assetId] ?? []).length) changed += 1;
      assignments[assetId] = next;
    }

    await this.save(library);
    return changed;
  }

  static getAssets(filters = {}) {
    const library = this.library;
    const assetSearch = filters.assetSearch?.trim().toLowerCase() ?? "";
    const assetNameSearch = filters.assetNameSearch?.trim().toLowerCase() ?? "";
    const author = filters.author ?? "";
    const assetTagIds = normalizeTagIds(filters.assetTagIds ?? []);
    const assetTagFilter = new Set(assetTagIds);
    const assetAssignments = getUserTagAssignments(library, "asset");
    const matchingPackIds = new Set(
      Object.values(library.packs)
        .filter((pack) => pack.hidden !== true)
        .filter((pack) => pack.enabled !== false)
        .filter((pack) => !author || pack.author === author)
        .filter((pack) => {
          if (!assetSearch) return true;
          const haystack = `${pack.name} ${pack.author} ${pack.sourceId ?? ""}`.toLowerCase();
          return haystack.includes(assetSearch);
        })
        .map((pack) => pack.id)
    );

    return Object.values(library.assets)
      .filter((asset) => matchingPackIds.has(asset.packId))
      .filter((asset) => {
        if (!assetNameSearch) return true;
        return String(asset.name ?? "").toLowerCase().includes(assetNameSearch);
      })
      .filter((asset) => {
        if (!assetTagFilter.size) return true;
        const assigned = assetAssignments[asset.id] ?? [];
        return assigned.some((tagId) => assetTagFilter.has(tagId));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  static getFilterOptions() {
    const library = this.library;
    const authors = new Set();

    for (const asset of Object.values(library.assets)) {
      const pack = library.packs[asset.packId];
      if (!pack || pack.hidden === true || pack.enabled === false) continue;
      if (asset.author) authors.add(asset.author);
    }

    return {
      authors: Array.from(authors).sort((a, b) => a.localeCompare(b))
    };
  }

  static async importPack(file, { onProgress } = {}) {
    if (!game.user.isGM) throw new Error("Only a GM can import Dungeondraft packs.");

    onProgress?.("Reading pack index");
    const parsed = await parseDungeondraftPack(file);
    const packId = makeImportedPackId(parsed, file, this.library);
    const basePath = `${this.importPath}/${packId}`;
    const rawPath = `${basePath}/raw`;
    const texturePath = `${basePath}/textures/objects`;
    const thumbnailPath = `${basePath}/thumbnails`;

    await ensureDirectory(this.importPath);
    await ensureDirectory(basePath);
    await ensureDirectory(rawPath);
    await ensureDirectory(texturePath);
    await ensureDirectory(thumbnailPath);

    const library = this.library;
    const packMeta = {
      id: packId,
      sourceId: parsed.packId,
      sourceFileName: file.name,
      name: parsed.pack.name || stripExtension(file.name),
      author: parsed.pack.author || "",
      version: parsed.pack.version || "",
      enabled: library.packs[packId]?.enabled ?? true,
      hidden: library.packs[packId]?.hidden === true,
      previewSrc: "",
      importedAt: new Date().toISOString(),
      assetCount: parsed.objects.length
    };

    onProgress?.("Uploading metadata");
    await uploadTextFile(rawPath, "pack.json", JSON.stringify(parsed.pack, null, 2));
    await uploadTextFile(rawPath, "default.dungeondraft_tags.json", JSON.stringify(parsed.tags ?? {}, null, 2));

    if (parsed.preview) {
      const previewFile = new File([parsed.preview], "preview.png", { type: "image/png" });
      packMeta.previewSrc = await uploadFoundryFile(basePath, previewFile);
    }

    ensureImportedAssetTags(library, Object.keys(parsed.tags?.tags ?? {}));
    const tagIndex = buildTagIndex(parsed.tags);
    const importedAssetIds = new Set();

    for (let index = 0; index < parsed.objects.length; index += 1) {
      const object = parsed.objects[index];
      const relativeName = object.path.replace(/^textures\/objects\//, "");
      const safeName = sanitizeFileName(relativeName);
      const assetFile = new File([object.blob], safeName, { type: object.blob.type || "image/webp" });
      onProgress?.(`Uploading ${index + 1} / ${parsed.objects.length}`);
      const src = await uploadFoundryFile(texturePath, assetFile);
      const size = await getImageSize(object.blob);
      const grid = getGridSizeFromName(relativeName);
      const tags = tagIndex.byPath.get(normalizeTagPathKey(object.path)) ?? [];
      const themeTags = inferThemeTags(relativeName, tags);
      const colorable = tagIndex.colorable.has(normalizeTagPathKey(object.path)) || hasColorOverride(parsed.tags, object.path);
      const assetId = `${packId}.${hashString(object.path)}`;
      const existingAsset = library.assets[assetId];
      const thumbSrc = await createAndUploadThumbnail(object.blob, thumbnailPath, assetId).catch((error) => {
        console.warn(`${MODULE_ID} | Could not create thumbnail for ${object.path}`, error);
        return existingAsset?.thumbSrc && existingAsset.thumbSrc !== existingAsset.src ? existingAsset.thumbSrc : src;
      });

      library.assets[assetId] = {
        id: assetId,
        packId,
        name: humanizeName(relativeName),
        author: packMeta.author,
        src,
        thumbSrc: thumbSrc || src,
        tags,
        themeTags,
        width: size.width,
        height: size.height,
        gridWidth: grid?.width ?? null,
        gridHeight: grid?.height ?? null,
        colorable,
        userTagsImported: true
      };
      assignImportedAssetTags(library, assetId, tags, {
        skip: existingAsset?.userTagsImported === true && Boolean(library.userTags.assetAssignments[assetId]?.length)
      });
      importedAssetIds.add(assetId);
    }

    for (const [assetId, asset] of Object.entries(library.assets)) {
      if (asset.packId === packId && !importedAssetIds.has(assetId)) {
        delete library.assets[assetId];
        delete library.userTags.assetAssignments[assetId];
      }
    }

    library.packs[packId] = packMeta;
    return this.save(library);
  }

  static async importImageFiles(files, { packName = "", onProgress } = {}) {
    if (!game.user.isGM) throw new Error("Only a GM can import tile folders.");

    const imageFiles = Array.from(files)
      .map((file) => ({
        file,
        relativePath: normalizeRelativeFilePath(file.relativePath || file.webkitRelativePath || file.name)
      }))
      .filter(({ file }) => IMAGE_FILE_RE.test(file.name));

    if (!imageFiles.length) throw new Error("No supported image files were found.");

    const groups = buildImageImportGroups(imageFiles, { packName });
    if (!groups.length) throw new Error("No supported image files were found.");

    const totalFiles = groups.reduce((sum, group) => sum + group.files.length, 0);
    let uploadedFiles = 0;
    const usedPackIds = new Map();
    const library = this.library;
    await ensureDirectory(this.importPath);

    for (const group of groups) {
      const packId = makeUniqueFolderPackId(group.name, usedPackIds);
      const basePath = `${this.importPath}/${packId}`;
      const rawPath = `${basePath}/raw`;
      const texturePath = `${basePath}/textures/objects`;
      const thumbnailPath = `${basePath}/thumbnails`;

      await ensureDirectory(basePath);
      await ensureDirectory(rawPath);
      await ensureDirectory(texturePath);
      await ensureDirectory(thumbnailPath);

      const packMeta = {
        id: packId,
        sourceId: group.sourceId,
        name: group.name,
        author: "Folder Import",
        version: "",
        enabled: library.packs[packId]?.enabled ?? true,
        hidden: library.packs[packId]?.hidden === true,
        previewSrc: "",
        importedAt: new Date().toISOString(),
        assetCount: group.files.length,
        type: "folder"
      };
      onProgress?.(`Uploading ${group.name} index`);
      await uploadTextFile(rawPath, "folder-import.json", JSON.stringify({
        name: group.name,
        sourceId: group.sourceId,
        recursive: true,
        files: group.files.map(({ relativePath }) => relativePath)
      }, null, 2));

      const importedAssetIds = new Set();

      for (const entry of group.files) {
        const { file, pathInPack } = entry;
        const directoryTags = getDirectoryTags(pathInPack);
        const targetDirectory = `${texturePath}/${directoryTags.map(sanitizePathSegment).filter(Boolean).join("/")}`.replace(/\/+$/g, "");
        await ensureDirectory(targetDirectory);

        uploadedFiles += 1;
        onProgress?.(`Uploading ${group.name}: ${uploadedFiles} / ${totalFiles}`);
        const safeName = sanitizeFileName(file.name);
        const uploadFile = file.name === safeName ? file : new File([file], safeName, { type: file.type || mimeTypeForFileName(safeName) });
        const src = await uploadFoundryFile(targetDirectory, uploadFile);
        const size = await getImageSize(file);
        const grid = getGridSizeFromName(pathInPack);
        const tags = directoryTags;
        const themeTags = inferThemeTags(pathInPack, tags);
        const assetId = `${packId}.${hashString(pathInPack)}`;
        const existingAsset = library.assets[assetId];
        const thumbSrc = await createAndUploadThumbnail(file, thumbnailPath, assetId).catch((error) => {
          console.warn(`${MODULE_ID} | Could not create thumbnail for ${pathInPack}`, error);
          return existingAsset?.thumbSrc && existingAsset.thumbSrc !== existingAsset.src ? existingAsset.thumbSrc : src;
        });

        library.assets[assetId] = {
          id: assetId,
          packId,
          name: humanizeName(pathInPack),
          author: packMeta.author,
          src,
          thumbSrc: thumbSrc || src,
          tags,
          themeTags,
          width: size.width,
          height: size.height,
          gridWidth: grid?.width ?? null,
          gridHeight: grid?.height ?? null,
          colorable: false,
          source: group.name,
          userTagsImported: true
        };
        assignImportedAssetTags(library, assetId, tags, {
          skip: existingAsset?.userTagsImported === true && Boolean(library.userTags.assetAssignments[assetId]?.length)
        });
        importedAssetIds.add(assetId);
        packMeta.previewSrc ||= src;
      }

      for (const [assetId, asset] of Object.entries(library.assets)) {
        if (asset.packId === packId && !importedAssetIds.has(assetId)) {
          delete library.assets[assetId];
          delete library.userTags.assetAssignments[assetId];
        }
      }

      library.packs[packId] = packMeta;
    }

    return this.save(library);
  }

  static async resolveAssetSource(asset, color) {
    if (!color || !asset.colorable) return asset.src;

    const cleanColor = normalizeColor(color);
    const variantKey = `${asset.id}:v${COLOR_VARIANT_VERSION}:${cleanColor}`;
    const legacyVariantKey = `${asset.id}:${cleanColor}`;
    const library = this.library;
    if (library.colorVariants[variantKey]) return library.colorVariants[variantKey];
    delete library.colorVariants[legacyVariantKey];

    const generatedPath = `${this.importPath}/${asset.packId}/generated`;
    await ensureDirectory(generatedPath);
    const variant = await generateColorVariant(asset.src, cleanColor);
    const extension = variant.type === "image/webp" ? "webp" : "png";
    const file = new File([variant.blob], `${asset.id.replace(/[^a-z0-9.-]/gi, "_")}-v${COLOR_VARIANT_VERSION}-${cleanColor}.${extension}`, {
      type: variant.type
    });
    const src = await uploadFoundryFile(generatedPath, file);

    library.colorVariants[variantKey] = src;
    await this.save(library);
    return src;
  }

  static async ensureAssetThumbnail(asset) {
    if (!asset?.id || !asset.src) return null;
    if (asset.thumbSrc && asset.thumbSrc !== asset.src) return asset.thumbSrc;
    if (!game.user?.isGM) return asset.thumbSrc || asset.src;

    const library = this.library;
    const current = library.assets[asset.id];
    if (!current) return asset.thumbSrc || asset.src;
    if (current.thumbSrc && current.thumbSrc !== current.src) return current.thumbSrc;

    const thumbnailPath = `${this.importPath}/${current.packId}/thumbnails`;
    await ensureDirectory(thumbnailPath);
    const thumbSrc = await createAndUploadThumbnail(current.src, thumbnailPath, current.id);
    if (!thumbSrc) return current.src;

    current.thumbSrc = thumbSrc;
    await this.save(library);
    return thumbSrc;
  }

  static async generateMissingThumbnails({ onProgress } = {}) {
    if (!game.user?.isGM) return { total: 0, generated: 0, skipped: 0, failed: 0 };

    const library = this.library;
    const assets = Object.values(library.assets);
    const missing = assets.filter((asset) => asset?.id && asset.src && (!asset.thumbSrc || asset.thumbSrc === asset.src));
    let generated = 0;
    let failed = 0;

    for (const [index, asset] of missing.entries()) {
      try {
        const current = library.assets[asset.id];
        if (!current?.src) continue;

        const thumbnailPath = `${this.importPath}/${current.packId}/thumbnails`;
        await ensureDirectory(thumbnailPath);
        const thumbSrc = await createAndUploadThumbnail(current.src, thumbnailPath, current.id);
        if (!thumbSrc) {
          failed += 1;
          continue;
        }

        current.thumbSrc = thumbSrc;
        generated += 1;
      } catch (error) {
        failed += 1;
        console.warn(`${MODULE_ID} | Could not generate thumbnail for ${asset.id}`, error);
      }

      onProgress?.({
        total: missing.length,
        done: index + 1,
        generated,
        failed
      });
    }

    if (generated) await this.save(library);
    return {
      total: missing.length,
      generated,
      skipped: assets.length - missing.length,
      failed
    };
  }

  static get importPath() {
    return sanitizeFoundryPath(game.settings.get(MODULE_ID, "importPath") || DEFAULT_IMPORT_PATH);
  }

  static get legacyWorldImportPath() {
    return sanitizeFoundryPath(`worlds/${game.world?.id ?? "world"}/${MODULE_ID}`);
  }
}

function createEmptyLibrary() {
  return {
    version: LIBRARY_VERSION,
    packs: {},
    assets: {},
    colorVariants: {},
    userTags: createEmptyUserTags(),
    importedTagsMigrated: false,
    sharedUpdatedAt: "",
    libraryClearedAt: ""
  };
}

function normalizeLibrary(library) {
  return {
    version: library.version ?? LIBRARY_VERSION,
    packs: library.packs ?? {},
    assets: library.assets ?? {},
    colorVariants: library.colorVariants ?? {},
    userTags: normalizeUserTags(library.userTags),
    importedTagsMigrated: Boolean(library.importedTagsMigrated),
    sharedUpdatedAt: String(library.sharedUpdatedAt ?? ""),
    libraryClearedAt: String(library.libraryClearedAt ?? "")
  };
}

function createEmptyUserTags() {
  return {
    packTags: [],
    assetTags: [],
    packAssignments: {},
    assetAssignments: {}
  };
}

function normalizeUserTags(userTags = {}) {
  return {
    packTags: normalizeTagList(userTags.packTags),
    assetTags: normalizeTagList(userTags.assetTags),
    packAssignments: normalizeAssignments(userTags.packAssignments),
    assetAssignments: normalizeAssignments(userTags.assetAssignments)
  };
}

async function readSharedLibraryIndex() {
  try {
    const indexPath = await findSharedLibraryIndexPath();
    if (!indexPath) return null;

    const response = await fetchFoundryDataPath(indexPath);
    return normalizeLibrary(await response.json());
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not read shared library index`, error);
    return undefined;
  }
}

async function writeSharedLibraryIndex(library) {
  await ensureDirectory(LibraryStore.importPath);
  const normalized = normalizeLibrary(library);
  normalized.sharedUpdatedAt ||= new Date().toISOString();
  await uploadTextFile(LibraryStore.importPath, SHARED_LIBRARY_INDEX_FILE, JSON.stringify(normalized, null, 2));
}

async function deleteImportPathContents() {
  const importPath = LibraryStore.importPath;
  const result = {
    files: 0,
    directories: 0,
    supported: true
  };

  if (!isSafeImportDeletePath(importPath)) {
    result.supported = false;
    console.warn(`${MODULE_ID} | Refusing to delete files from broad import path: ${importPath}`);
    return result;
  }

  const deleteResult = await deleteDataDirectoryContents(importPath, true);
  result.files = deleteResult.files;
  result.directories = deleteResult.directories;
  result.supported = deleteResult.supported;
  return result;
}

async function deleteDataDirectoryContents(path, keepRoot = false) {
  const result = {
    files: 0,
    directories: 0,
    supported: true
  };
  const directory = await browseDataDirectory(path);
  if (!directory) return result;

  for (const filePath of directory.files ?? []) {
    const deleted = await deleteFoundryDataPath(filePath, "file");
    if (deleted) result.files += 1;
    else result.supported = false;
  }

  for (const directoryPath of directory.dirs ?? []) {
    const childResult = await deleteDataDirectoryContents(directoryPath);
    result.files += childResult.files;
    result.directories += childResult.directories;
    result.supported &&= childResult.supported;
  }

  if (!keepRoot) {
    const deleted = await deleteFoundryDataPath(path, "directory");
    if (deleted) result.directories += 1;
    else result.supported = false;
  }

  return result;
}

async function deleteFoundryDataPath(path, type) {
  const cleanPath = sanitizeFoundryPath(path);
  const candidates = [
    FilePicker?.delete,
    FilePicker?.implementation?.delete,
    FilePicker?.deleteFile,
    FilePicker?.implementation?.deleteFile,
    type === "directory" ? FilePicker?.deleteDirectory : null,
    type === "directory" ? FilePicker?.implementation?.deleteDirectory : null
  ].filter((fn, index, list) => typeof fn === "function" && list.indexOf(fn) === index);

  for (const fn of candidates) {
    const calls = [
      () => fn.call(FilePicker, "data", cleanPath, { recursive: true }, { notify: false }),
      () => fn.call(FilePicker, "data", cleanPath, { notify: false }),
      () => fn.call(FilePicker, cleanPath, { source: "data", recursive: true, notify: false }),
      () => fn.call(FilePicker, { source: "data", target: cleanPath, path: cleanPath, recursive: true }, { notify: false })
    ];

    for (const call of calls) {
      try {
        await call();
        return true;
      } catch (error) {
        const message = String(error?.message ?? error).toLowerCase();
        if (message.includes("not found") || message.includes("does not exist") || message.includes("no such")) return true;
      }
    }
  }

  console.warn(`${MODULE_ID} | Foundry file deletion API is not available for ${cleanPath}`);
  return false;
}

function isSafeImportDeletePath(path) {
  const cleanPath = sanitizeFoundryPath(path).toLowerCase();
  if (!cleanPath || cleanPath === "assets" || cleanPath === "worlds" || cleanPath === "modules") return false;
  return cleanPath.split("/").includes(MODULE_ID);
}

async function rebuildLibraryFromAssetFolder() {
  const root = await browseDataDirectory(LibraryStore.importPath);
  if (!root) return null;

  const library = createEmptyLibrary();
  library.sharedUpdatedAt = new Date().toISOString();

  for (const directory of root.dirs ?? []) {
    const packDir = resolveBrowsePath(directory, LibraryStore.importPath);
    const packId = sanitizePathSegment(normalizeRelativeFilePath(packDir).split("/").pop());
    const raw = await browseDataDirectory(`${packDir}/raw`);
    const textures = await listDataFilesRecursive(`${packDir}/textures/objects`);
    const objectFiles = textures.filter((filePath) => isImageFilePath(filePath));
    if (!raw || !objectFiles.length) continue;

    const packJsonPath = findFileByName(raw.files, "pack.json");
    const folderJsonPath = findFileByName(raw.files, "folder-import.json");
    if (!packJsonPath && !folderJsonPath) continue;

    const pack = await readJsonDataPath(packJsonPath || folderJsonPath);
    const isFolderImport = !packJsonPath;
    const tagsPath = findFileByName(raw.files, "default.dungeondraft_tags.json");
    const tagsData = tagsPath ? await readJsonDataPath(tagsPath) : {};
    const previewPath = findFileByName((await browseDataDirectory(packDir))?.files ?? [], "preview.png");
    const tagIndex = buildTagIndex(tagsData);

    const packMeta = {
      id: packId,
      sourceId: pack.id || pack.sourceId || packId,
      sourceFileName: "",
      name: pack.name || humanizeName(packId),
      author: pack.author || (isFolderImport ? "Folder Import" : ""),
      version: pack.version || "",
      enabled: true,
      previewSrc: previewPath || "",
      importedAt: new Date().toISOString(),
      assetCount: objectFiles.length,
      type: isFolderImport ? "folder" : undefined
    };

    ensureImportedAssetTags(library, Object.keys(tagsData?.tags ?? {}));

    for (const src of objectFiles) {
      const relativeName = normalizeRelativeFilePath(src).replace(`${normalizeRelativeFilePath(`${packDir}/textures/objects`)}/`, "");
      const objectPath = `textures/objects/${relativeName}`;
      const grid = getGridSizeFromName(relativeName);
      const tags = isFolderImport ? getDirectoryTags(relativeName) : (tagIndex.byPath.get(normalizeTagPathKey(objectPath)) ?? []);
      const colorable = !isFolderImport && (tagIndex.colorable.has(normalizeTagPathKey(objectPath)) || hasColorOverride(tagsData, objectPath));
      const assetId = `${packId}.${hashString(objectPath)}`;

      library.assets[assetId] = {
        id: assetId,
        packId,
        name: humanizeName(relativeName),
        author: packMeta.author,
        src,
        thumbSrc: src,
        tags,
        themeTags: inferThemeTags(relativeName, tags),
        width: 100,
        height: 100,
        gridWidth: grid?.width ?? null,
        gridHeight: grid?.height ?? null,
        colorable,
        userTagsImported: true
      };
      assignImportedAssetTags(library, assetId, tags);
    }

    packMeta.assetCount = Object.values(library.assets).filter((asset) => asset.packId === packId).length;
    library.packs[packId] = packMeta;
  }

  return hasLibraryData(library) ? normalizeLibrary(library) : null;
}

async function findSharedLibraryIndexPath() {
  try {
    const result = await FilePicker.browse("data", LibraryStore.importPath, {}, { notify: false });
    const files = Array.from(result.files ?? []).map((filePath) => resolveBrowsePath(filePath, LibraryStore.importPath));
    return files.find((filePath) => normalizeRelativeFilePath(filePath).endsWith(`/${SHARED_LIBRARY_INDEX_FILE}`))
      ?? files.find((filePath) => normalizeRelativeFilePath(filePath) === SHARED_LIBRARY_INDEX_FILE)
      ?? null;
  } catch (error) {
    const message = String(error?.message ?? error).toLowerCase();
    if (message.includes("does not exist") || message.includes("not found") || message.includes("no such")) return null;
    throw error;
  }
}

async function browseDataDirectory(path) {
  try {
    const cleanPath = sanitizeFoundryPath(path);
    const result = await FilePicker.browse("data", cleanPath, {}, { notify: false });
    return {
      ...result,
      files: Array.from(result.files ?? []).map((filePath) => resolveBrowsePath(filePath, cleanPath)),
      dirs: Array.from(result.dirs ?? []).map((directory) => resolveBrowsePath(directory, cleanPath))
    };
  } catch (error) {
    const message = String(error?.message ?? error).toLowerCase();
    if (message.includes("does not exist") || message.includes("not found") || message.includes("no such")) return null;
    throw error;
  }
}

async function listDataFilesRecursive(path) {
  const result = await browseDataDirectory(path);
  if (!result) return [];

  const files = Array.from(result.files ?? []);
  for (const directory of result.dirs ?? []) {
    files.push(...await listDataFilesRecursive(directory));
  }
  return files;
}

function findFileByName(files = [], name) {
  const lowerName = name.toLowerCase();
  return Array.from(files).find((filePath) => normalizeRelativeFilePath(filePath).split("/").pop().toLowerCase() === lowerName) ?? "";
}

function isImageFilePath(path) {
  return IMAGE_FILE_RE.test(path);
}

function resolveBrowsePath(path, parentPath) {
  const cleanPath = normalizeRelativeFilePath(path);
  if (!cleanPath) return sanitizeFoundryPath(parentPath);
  if (cleanPath.includes("/")) return cleanPath;
  return `${sanitizeFoundryPath(parentPath)}/${cleanPath}`;
}

async function readJsonDataPath(path) {
  const response = await fetchFoundryDataPath(path);
  return response.json();
}

async function fetchFoundryDataPath(path) {
  const cleanPath = sanitizeFoundryPath(path);
  const routePath = foundry.utils?.getRoute?.(cleanPath);
  const candidates = Array.from(new Set([
    routePath,
    cleanPath,
    `/${cleanPath}`
  ].filter(Boolean)));

  for (const candidate of candidates) {
    const response = await fetch(`${candidate}?v=${Date.now()}`, { cache: "no-store" });
    if (response.ok) return response;
    if (response.status !== 404) throw new Error(`HTTP ${response.status} while reading ${cleanPath}`);
  }

  throw new Error(`${SHARED_LIBRARY_INDEX_FILE} was found by FilePicker but could not be fetched.`);
}

function hasLibraryData(library) {
  return Boolean(
    Object.keys(library.packs ?? {}).length ||
    Object.keys(library.assets ?? {}).length ||
    Object.keys(library.colorVariants ?? {}).length ||
    (library.userTags?.packTags?.length ?? 0) ||
    (library.userTags?.assetTags?.length ?? 0)
  );
}

function isLibraryNewer(candidate, reference) {
  const candidateTime = Date.parse(candidate.sharedUpdatedAt || "");
  const referenceTime = Date.parse(reference.sharedUpdatedAt || "");
  return Number.isFinite(candidateTime) && (!Number.isFinite(referenceTime) || candidateTime > referenceTime);
}

function mergeLibraries(current, shared) {
  const merged = normalizeLibrary({
    ...current,
    packs: { ...shared.packs, ...current.packs },
    assets: { ...shared.assets, ...current.assets },
    colorVariants: { ...shared.colorVariants, ...current.colorVariants },
    userTags: mergeUserTags(current.userTags, shared.userTags),
    importedTagsMigrated: current.importedTagsMigrated || shared.importedTagsMigrated,
    sharedUpdatedAt: current.sharedUpdatedAt || shared.sharedUpdatedAt
  });
  return merged;
}

function mergeUserTags(current, shared) {
  const merged = createEmptyUserTags();
  merged.packTags = normalizeTagList([...(shared.packTags ?? []), ...(current.packTags ?? [])]);
  merged.assetTags = normalizeTagList([...(shared.assetTags ?? []), ...(current.assetTags ?? [])]);
  merged.packAssignments = mergeAssignments(current.packAssignments, shared.packAssignments);
  merged.assetAssignments = mergeAssignments(current.assetAssignments, shared.assetAssignments);
  return merged;
}

function mergeAssignments(current = {}, shared = {}) {
  const merged = { ...shared };
  for (const [entryId, tagIds] of Object.entries(current ?? {})) {
    merged[entryId] = Array.from(new Set([...(merged[entryId] ?? []), ...normalizeTagIds(tagIds)]));
  }
  return normalizeAssignments(merged);
}

function librariesEqual(left, right) {
  return JSON.stringify(normalizeLibrary(left)) === JSON.stringify(normalizeLibrary(right));
}

function normalizeTagList(tags = []) {
  const seenIds = new Set();
  const seenNames = new Set();
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => ({
      id: String(tag.id || `tag-${hashString(tag.name || "")}`),
      name: normalizeTagName(tag.name)
    }))
    .filter((tag) => {
      const nameKey = tag.name.toLowerCase();
      if (!tag.name || seenIds.has(tag.id) || seenNames.has(nameKey)) return false;
      seenIds.add(tag.id);
      seenNames.add(nameKey);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeAssignments(assignments = {}) {
  return Object.fromEntries(
    Object.entries(assignments ?? {})
      .map(([entryId, tagIds]) => [entryId, normalizeTagIds(tagIds)])
      .filter(([, tagIds]) => tagIds.length > 0)
  );
}

function getUserTagList(library, scope) {
  return scope === "pack" ? library.userTags.packTags : library.userTags.assetTags;
}

function getUserTagAssignments(library, scope) {
  return scope === "pack" ? library.userTags.packAssignments : library.userTags.assetAssignments;
}

function isServiceTag(tag) {
  return SERVICE_TAG_NAMES.has(normalizeTagName(tag?.name).toLowerCase());
}

function assignImportedAssetTags(library, assetId, tagNames, { skip = false } = {}) {
  const tagIds = normalizeImportedTagNames(tagNames)
    .filter((tagName) => !skip || SERVICE_TAG_NAMES.has(tagName.toLowerCase()))
    .map((tagName) => getOrCreateUserTag(library, "asset", tagName).id);
  if (!tagIds.length) return;

  const assignments = getUserTagAssignments(library, "asset");
  assignments[assetId] = Array.from(new Set([...(assignments[assetId] ?? []), ...tagIds]));
}

function ensureImportedAssetTags(library, tagNames) {
  for (const tagName of normalizeImportedTagNames(tagNames)) {
    getOrCreateUserTag(library, "asset", tagName);
  }
}

function getOrCreateUserTag(library, scope, name) {
  const cleanName = normalizeTagName(name);
  const tags = getUserTagList(library, scope);
  const existing = tags.find((tag) => tag.name.toLowerCase() === cleanName.toLowerCase());
  if (existing) return existing;

  const tag = {
    id: `tag-${hashString(`${scope}:${cleanName}`)}`,
    name: cleanName
  };
  tags.push(tag);
  tags.sort((a, b) => a.name.localeCompare(b.name));
  return tag;
}

function normalizeImportedTagNames(tagNames = []) {
  const seen = new Set();
  return (Array.isArray(tagNames) ? tagNames : [tagNames])
    .map((tagName) => normalizeTagName(tagName))
    .filter(Boolean)
    .filter((tagName) => {
      const key = tagName.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeTagIds(tagIds = []) {
  return Array.from(new Set((Array.isArray(tagIds) ? tagIds : [tagIds]).map((tagId) => String(tagId)).filter(Boolean)));
}

function normalizeTagName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
}

function cleanMetadataField(value, maxLength) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function buildTagIndex(tagsData = {}) {
  const byPath = new Map();
  const colorable = new Set();
  const tags = tagsData.tags ?? {};

  for (const [tag, paths] of Object.entries(tags)) {
    if (!Array.isArray(paths)) continue;
    for (const path of paths) {
      for (const key of getTagPathKeys(path)) {
        if (!byPath.has(key)) byPath.set(key, []);
        byPath.get(key).push(tag);
        if (tag.toLowerCase() === "colorable") colorable.add(key);
      }
    }
  }

  return { byPath, colorable };
}

function hasColorOverride(tagsData = {}, path) {
  const overrides = tagsData.custom_color_overrides ?? tagsData.customColorOverrides;
  if (!overrides) return false;
  const pathKeys = new Set(getTagPathKeys(path));
  if (Array.isArray(overrides)) return overrides.some((entryPath) => getTagPathKeys(entryPath).some((key) => pathKeys.has(key)));
  return Object.keys(overrides).some((entryPath) => getTagPathKeys(entryPath).some((key) => pathKeys.has(key)));
}

function getTagPathKeys(path) {
  const cleanPath = String(path ?? "").replace(/\\/g, "/").trim();
  const keys = new Set([normalizeTagPathKey(cleanPath)]);
  const objectPathIndex = cleanPath.indexOf("textures/objects/");
  if (objectPathIndex >= 0) keys.add(normalizeTagPathKey(cleanPath.slice(objectPathIndex)));
  keys.add(normalizeTagPathKey(cleanPath.replace(/^res:\/\/packs\/[^/]+\//i, "")));
  return Array.from(keys).filter(Boolean);
}

function normalizeTagPathKey(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^res:\/\/packs\/[^/]+\//i, "")
    .replace(/^\/+/g, "")
    .replace(/\/+/g, "/")
    .trim();
}

async function uploadTextFile(targetPath, fileName, text) {
  const file = new File([text], fileName, { type: "application/json" });
  return uploadFoundryFile(targetPath, file);
}

async function uploadFoundryFile(targetPath, file) {
  const response = await FilePicker.upload("data", targetPath, file, {}, { notify: false });
  return response.path || `${targetPath}/${file.name}`;
}

async function ensureDirectory(path) {
  const parts = sanitizeFoundryPath(path).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FilePicker.createDirectory("data", current, {}, { notify: false });
    } catch (error) {
      const message = String(error?.message ?? error).toLowerCase();
      if (!message.includes("exist") && !message.includes("eexist") && !message.includes("already")) {
        console.debug(`${MODULE_ID} | Could not create directory ${current}`, error);
      }
    }
  }
}

async function getImageSize(blob) {
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    }

    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url);
      return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return { width: 100, height: 100 };
  }
}

async function generateColorVariant(src, color) {
  const image = await loadImage(src);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, width, height);
  const rgb = hexToRgb(color);

  for (let i = 0; i < data.data.length; i += 4) {
    const r = data.data[i];
    const g = data.data[i + 1];
    const b = data.data[i + 2];
    const a = data.data[i + 3];
    if (!a) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const redMask = r > 24 && r >= g + 18 && r >= b + 18;
    const neutralMask = max > 8 && max - min <= 10;
    if (!redMask && !neutralMask) continue;

    const shade = redMask ? r / 255 : ((r * 0.2126 + g * 0.7152 + b * 0.0722) / 255);
    data.data[i] = Math.round(rgb.r * shade);
    data.data[i + 1] = Math.round(rgb.g * shade);
    data.data[i + 2] = Math.round(rgb.b * shade);
  }

  context.putImageData(data, 0, 0);
  const webp = await canvasToBlob(canvas, "image/webp", 0.92);
  if (webp) return { blob: webp, type: "image/webp" };
  return { blob: await canvasToBlob(canvas, "image/png"), type: "image/png" };
}

async function createAndUploadThumbnail(source, targetPath, assetId) {
  const blob = await createThumbnailBlob(source);
  if (!blob) return null;

  const extension = blob.type === "image/webp" ? "webp" : "png";
  const fileName = `${String(assetId).replace(/[^a-z0-9.-]/gi, "_")}.${extension}`;
  const file = new File([blob], fileName, { type: blob.type });
  return uploadFoundryFile(targetPath, file);
}

async function createThumbnailBlob(source) {
  const { image, revoke } = await loadImageSource(source);
  try {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return null;

    const scale = Math.min(1, THUMBNAIL_MAX_SIZE / width, THUMBNAIL_MAX_SIZE / height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "medium";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const webp = await canvasToBlob(canvas, "image/webp", THUMBNAIL_QUALITY);
    if (webp) return webp;
    return canvasToBlob(canvas, "image/png");
  } finally {
    revoke?.();
  }
}

async function loadImageSource(source) {
  if (source instanceof Blob) {
    const url = URL.createObjectURL(source);
    try {
      return {
        image: await loadImage(url),
        revoke: () => URL.revokeObjectURL(url)
      };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  return {
    image: await loadImage(source),
    revoke: null
  };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image ${src}`));
    image.src = src;
  });
}

function getGridSizeFromName(name) {
  const match = name.match(OBJECT_SIZE_RE);
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

function inferThemeTags(name, tags) {
  const parts = name
    .replace(/\.[^.]+$/, "")
    .split(/[,/_-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 2 && !/^[0-9]+x[0-9]+$/i.test(part));

  return Array.from(new Set([...tags, ...parts])).slice(0, 10);
}

function humanizeName(path) {
  return path
    .replace(/^.*\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

function buildImageImportGroups(imageFiles, { packName }) {
  const commonRoot = packName ? "" : detectCommonRootFolder(imageFiles);
  const entries = imageFiles.map((entry) => {
    const pathAfterRoot = commonRoot ? stripLeadingPathSegment(entry.relativePath) : entry.relativePath;
    return {
      ...entry,
      pathAfterRoot: pathAfterRoot || entry.file.name
    };
  });

  const topLevelDirectories = new Set();
  for (const entry of entries) {
    const parts = entry.pathAfterRoot.split("/").filter(Boolean);
    if (parts.length > 1) topLevelDirectories.add(parts[0]);
  }

  const splitByTopDirectory = !packName && topLevelDirectories.size > 1;
  const groups = new Map();

  for (const entry of entries) {
    const parts = entry.pathAfterRoot.split("/").filter(Boolean);
    let groupName;
    let sourceId;
    let pathInPack;

    if (packName) {
      groupName = packName;
      sourceId = packName;
      pathInPack = entry.pathAfterRoot;
    } else if (splitByTopDirectory && parts.length > 1) {
      groupName = parts[0];
      sourceId = commonRoot ? `${commonRoot}/${parts[0]}` : parts[0];
      pathInPack = parts.slice(1).join("/");
    } else {
      groupName = commonRoot || (parts.length > 1 ? parts[0] : "Imported Tiles");
      sourceId = groupName;
      pathInPack = entry.pathAfterRoot;
    }

    pathInPack = normalizeRelativeFilePath(pathInPack || entry.file.name);
    if (!groups.has(groupName)) {
      groups.set(groupName, {
        name: groupName,
        sourceId,
        files: []
      });
    }

    groups.get(groupName).files.push({
      ...entry,
      pathInPack
    });
  }

  return Array.from(groups.values())
    .filter((group) => group.files.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function detectCommonRootFolder(files) {
  if (!files.length) return "";
  const paths = files.map(({ relativePath }) => normalizeRelativeFilePath(relativePath));
  if (paths.some((path) => !path.includes("/"))) return "";

  const root = paths[0].split("/")[0];
  return paths.every((path) => path.split("/")[0] === root) ? root : "";
}

function stripLeadingPathSegment(relativePath) {
  const parts = normalizeRelativeFilePath(relativePath).split("/").filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? relativePath;
  return parts.slice(1).join("/");
}

function makeUniqueFolderPackId(name, usedPackIds) {
  const base = makeFolderPackId(name);
  const existingName = usedPackIds.get(base);
  if (!existingName || existingName === name) {
    usedPackIds.set(base, name);
    return base;
  }

  const unique = `${base}-${hashString(name).slice(0, 8)}`;
  usedPackIds.set(unique, name);
  return unique;
}

function makeImportedPackId(parsed, file, library) {
  const base = sanitizePathSegment(parsed.pack.id || parsed.packId || stripExtension(file.name));
  const existing = library.packs[base];
  if (!existing) return base;
  if (existing.sourceFileName) {
    if (existing.sourceFileName === file.name) return base;
  } else if (existing.sourceId === parsed.packId && existing.name === (parsed.pack.name || stripExtension(file.name))) {
    return base;
  }

  const nameSlug = sanitizePathSegment(stripExtension(file.name));
  const unique = `${base}-${hashString(`${parsed.packId}:${file.name}:${nameSlug}`).slice(0, 8)}`;
  const uniqueExisting = library.packs[unique];
  if (!uniqueExisting || uniqueExisting.sourceFileName === file.name) return unique;

  return `${base}-${hashString(`${parsed.packId}:${file.name}:${Date.now()}`).slice(0, 8)}`;
}

function makeFolderPackId(name) {
  const slug = sanitizePathSegment(name);
  if (slug === "pack" && String(name).trim().toLowerCase() !== "pack") {
    return `folder-${hashString(name).slice(0, 8)}`;
  }
  return sanitizePathSegment(`folder-${name}`);
}

function getDirectoryTags(relativePath) {
  const parts = normalizeRelativeFilePath(relativePath).split("/");
  parts.pop();
  return parts
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeRelativeFilePath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function sanitizePathSegment(value) {
  return String(value || "pack")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "pack";
}

function sanitizeFileName(value) {
  return String(value)
    .replace(/[<>:"\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFoundryPath(path) {
  return String(path).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function mimeTypeForFileName(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".avif")) return "image/avif";
  return "application/octet-stream";
}

function normalizeColor(color) {
  const value = String(color || "#ffffff").replace(/^#/, "").toLowerCase();
  return /^[0-9a-f]{6}$/.test(value) ? value : "ffffff";
}

function hexToRgb(color) {
  const clean = normalizeColor(color);
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16)
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
