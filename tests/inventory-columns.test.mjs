import test from "node:test";
import assert from "node:assert/strict";
import { defaultColumnWidths, INVENTORY_COLUMNS, resizeColumn } from "../src/dashboard/inventory-columns.js";

test("inventory defaults allocate seven visible columns without a version column", () => {
  assert.equal(INVENTORY_COLUMNS.length, 7);
  assert.equal(INVENTORY_COLUMNS.some((column) => column.key === "version"), false);
  assert.equal(INVENTORY_COLUMNS.find((column) => column.key === "project").width, 16);
  assert.equal(INVENTORY_COLUMNS.reduce((sum, column) => sum + column.width, 0), 100);
});

test("resizing grows only the chosen column and preserves neighbour widths", () => {
  const widths = defaultColumnWidths(1000);
  const wider = resizeColumn(widths, 3, 180);
  assert.equal(wider[3], widths[3] + 180);
  assert.equal(wider[4], widths[4]);
  assert.equal(wider.reduce((sum, width) => sum + width, 0), widths.reduce((sum, width) => sum + width, 0) + 180);
  const clamped = resizeColumn(widths, 3, -500);
  assert.equal(clamped[3], INVENTORY_COLUMNS[3].minPx);
});
