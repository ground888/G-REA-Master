import { err, ok, type Result } from "../result.js";
import {
  AXML_CHUNK_HEADER_BYTES,
  AXML_CHUNK_TYPE,
  AXML_HEADER_BYTES,
} from "../axmlFormat.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/**
 * Android binary XML decoder: parses the ResXMLTree chunk stream (string
 * pool, resource map, element tree) and renders the deterministic XML text.
 * Names, values and structure come only from declared data; typed values are
 * rendered literally and unresolved resource references stay numeric.
 */
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0180;
const CHUNK_START_NAMESPACE = 0x0100;
const CHUNK_END_NAMESPACE = 0x0101;
const CHUNK_START_ELEMENT = 0x0102;
const CHUNK_END_ELEMENT = 0x0103;
const CHUNK_CDATA = 0x0104;

const STRING_POOL_UTF8 = 0x00000100;
const NO_INDEX = 0xffffffff;
const ANDROID_NS_URI = "http://schemas.android.com/apk/res/android";
const ANDROID_ATTR_ID_MIN = 0x01010000;
const ANDROID_ATTR_ID_MAX = 0x0101ffff;

const TYPE_NULL = 0x00;
const TYPE_REFERENCE = 0x01;
const TYPE_ATTRIBUTE = 0x02;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_DIMENSION = 0x05;
const TYPE_FRACTION = 0x06;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;
const TYPE_FIRST_COLOR_INT = 0x1c;
const TYPE_LAST_COLOR_INT = 0x1f;

const AXML_MAX_FILE_BYTES = 64 * 1024 * 1024;
const AXML_MAX_STRINGS = 0x40000;
const AXML_MAX_STRING_BYTES = 16 * 1024 * 1024;
const AXML_MAX_ELEMENTS = 0x40000;
const AXML_MAX_ATTRIBUTES = 0x100000;
const AXML_MAX_NAMESPACES = 0x8000;
const AXML_MAX_DEPTH = 4096;
const AXML_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const NODE_HEADER_BYTES = 16;
/** Fixed attrExt fields after the node header: ns, name and the six u16s. */
const ATTR_EXT_HEADER_BYTES = 20;
const ATTRIBUTE_BYTES = 20;

const RADIX_MULTS = [1e-6, 1e-15, 1e-24, 1e-3];
const DIMENSION_UNITS = ["px", "dip", "sp", "pt", "in", "mm"];
const FRACTION_UNITS = ["%", "%p"];

interface ChunkHeader {
  readonly type: number;
  readonly headerSize: number;
  readonly size: number;
}

export interface AxmlDocumentImage {
  readonly metadata: {
    readonly string_count: number;
    readonly style_count: number;
    readonly utf8: boolean;
    readonly resource_map_count: number;
    readonly element_count: number;
    readonly attribute_count: number;
    readonly namespace_count: number;
    readonly declared_size: number;
  };
  /** The deterministic decoded XML text as UTF-8 bytes. */
  readonly xml: Uint8Array;
  /** Every declared chunk was walked to the declared document size. */
  readonly terminated: boolean;
  readonly limitations: readonly string[];
}

const formatFailure = (message: string): Result<never, RegionDecodeFailure> =>
  err({ kind: "format", message });

const limitFailure = (message: string): Result<never, RegionDecodeFailure> =>
  err({ kind: "limit", message, boundary: "capacity" });

const NO_PREFIX = "";

class StringPool {
  readonly utf8: boolean;
  readonly styleCount: number;
  readonly #strings: string[];

  private constructor(utf8: boolean, styleCount: number, strings: string[]) {
    this.utf8 = utf8;
    this.styleCount = styleCount;
    this.#strings = strings;
  }

  get count(): number {
    return this.#strings.length;
  }

  /** Undefined for the 0xFFFFFFFF no-index; null for an out-of-range index. */
  get(index: number): string | undefined | null {
    if (index === NO_INDEX) return undefined;
    return index < this.#strings.length ? (this.#strings[index] ?? null) : null;
  }

