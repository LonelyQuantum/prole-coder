export const CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL = "Configure API Key";

export function isDeepSeekApiKeyRequiredMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("deepseek") && normalized.includes("deepseek_api_key") && normalized.includes("required");
}
