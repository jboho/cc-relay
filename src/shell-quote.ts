export function shellQuote(value: string): string {
  // Safe characters that don't need quoting in bash
  if (/^[A-Za-z0-9_\/.,:@%=+\-]+$/.test(value)) {
    return value;
  }
  // Wrap in single quotes; internal single quotes become '\''
  const escaped = value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}