  static parse(
    view: DataView,
    base: number,
    header: ChunkHeader,
    bufferEnd: number,
  ): Result<StringPool, RegionDecodeFailure> {
    if (header.headerSize < 28)
      return formatFailure(
        `string pool header ${header.headerSize} is below the fixed 28 bytes`,
      );
    const stringCount = view.getUint32(base + 8, true);
    const styleCount = view.getUint32(base + 12, true);
    const flags = view.getUint32(base + 16, true);
    const stringsStart = view.getUint32(base + 20, true);
    const stylesStart = view.getUint32(base + 24, true);
    if (stringCount > AXML_MAX_STRINGS)
      return limitFailure(
        `string pool declares ${stringCount} strings above the ${AXML_MAX_STRINGS} bound`,
      );
    if (styleCount > stringCount)
      return formatFailure(
        `style count ${styleCount} exceeds string count ${stringCount}`,
      );
    const offsetTableEnd = base + header.headerSize + stringCount * 4;
    if (offsetTableEnd > base + header.size)
      return formatFailure(
        "string pool offset table extends past the chunk end",
      );
    const dataStart = base + stringsStart;
    const dataEnd = stylesStart !== 0 ? base + stylesStart : base + header.size;
    if (
      dataStart < offsetTableEnd ||
      dataStart > dataEnd ||
      dataEnd > bufferEnd
    )
      return formatFailure("string pool data lies outside the declared chunk");
    const utf8 = (flags & STRING_POOL_UTF8) !== 0;
    const strings: string[] = new Array(stringCount);
    let retained = 0;
    for (let i = 0; i < stringCount; i++) {
      const rel = view.getUint32(base + header.headerSize + i * 4, true);
      const at = dataStart + rel;
      if (at >= dataEnd)
        return formatFailure(
          `string ${i} offset points outside the string data`,
        );
      const decoded = utf8
        ? readUtf8String(view, at, dataEnd)
        : readUtf16String(view, at, dataEnd);
      if (decoded === undefined)
        return formatFailure(`string ${i} is truncated`);
      retained += decoded.length;
      if (retained > AXML_MAX_STRING_BYTES)
        return limitFailure(
          `string data exceeds the ${AXML_MAX_STRING_BYTES}-byte bound`,
        );
      strings[i] = decoded;
    }
    return ok(new StringPool(utf8, styleCount, strings));
  }
}

const readUtf16String = (
  view: DataView,
  at: number,
  end: number,
): string | undefined => {
  if (at + 2 > end) return undefined;
  let len = view.getUint16(at, true);
  let cursor = at + 2;
  if ((len & 0x8000) !== 0) {
    if (cursor + 2 > end) return undefined;
    len = ((len & 0x7fff) << 16) | view.getUint16(cursor, true);
    cursor += 2;
  }
  if (cursor + len * 2 > end) return undefined;
  return new TextDecoder("utf-16le").decode(
    new Uint8Array(view.buffer, view.byteOffset + cursor, len * 2),
  );
};

const readUtf8String = (
  view: DataView,
  at: number,
  end: number,
): string | undefined => {
  let cursor = at;
  if (cursor >= end) return undefined;
  // The first length spec (UTF-16 units) is skipped; the second counts bytes.
  let len16 = view.getUint8(cursor);
  cursor += 1;
  if ((len16 & 0x80) !== 0) {
    if (cursor >= end) return undefined;
    len16 = ((len16 & 0x7f) << 8) | view.getUint8(cursor);
    cursor += 1;
  }
  let len8 = view.getUint8(cursor);
  cursor += 1;
  if ((len8 & 0x80) !== 0) {
    if (cursor >= end) return undefined;
    len8 = ((len8 & 0x7f) << 8) | view.getUint8(cursor);
    cursor += 1;
  }
  if (cursor + len8 > end) return undefined;
  return new TextDecoder("utf-8").decode(
    new Uint8Array(view.buffer, view.byteOffset + cursor, len8),
  );
};

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeAttr = (text: string): string =>
  escapeXml(text).replaceAll('"', "&quot;");

