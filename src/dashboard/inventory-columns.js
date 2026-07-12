export const INVENTORY_COLUMNS = [
  { key: "name", width: 14, minPx: 120 },
  { key: "capability", width: 30, minPx: 220 },
  { key: "scope", width: 8, minPx: 72 },
  { key: "project", width: 16, minPx: 130 },
  { key: "agents", width: 17, minPx: 130 },
  { key: "source", width: 8, minPx: 82 },
  { key: "status", width: 7, minPx: 76 },
];

export function defaultColumnWidths(tableWidth) {
  return INVENTORY_COLUMNS.map((column) => Math.max(column.minPx, Math.round(tableWidth * column.width / 100)));
}

export function resizeColumn(widths, index, deltaPx) {
  const column = INVENTORY_COLUMNS[index];
  if (!column) return widths;
  const next = [...widths];
  next[index] = Math.max(column.minPx, widths[index] + deltaPx);
  return next;
}
