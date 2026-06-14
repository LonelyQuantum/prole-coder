import type { RpcRecoverableAction } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

export const CONFIGURE_DEEPSEEK_API_KEY_ACTION_KIND = "configureDeepSeekApiKey";
export const CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL = "Configure API Key";

export interface ConfigureDeepSeekApiKeyAction {
  readonly type: typeof CONFIGURE_DEEPSEEK_API_KEY_ACTION_KIND;
  readonly label: string;
}

export type ProviderConfigurationAction = ConfigureDeepSeekApiKeyAction;

export function providerConfigurationActionFromError(
  error: unknown,
): ProviderConfigurationAction | undefined {
  const data = isRecord(error) ? error["data"] : undefined;
  return providerConfigurationActionFromData(data);
}

export function providerConfigurationActionFromPayload(
  payload: unknown,
): ProviderConfigurationAction | undefined {
  return providerConfigurationActionFromData(payload);
}

export function providerConfigurationActionFromMetadata(
  metadata: unknown,
): ProviderConfigurationAction | undefined {
  const action = isRecord(metadata) ? metadata["providerConfigurationAction"] : undefined;
  return actionFromProviderConfigurationAction(action) ??
    providerConfigurationActionFromData({ recoverableAction: action });
}

export function providerConfigurationActionFromData(
  data: unknown,
): ProviderConfigurationAction | undefined {
  const record = isRecord(data) ? data : undefined;
  return actionFromRecoverableAction(record?.["recoverableAction"]);
}

export function isConfigureDeepSeekApiKeyAction(
  action: ProviderConfigurationAction | undefined,
): action is ConfigureDeepSeekApiKeyAction {
  return action?.type === CONFIGURE_DEEPSEEK_API_KEY_ACTION_KIND;
}

function actionFromRecoverableAction(
  action: unknown,
): ProviderConfigurationAction | undefined {
  if (!isRecoverableAction(action)) {
    return undefined;
  }

  if (action.kind === CONFIGURE_DEEPSEEK_API_KEY_ACTION_KIND) {
    return {
      type: CONFIGURE_DEEPSEEK_API_KEY_ACTION_KIND,
      label: action.label.length > 0 ? action.label : CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
    };
  }

  return undefined;
}

function actionFromProviderConfigurationAction(
  action: unknown,
): ProviderConfigurationAction | undefined {
  if (
    isRecord(action) &&
    action["type"] === CONFIGURE_DEEPSEEK_API_KEY_ACTION_KIND &&
    typeof action["label"] === "string"
  ) {
    return {
      type: CONFIGURE_DEEPSEEK_API_KEY_ACTION_KIND,
      label: action["label"].length > 0
        ? action["label"]
        : CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
    };
  }

  return undefined;
}

function isRecoverableAction(value: unknown): value is RpcRecoverableAction {
  return (
    isRecord(value) &&
    value["kind"] === CONFIGURE_DEEPSEEK_API_KEY_ACTION_KIND &&
    typeof value["label"] === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