const hexRef = (data: number): string =>
  `0x${(data >>> 0).toString(16).padStart(8, "0")}`;

const complexToFloat = (data: number): number => {
  const mantissa = (data >> 8) & 0xffffff;
  const signed = (mantissa & 0x800000) !== 0 ? mantissa - 0x1000000 : mantissa;
  return signed * (RADIX_MULTS[(data >> 4) & 0x3] ?? 0);
};

const renderTypedValue = (
  type: number,
  data: number,
  pool: StringPool,
): string | undefined => {
  switch (type) {
    case TYPE_NULL:
      return data === 0 ? "" : `@null`;
    case TYPE_STRING: {
      const value = pool.get(data);
      return value === undefined || value === null ? undefined : value;
    }
    case TYPE_REFERENCE:
      return data === 0 ? "@null" : `@${hexRef(data)}`;
    case TYPE_ATTRIBUTE:
      return `?${hexRef(data)}`;
    case TYPE_FLOAT:
      return new DataView(new Uint32Array([data]).buffer)
        .getFloat32(0, true)
        .toString();
    case TYPE_DIMENSION: {
      const unit = DIMENSION_UNITS[data & 0xf] ?? "";
      return `${complexToFloat(data)}${unit}`;
    }
    case TYPE_FRACTION: {
      const unit = FRACTION_UNITS[data & 0xf] ?? "";
      return `${complexToFloat(data) * 100}${unit}`;
    }
    case TYPE_INT_DEC:
      return (data | 0).toString();
    case TYPE_INT_HEX:
      return hexRef(data);
    case TYPE_INT_BOOLEAN:
      return data === 0 ? "false" : "true";
    default:
      if (type >= TYPE_FIRST_COLOR_INT && type <= TYPE_LAST_COLOR_INT)
        return `#${(data >>> 0).toString(16).padStart(8, "0")}`;
      return hexRef(data);
  }
};

const formatError = (message: string): RegionDecodeFailure => ({
  kind: "format",
  message,
});

class BufferedAxmlDecoder implements RegionDecoder<AxmlDocumentImage> {
  #bytes = new Uint8Array(0);

