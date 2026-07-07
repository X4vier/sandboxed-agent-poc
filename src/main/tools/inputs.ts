/** Runtime coercion helpers for tool inputs arriving from the model as unknown. */

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Tool input must be a JSON object.');
  }
  return input as Record<string, unknown>;
}

export function getString(input: unknown, field: string): string {
  const v = asRecord(input)[field];
  if (typeof v !== 'string') {
    throw new Error(`Parameter "${field}" is required and must be a string.`);
  }
  return v;
}

export function getOptionalString(input: unknown, field: string): string | undefined {
  const v = asRecord(input)[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new Error(`Parameter "${field}" must be a string when provided.`);
  }
  return v;
}

export function getOptionalInteger(input: unknown, field: string): number | undefined {
  const v = asRecord(input)[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`Parameter "${field}" must be an integer when provided.`);
  }
  return v;
}

export function getOptionalBoolean(input: unknown, field: string): boolean {
  const v = asRecord(input)[field];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') {
    throw new Error(`Parameter "${field}" must be a boolean when provided.`);
  }
  return v;
}
