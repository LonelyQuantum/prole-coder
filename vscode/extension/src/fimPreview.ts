import type { FimPreviewParams, ServerCapabilities } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

export interface FimPreviewRequestInput {
  readonly text: string;
  readonly offset: number;
  readonly path?: string;
  readonly languageId?: string;
  readonly configuredModel?: string;
  readonly maxTokens?: number;
  readonly maxContextChars: number;
  readonly capabilities: ServerCapabilities;
}

export function buildFimPreviewParams(input: FimPreviewRequestInput): FimPreviewParams | undefined {
  if (input.offset < 0 || input.offset > input.text.length || input.maxContextChars < 1) {
    return undefined;
  }

  const model = selectFimModel(input.capabilities, input.configuredModel);
  if (model === undefined) {
    return undefined;
  }

  const prefixStart = Math.max(0, input.offset - input.maxContextChars);
  const suffixEnd = Math.min(input.text.length, input.offset + input.maxContextChars);
  const prefix = input.text.slice(prefixStart, input.offset);
  if (prefix.trim().length === 0) {
    return undefined;
  }

  const suffix = input.text.slice(input.offset, suffixEnd);
  return {
    prefix,
    ...(suffix.length === 0 ? {} : { suffix }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.languageId === undefined ? {} : { languageId: input.languageId }),
    model,
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
  };
}

export function selectFimModel(
  capabilities: ServerCapabilities,
  configuredModel?: string,
): string | undefined {
  if (configuredModel !== undefined && configuredModel.trim().length > 0) {
    const configured = capabilities.provider.models.find((model) => model.id === configuredModel.trim());
    return configured?.supportsFim === true ? configured.id : undefined;
  }

  const defaultModel = capabilities.provider.models.find(
    (model) => model.id === capabilities.provider.defaultModel,
  );
  return defaultModel?.supportsFim === true ? defaultModel.id : undefined;
}