  constructor(private readonly fileBytes: number) {}

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    if (this.#bytes.length + chunk.length > AXML_MAX_FILE_BYTES)
      return err({
        kind: "limit",
        message: `AXML input exceeds the ${AXML_MAX_FILE_BYTES}-byte bound`,
        boundary: "capacity",
      });
    const grown = new Uint8Array(this.#bytes.length + chunk.length);
    grown.set(this.#bytes);
    grown.set(chunk, this.#bytes.length);
    this.#bytes = grown;
    return ok(undefined);
  }

  finish(): Result<AxmlDocumentImage, RegionDecodeFailure> {
    const bytes = this.#bytes;
    if (bytes.length < AXML_HEADER_BYTES)
      return formatFailure("AXML document is shorter than the 8-byte header");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    if (
      view.getUint16(0, true) !== AXML_CHUNK_TYPE ||
      view.getUint16(2, true) !== AXML_HEADER_BYTES
    )
      return formatFailure("missing RES_XML_TYPE header");
    const declaredSize = view.getUint32(4, true);
    if (declaredSize < AXML_HEADER_BYTES)
      return formatFailure(
        `declared size ${declaredSize} is below the fixed header`,
      );
    const limitations: string[] = [];
    let documentEnd = declaredSize;
    if (declaredSize > bytes.length) {
      limitations.push(
        `document declares ${declaredSize} bytes; only ${bytes.length} were admitted`,
      );
      documentEnd = bytes.length;
    }

    const readChunk = (
      at: number,
    ): Result<ChunkHeader, RegionDecodeFailure> => {
      if (at + AXML_CHUNK_HEADER_BYTES > documentEnd)
        return formatFailure(`chunk header at ${at} is truncated`);
      const type = view.getUint16(at, true);
      const headerSize = view.getUint16(at + 2, true);
      const size = view.getUint32(at + 4, true);
      if (headerSize < AXML_CHUNK_HEADER_BYTES || size < headerSize)
        return formatFailure(
          `chunk 0x${type.toString(16)} at ${at} has impossible header ${headerSize}/size ${size}`,
        );
      if (at + size > documentEnd)
        return formatFailure(
          `chunk 0x${type.toString(16)} at ${at} extends past the declared document`,
        );
      return ok({ type, headerSize, size });
    };

    const first = readChunk(AXML_HEADER_BYTES);
    if (!first.ok) return first;
    if (first.value.type !== CHUNK_STRING_POOL)
      return formatFailure(
        `first chunk is 0x${first.value.type.toString(16)}, not the string pool`,
      );
    const poolResult = StringPool.parse(
      view,
      AXML_HEADER_BYTES,
      first.value,
      documentEnd,
    );
    if (!poolResult.ok) return poolResult;
    const pool = poolResult.value;

    let cursor = AXML_HEADER_BYTES + first.value.size;
    let resourceMap: readonly number[] = [];
    let resourceMapCount = 0;
    const namespaces = new Map<string, string>();
    const pendingNs: { prefix: string; uri: string }[] = [];
    let nsCount = 0;
    let elementCount = 0;
    let attributeCount = 0;
    const stack: { index: number; name: string }[] = [];
    const out: Uint8Array[] = [];
    let outBytes = 0;
    const emit = (text: string): Result<void, RegionDecodeFailure> => {
      const encoded = new TextEncoder().encode(text);
      outBytes += encoded.length;
      if (outBytes > AXML_MAX_OUTPUT_BYTES)
        return err({
          kind: "limit",
          message: `decoded XML exceeds the ${AXML_MAX_OUTPUT_BYTES}-byte bound`,
          boundary: "capacity",
        });
      out.push(encoded);
      return ok(undefined);
    };
    let pendingOpen = false;
    const flushOpen = (): Result<void, RegionDecodeFailure> => {
      if (pendingOpen) {
        const wrote = emit(">\n");
        if (!wrote.ok) return wrote;
        pendingOpen = false;
      }
      return ok(undefined);
    };

    const nameOf = (index: number): Result<string, RegionDecodeFailure> => {
      const name = pool.get(index);
      if (name === undefined) return okName(NO_PREFIX);
      if (name === null)
        return err(
          formatError(`name index ${index} is outside the string pool`),
        );
      return okName(name);
    };
    const okName = (name: string): Result<string, RegionDecodeFailure> =>
      ok(name);

    const prefixFor = (
      nsIndex: number,
      nameIndex: number,
    ): Result<string, RegionDecodeFailure> => {
      if (nsIndex !== NO_INDEX) {
        const uri = pool.get(nsIndex);
        if (uri === null || uri === undefined)
          return err(formatError(`namespace index ${nsIndex} is invalid`));
        const declared = namespaces.get(uri);
        if (declared !== undefined)
          return ok(declared === NO_PREFIX ? "" : `${declared}:`);
        if (uri === ANDROID_NS_URI) return ok("android:");
        return ok("");
      }
      if (
        nameIndex < resourceMap.length &&
        resourceMap[nameIndex]! >= ANDROID_ATTR_ID_MIN &&
        resourceMap[nameIndex]! <= ANDROID_ATTR_ID_MAX
      )
        return ok("android:");
      return ok("");
    };

    let terminated = true;
    let sawStringPoolEnd = false;
    while (cursor < documentEnd) {
      const chunk = readChunk(cursor);
      if (!chunk.ok) {
        if (
          cursor + AXML_CHUNK_HEADER_BYTES > documentEnd &&
          declaredSize > bytes.length
        ) {
          terminated = false;
          break;
        }
        return chunk;
      }
      const { type, headerSize, size } = chunk.value;
      const base = cursor;
      const next = cursor + size;

      if (type === CHUNK_STRING_POOL)
        return formatFailure("duplicate string pool chunk");
      if (type === CHUNK_RESOURCE_MAP) {
        const count = (size - headerSize) / 4;
        if (!Number.isInteger(count))
          return formatFailure("resource map size is not a whole u32 count");
        const map = new Array<number>(count);
        for (let i = 0; i < count; i++)
          map[i] = view.getUint32(base + headerSize + i * 4, true);
        resourceMap = map;
        resourceMapCount = count;
      } else if (type === CHUNK_START_NAMESPACE) {
        if (headerSize < NODE_HEADER_BYTES || size < NODE_HEADER_BYTES + 8)
          return formatFailure("namespace chunk is too small");
        const prefixIndex = view.getUint32(base + NODE_HEADER_BYTES, true);
        const uriIndex = view.getUint32(base + NODE_HEADER_BYTES + 4, true);
        const prefix = pool.get(prefixIndex);
        const uri = pool.get(uriIndex);
        if (prefix === null || uri === null || uri === undefined)
          return formatFailure("namespace declaration has invalid strings");
        nsCount++;
        if (nsCount > AXML_MAX_NAMESPACES)
          return limitFailure(
            `namespace count exceeds the ${AXML_MAX_NAMESPACES} bound`,
          );
        if (!namespaces.has(uri)) namespaces.set(uri, prefix ?? NO_PREFIX);
        pendingNs.push({ prefix: prefix ?? NO_PREFIX, uri });
      } else if (type === CHUNK_END_NAMESPACE) {
        // Prefix mappings stay declared; scope end does not invent names.
      } else if (type === CHUNK_START_ELEMENT) {
        if (
          headerSize < NODE_HEADER_BYTES ||
          size < NODE_HEADER_BYTES + ATTR_EXT_HEADER_BYTES
        )
          return formatFailure("start-element chunk is too small");
        const nsIndex = view.getUint32(base + NODE_HEADER_BYTES, true);
        const nameIndex = view.getUint32(base + NODE_HEADER_BYTES + 4, true);
        const attrStart = view.getUint16(base + NODE_HEADER_BYTES + 8, true);
        const attrSize = view.getUint16(base + NODE_HEADER_BYTES + 10, true);
        const attrCount = view.getUint16(base + NODE_HEADER_BYTES + 12, true);
        const nameResult = nameOf(nameIndex);
        if (!nameResult.ok) return nameResult;
        if (attrSize < ATTRIBUTE_BYTES)
          return formatFailure(
            `attribute record size ${attrSize} is below ${ATTRIBUTE_BYTES}`,
          );
        if (base + NODE_HEADER_BYTES + attrStart + attrCount * attrSize > next)
          return formatFailure("attribute records extend past the chunk end");
        if (stack.length >= AXML_MAX_DEPTH)
          return limitFailure(
            `element depth exceeds the ${AXML_MAX_DEPTH} bound`,
          );
        elementCount++;
        if (elementCount > AXML_MAX_ELEMENTS)
          return limitFailure(
            `element count exceeds the ${AXML_MAX_ELEMENTS} bound`,
          );
        const flushed = flushOpen();
        if (!flushed.ok) return flushed;
        const elemPrefix = prefixFor(nsIndex, NO_INDEX);
        if (!elemPrefix.ok) return elemPrefix;
        const indent = "  ".repeat(stack.length);
        const opened = emit(`${indent}<${elemPrefix.value}${nameResult.value}`);
        if (!opened.ok) return opened;
        while (pendingNs.length > 0) {
          const ns = pendingNs.shift()!;
          const attr =
            ns.prefix === NO_PREFIX
              ? ` xmlns="${escapeAttr(ns.uri)}"`
              : ` xmlns:${escapeAttr(ns.prefix)}="${escapeAttr(ns.uri)}"`;
          const wrote = emit(attr);
          if (!wrote.ok) return wrote;
        }
        for (let i = 0; i < attrCount; i++) {
          const at = base + NODE_HEADER_BYTES + attrStart + i * attrSize;
          const aNs = view.getUint32(at, true);
          const aNameIndex = view.getUint32(at + 4, true);
          const rawIndex = view.getUint32(at + 8, true);
          const aType = view.getUint8(at + 15);
          const aData = view.getUint32(at + 16, true);
          const aName = nameOf(aNameIndex);
          if (!aName.ok) return aName;
          const aPrefix = prefixFor(aNs, aNameIndex);
          if (!aPrefix.ok) return aPrefix;
          const raw = pool.get(rawIndex);
          const value =
            raw !== undefined && raw !== null
              ? raw
              : renderTypedValue(aType, aData, pool);
          if (value === undefined)
            return formatFailure(
              `attribute ${aNameIndex} value cannot be rendered`,
            );
          attributeCount++;
          if (attributeCount > AXML_MAX_ATTRIBUTES)
            return limitFailure(
              `attribute count exceeds the ${AXML_MAX_ATTRIBUTES} bound`,
            );
          const wrote = emit(
            ` ${aPrefix.value}${aName.value}="${escapeAttr(value)}"`,
          );
          if (!wrote.ok) return wrote;
        }
        stack.push({
          index: nameIndex,
          name: `${elemPrefix.value}${nameResult.value}`,
        });
        pendingOpen = true;
      } else if (type === CHUNK_END_ELEMENT) {
        if (headerSize < NODE_HEADER_BYTES || size < NODE_HEADER_BYTES + 8)
          return formatFailure("end-element chunk is too small");
        const nameIndex = view.getUint32(base + NODE_HEADER_BYTES + 4, true);
        const open = stack.pop();
        if (open === undefined)
          return formatFailure("end element without an open element");
        if (open.index !== nameIndex)
          return formatFailure(
            `end element name index ${nameIndex} does not match ${open.index}`,
          );
        if (pendingOpen) {
          const wrote = emit("/>\n");
          if (!wrote.ok) return wrote;
          pendingOpen = false;
        } else {
          const wrote = emit(`${"  ".repeat(stack.length)}</${open.name}>\n`);
          if (!wrote.ok) return wrote;
        }
      } else if (type === CHUNK_CDATA) {
        if (headerSize < NODE_HEADER_BYTES || size < NODE_HEADER_BYTES + 4)
          return formatFailure("cdata chunk is too small");
        const dataIndex = view.getUint32(base + NODE_HEADER_BYTES, true);
        const text = pool.get(dataIndex);
        if (text === null || text === undefined)
          return formatFailure("cdata payload is not a string");
        const flushed = flushOpen();
        if (!flushed.ok) return flushed;
        const wrote = emit(`${"  ".repeat(stack.length)}${escapeXml(text)}\n`);
        if (!wrote.ok) return wrote;
      }
      // Unknown chunks are skipped inside the declared extent.
      cursor = next;
      sawStringPoolEnd = true;
    }

    if (stack.length > 0)
      return formatFailure("document ends with open elements");
    if (cursor < documentEnd && declaredSize > bytes.length) terminated = false;
    if (!sawStringPoolEnd && first.value.size === 0)
      return formatFailure("string pool chunk is empty");

    const xml = new Uint8Array(outBytes);
    let offset = 0;
    for (const part of out) {
      xml.set(part, offset);
      offset += part.length;
    }
    return ok({
      metadata: {
        string_count: pool.count,
        style_count: pool.styleCount,
        utf8: pool.utf8,
        resource_map_count: resourceMapCount,
        element_count: elementCount,
        attribute_count: attributeCount,
        namespace_count: nsCount,
        declared_size: declaredSize,
      },
      xml,
      terminated: terminated && declaredSize <= bytes.length,
      limitations,
    });
  }
}

/**
 * Create a bounded buffered decoder for an admitted AXML carrier. The decoder
 * accumulates bytes up to the file bound and parses on finish.
 */
export const createAxmlDecoder = (
  fileBytes: number,
): Result<RegionDecoder<AxmlDocumentImage>, RegionDecodeFailure> => {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0)
    return err({ kind: "format", message: "invalid file size" });
  if (fileBytes > AXML_MAX_FILE_BYTES)
    return err({
      kind: "limit",
      message: `AXML file ${fileBytes} exceeds the ${AXML_MAX_FILE_BYTES}-byte bound`,
      boundary: "file-size",
    });
  return ok(new BufferedAxmlDecoder(fileBytes));
};
