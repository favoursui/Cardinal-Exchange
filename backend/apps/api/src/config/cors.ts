export function parseCorsOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value) throw new Error();
    return value;
  } catch {
    throw new Error('INVALID_CORS_ORIGIN');
  }
}
