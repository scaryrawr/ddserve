export interface TableColumn<T> {
  header: string;
  value(row: T): string | number | undefined;
}

export function formatTable<T>(rows: T[], columns: TableColumn<T>[]): string {
  if (rows.length === 0) {
    return "";
  }

  const rendered = rows.map((row) => columns.map((column) => String(column.value(row) ?? "")));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rendered.map((row) => row[index]?.length ?? 0)),
  );
  const lines = [
    columns.map((column, index) => column.header.padEnd(widths[index] ?? column.header.length)).join("  "),
    columns.map((column, index) => "-".repeat(widths[index] ?? column.header.length)).join("  "),
    ...rendered.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ")),
  ];

  return lines.join("\n");
}

export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number") {
    return "";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value /= 1024;
  }

  return `${value.toFixed(1)} TB`;
}
