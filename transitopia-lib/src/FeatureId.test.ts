import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  type CyclingWayId,
  type BicycleParkingId,
  parseIdString,
} from "./FeatureId.ts";
import { assertType } from "./utils/type-asserts.ts";

test("CyclingWayId", async (t) => {
  // ✅ valid cycling way IDs:
  for (const strInput of [
    "cycling/way/2342235",
    "cycling/way/way:2342235",
    "cycling/way/osm:way:2342235",
  ] as const) {
    await t.test(`parse "${strInput}"`, () => {
      const parsed = parseIdString(strInput);
      assert.deepStrictEqual(parsed, {
        domain: "cycling",
        type: "way",
        source: "osm",
        namespace: "way",
        identifier: "2342235",
      });
      // Because we used constant strings, TypeScript knows that the result is a Cycling Way ID:
      assertType<CyclingWayId>(parsed);
    });
  }
  // ❌ Invalid cycling way IDs:
  for (const strInput of [
    "cycling/way/notanumber",
    "cycling/way/way:notanumber",
    "cycling/way/foo:12345667",
    "cycling/way/osm:foo:12345667",
    "cycling/way/foo:way:12345667",
  ] as const) {
    await t.test(`parse "${strInput}" fails`, () => {
      assert.throws(
        () => {
          parseIdString(strInput);
        },
        { name: "ZodError" },
      );
    });
  }
});

test("BicycleParkingId", async (t) => {
  // ✅ valid bicycle parking location (node) IDs:
  for (const strInput of [
    "cycling/parking/node:12345667",
    "cycling/parking/osm:node:12345667",
  ] as const) {
    await t.test(`parse "${strInput}"`, () => {
      const parsed = parseIdString(strInput);
      assert.deepStrictEqual(parsed, {
        domain: "cycling",
        type: "parking",
        source: "osm",
        namespace: "node",
        identifier: "12345667",
      });
      assertType<BicycleParkingId>(parsed);
    });
  }
  // ✅ valid bicycle parking area (way) IDs:
  for (const strInput of [
    "cycling/parking/way:12345667",
    "cycling/parking/osm:way:12345667",
  ] as const) {
    await t.test(`parse "${strInput}"`, () => {
      const parsed = parseIdString(strInput);
      assert.deepStrictEqual(parsed, {
        domain: "cycling",
        type: "parking",
        source: "osm",
        namespace: "way",
        identifier: "12345667",
      });
      assertType<BicycleParkingId>(parsed);
    });
  }
  // ❌ Invalid bicycle parking IDs:
  for (const strInput of [
    "cycling/parking/12345667",
    "cycling/parking/way:notanumber",
    "cycling/parking/foo:12345667",
    "cycling/parking/osm:foo:12345667",
    "cycling/parking/foo:way:12345667",
  ] as const) {
    await t.test(`parse "${strInput}" fails`, () => {
      assert.throws(
        () => {
          parseIdString(strInput);
        },
        { name: "ZodError" },
      );
    });
  }
});
