export interface MessageRedactor {
  redact(message: string): string;
}

export class MutableSecretRedactor implements MessageRedactor {
  private secretValues: readonly string[] = [];

  update(secretValues: readonly string[]): void {
    this.secretValues = uniqueSecrets(secretValues);
  }

  redact(message: string): string {
    let redacted = message;
    for (const secret of this.secretValues) {
      redacted = redacted.replaceAll(secret, "[redacted]");
    }
    return redacted;
  }
}

export const passthroughRedactor: MessageRedactor = {
  redact(message) {
    return message;
  },
};

function uniqueSecrets(secretValues: readonly string[]): readonly string[] {
  const values = new Set<string>();
  for (const value of secretValues) {
    const normalized = value.trim();
    if (normalized.length > 0) {
      values.add(normalized);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}
