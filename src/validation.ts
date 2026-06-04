import { DdserveError } from "./errors";

export function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new DdserveError(`Invalid ${label}: value must not be empty`);
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DdserveError(`Invalid ${label}: expected a positive integer`);
  }
}

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DdserveError(`Invalid ${label}: expected a non-negative integer`);
  }
}
