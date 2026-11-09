import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import {
  AXML_MANIFEST_EVENTS,
  buildAxml,
  type AxmlEvent,
} from "../../tests/fixtures/axml.js";

import type {
  ArtifactEntry,
  ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { hasAxmlHeader, readAxmlHeaderFacts } from "../domain/axmlFormat.js";
import { AxmlArtifactReader } from "./AxmlArtifactReader.js";

const writeDocument = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-axml-"),
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

describe("hasAxmlHeader", () => {
  it("recognizes the RES_XML_TYPE preamble only", () => {
    expect(hasAxmlHeader(buildAxml(AXML_MANIFEST_EVENTS))).toBe(true);
    expect(hasAxmlHeader(buildAxml(AXML_MANIFEST_EVENTS, { utf8: true }))).toBe(
      true,
    );
    expect(hasAxmlHeader(Buffer.from("PK\x03\x04"))).toBe(false);
    expect(hasAxmlHeader(Buffer.alloc(4))).toBe(false);
    // Malformed documents keep format identity; the decoder reports details.
    expect(
      hasAxmlHeader(Buffer.from([0x03, 0x00, 0x08, 0x00, 1, 2, 3, 4])),
    ).toBe(true);
    expect(
      hasAxmlHeader(Buffer.from([0x03, 0x00, 0x09, 0x00, 1, 2, 3, 4])),
    ).toBe(false);
  });
});

describe("readAxmlHeaderFacts", () => {
  it("reads the declared document size", () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS);
    expect(readAxmlHeaderFacts(bytes)).toEqual({
      declaredSize: bytes.length,
    });
    expect(readAxmlHeaderFacts(Buffer.alloc(32))).toBeUndefined();
  });
});

describe("AxmlArtifactReader", () => {
  it("decodes a manifest-shaped document into XML text", async () => {
    await withReader(buildAxml(AXML_MANIFEST_EVENTS), async (reader) => {
      const entries = await list(reader);
      expect(entries.map((entry) => entry.path)).toEqual(["document.xml"]);
      const metadata = reader.formatMetadata();
      expect(metadata).toMatchObject({
        kind: "axml",
        element_count: 3,
        attribute_count: 5,
        namespace_count: 1,
        declared_size: buildAxml(AXML_MANIFEST_EVENTS).length,
      });
      const xml = await text(await reader.open(entries[0]!));
      expect(xml).toContain('package="com.example.app"');
      expect(xml).toContain('android:versionCode="3"');
      expect(xml).toContain('android:versionName="1.0"');
      expect(xml).toContain(
        'xmlns:android="http://schemas.android.com/apk/res/android"',
      );
      expect(xml).toContain(
        '<activity android:name=".MainActivity" android:exported="true"/>',
      );
      expect(xml).toContain("</manifest>");
    });
  });

  it("renders every typed attribute value literally", async () => {
    const ANDROID = "http://schemas.android.com/apk/res/android";
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "android", uri: ANDROID },
      {
        kind: "start",
        name: "uses-sdk",
        attrs: [
          { name: "minSdkVersion", ns: ANDROID, typed: [0x10, 24] },
          { name: "targetSdk", ns: ANDROID, typed: [0x11, 0x22] },
          { name: "required", ns: ANDROID, typed: [0x12, 0] },
          { name: "theme", ns: ANDROID, typed: [0x01, 0x7f0a0012] },
          { name: "color", ns: ANDROID, typed: [0x1d, 0xff336699] },
          { name: "label", ns: ANDROID, typed: [0x03, 0] },
        ],
      },
      { kind: "end", name: "uses-sdk" },
      { kind: "endNs", prefix: "android", uri: ANDROID },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('android:minSdkVersion="24"');
      expect(xml).toContain('android:targetSdk="0x00000022"');
      expect(xml).toContain('android:required="false"');
      expect(xml).toContain('android:theme="@0x7f0a0012"');
      expect(xml).toContain('android:color="#ff336699"');
    });
  });

  it("uses the resource map for android-prefixed names without a URI", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "activity",
        attrs: [{ name: "name", value: ".Main" }],
      },
      { kind: "end", name: "activity" },
    ];
    await withReader(
      buildAxml(events, { resourceIds: { name: 0x01010003 } }),
      async (reader) => {
        const xml = await text(await reader.open((await list(reader))[0]!));
        expect(xml).toContain('android:name=".Main"');
      },
    );
  });

  it("rejects a carrier truncated inside a chunk", async () => {
    const full = buildAxml(AXML_MANIFEST_EVENTS);
    await withReader(full.subarray(0, full.length - 12), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects malformed chunk streams as typed format failures", async () => {
    const cases: Record<string, Buffer> = {
      "missing string pool": Buffer.from([
        0x03, 0x00, 0x08, 0x00, 0x10, 0x00, 0x00, 0x00, 0x03, 0x01, 0x08, 0x00,
        0x08, 0x00, 0x00, 0x00,
      ]),
      "header only": Buffer.from([
        0x03, 0x00, 0x08, 0x00, 0x08, 0x00, 0x00, 0x00,
      ]),
      "bad declared size": (() => {
        const b = buildAxml(AXML_MANIFEST_EVENTS);
        b.writeUInt32LE(4, 4);
        return b;
      })(),
      "duplicate string pool": (() => {
        const b = buildAxml(AXML_MANIFEST_EVENTS);
        const poolBytes = b.subarray(8, 8 + b.readUInt32LE(12));
        return buildAxml(AXML_MANIFEST_EVENTS, { tailChunks: [poolBytes] });
      })(),
      "unclosed element": buildAxml([{ kind: "start", name: "manifest" }]),
      "mismatched end": buildAxml([
        { kind: "start", name: "manifest" },
        { kind: "end", name: "other" },
      ]),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      await withReader(bytes, async (reader) => {
        await expect(list(reader), name).rejects.toMatchObject({
          reason: "format",
        });
      });
    }
  });
});

describe("axml inventory", () => {
  it("classifies and inventories the document via the canonical scan", async () => {
    const inventory = await scanCanonicalArtifactInventory(
      await writeDocument(buildAxml(AXML_MANIFEST_EVENTS)),
    );
    expect(inventory.manifest.root_format).toBe("axml");
    expect(inventory.coverage.status).toBe("complete");
    expect(inventory.occurrences.map((row) => row.logical_path).sort()).toEqual(
      [".", "document.xml"],
    );
  });
});
