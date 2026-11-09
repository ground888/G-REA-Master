import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  AXML_MANIFEST_EVENTS,
  buildAxml,
  type AxmlEvent,
} from "../../tests/fixtures/axml.js";

import type {
  ArtifactEntry,
  ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { AxmlArtifactReader } from "./AxmlArtifactReader.js";

const writeDocument = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-axml-boundary-"),
    "AndroidManifest.xml",
  );
  await writeFile(path, bytes);
  return path;
};

const list = async (
  reader: AxmlArtifactReader,
  options?: ArtifactTraversalOptions,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries(undefined, options))
    entries.push(entry);
  return entries;
};

const withReader = async <T>(
  bytes: Buffer,
  use: (reader: AxmlArtifactReader) => Promise<T>,
): Promise<T> => {
  const reader = new AxmlArtifactReader(await writeDocument(bytes));
  try {
    return await use(reader);
  } finally {
    await reader.close();
  }
};

describe("axml decoder limits", () => {
  it("fails closed on an over-limit string count", async () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS);
    // stringCount is the first u32 of the string-pool chunk at offset 16.
    bytes.writeUInt32LE(0x40001, 16);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
    });
  });

  it("fails closed on over-limit element depth", async () => {
    const depth = 4097;
    const events: AxmlEvent[] = [];
    for (let i = 0; i < depth; i++)
      events.push({ kind: "start", name: `n${i}` });
    for (let i = depth - 1; i >= 0; i--)
      events.push({ kind: "end", name: `n${i}` });
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
    });
  });

  it("fails closed on an over-limit declared file", async () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS, {
      declaredSize: 64 * 1024 * 1024 + 1,
    });
    // A padded carrier larger than the bound refuses before parsing.
    const padded = Buffer.alloc(64 * 1024 * 1024 + 1);
    bytes.copy(padded, 0);
    await withReader(padded, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
      });
    });
  });
});

describe("axml malformed extents", () => {
  it("rejects attribute records extending past the chunk end", async () => {
    const bytes = buildAxml([
      {
        kind: "start",
        name: "manifest",
        attrs: [{ name: "package", value: "com.example" }],
      },
      { kind: "end", name: "manifest" },
    ]);
    // attrCount sits at +12 inside the start-element ext (chunk+28); the pool
    // chunk size is declared at offset 12 and the element chunk follows it.
    const startElement = 8 + bytes.readUInt32LE(12);
    bytes.writeUInt16LE(0xffff, startElement + 28);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects a string offset outside the string data", async () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS);
    // First string offset lives at pool base + 28; push it past the pool end.
    bytes.writeUInt32LE(0x7fffffff, 8 + 28);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects a chunk extending past the declared document", async () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS, {
      declaredSize: 8 + 16,
    });
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });
});
