const TEXT_DECODER = new TextDecoder("utf-8");

const TARGET_PATH_RE = /^res:\/\/packs\/([^/]+)\/(.+)$/;
const OBJECT_TEXTURE_RE = /^textures\/objects\/.+\.(webp|png)$/i;

export class PckFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "PckFormatError";
  }
}

export async function parseDungeondraftPack(file) {
  const buffer = await file.arrayBuffer();
  const reader = new PckReader(buffer);
  const entries = reader.readIndex();
  const targeted = collectDungeondraftEntries(entries);

  if (!targeted.packId) {
    throw new PckFormatError("This pack does not contain a Dungeondraft pack folder.");
  }

  const packJson = readJsonEntry(reader, targeted.packJson, "pack.json");
  const tagsJson = targeted.tags ? readJsonEntry(reader, targeted.tags, "default.dungeondraft_tags") : {};

  return {
    fileName: file.name,
    packId: targeted.packId,
    pack: packJson,
    tags: tagsJson,
    preview: targeted.preview ? reader.entryBlob(targeted.preview) : null,
    objects: targeted.objects.map((entry) => ({
      entry,
      path: entry.relativePath,
      blob: reader.entryBlob(entry)
    }))
  };
}

class PckReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.offset = 0;
  }

  readIndex() {
    const magic = this.readAscii(4);
    if (magic !== "GDPC") {
      throw new PckFormatError("Unsupported pack format. Expected GDPC header.");
    }

    const formatVersion = this.readU32();
    const engineMajor = this.readU32();
    const engineMinor = this.readU32();
    const enginePatch = this.readU32();

    if (formatVersion !== 1) {
      throw new PckFormatError(`Unsupported Godot pack version ${formatVersion}.`);
    }

    for (let i = 0; i < 16; i += 1) this.readU32();

    const fileCount = this.readU32();
    const entries = [];

    for (let i = 0; i < fileCount; i += 1) {
      const pathLength = this.readU32();
      const path = this.readUtf8(pathLength);
      const dataOffset = this.readU64();
      const size = this.readU64();
      const md5 = new Uint8Array(this.buffer, this.offset, 16);
      this.offset += 16;

      if (dataOffset + size > this.buffer.byteLength) {
        throw new PckFormatError(`Entry ${path} points outside the pack data.`);
      }

      entries.push({
        path,
        dataOffset,
        size,
        md5: Array.from(md5, (byte) => byte.toString(16).padStart(2, "0")).join("")
      });
    }

    return {
      formatVersion,
      engineVersion: `${engineMajor}.${engineMinor}.${enginePatch}`,
      entries
    };
  }

  entryBlob(entry) {
    return new Blob([this.buffer.slice(entry.dataOffset, entry.dataOffset + entry.size)], {
      type: mimeTypeForPath(entry.path)
    });
  }

  readAscii(length) {
    const bytes = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return String.fromCharCode(...bytes);
  }

  readUtf8(length) {
    const bytes = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return TEXT_DECODER.decode(bytes);
  }

  readU32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readU64() {
    let value;
    if (typeof this.view.getBigUint64 === "function") {
      value = Number(this.view.getBigUint64(this.offset, true));
    } else {
      const lo = this.view.getUint32(this.offset, true);
      const hi = this.view.getUint32(this.offset + 4, true);
      value = (hi * 0x100000000) + lo;
    }
    this.offset += 8;

    if (!Number.isSafeInteger(value)) {
      throw new PckFormatError("Pack entry offset is too large for this browser.");
    }
    return value;
  }
}

function collectDungeondraftEntries(index) {
  const result = {
    packId: null,
    packJson: null,
    tags: null,
    preview: null,
    objects: []
  };

  for (const entry of index.entries) {
    const match = entry.path.match(TARGET_PATH_RE);
    if (!match) continue;

    const [, packId, relativePath] = match;
    result.packId ??= packId;
    if (packId !== result.packId) continue;

    entry.packId = packId;
    entry.relativePath = relativePath;

    if (relativePath === "pack.json") result.packJson = entry;
    else if (relativePath === "data/default.dungeondraft_tags") result.tags = entry;
    else if (relativePath === "preview.png") result.preview = entry;
    else if (OBJECT_TEXTURE_RE.test(relativePath)) result.objects.push(entry);
  }

  if (!result.packJson) {
    throw new PckFormatError("Dungeondraft pack metadata pack.json was not found.");
  }

  return result;
}

function readJsonEntry(reader, entry, label) {
  if (!entry) return {};
  const bytes = new Uint8Array(reader.buffer, entry.dataOffset, entry.size);
  const text = TEXT_DECODER.decode(bytes).replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text);
  } catch (error) {
    const normalized = stripJsonTrailingCommas(text);
    if (normalized !== text) {
      try {
        return JSON.parse(normalized);
      } catch {
        // Report the original parse error because it points to the source file.
      }
    }
    throw new PckFormatError(`Could not parse ${label}: ${error.message}`);
  }
}

function stripJsonTrailingCommas(text) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      result += character;
      continue;
    }

    if (character === ",") {
      let nextIndex = index + 1;
      while (nextIndex < text.length && /\s/.test(text[nextIndex])) nextIndex += 1;
      if (text[nextIndex] === "}" || text[nextIndex] === "]") continue;
    }

    result += character;
  }

  return result;
}

function mimeTypeForPath(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".json") || lower.endsWith(".dungeondraft_tags")) return "application/json";
  return "application/octet-stream";
}
