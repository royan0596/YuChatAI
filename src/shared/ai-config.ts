import type { AppSettings } from './types';

export function getDirectSendConfigError(ai: AppSettings['ai']): string | null {
  if (!ai.provider?.trim()) {
    return '请先选择 AI 提供商。';
  }
  if (!ai.apiKey?.trim()) {
    return '请先配置 AI API Key。';
  }
  if (!ai.baseUrl?.trim()) {
    return '请先配置 AI Base URL。';
  }
  if (!ai.model?.trim()) {
    return '请先配置 AI 模型名称。';
  }
  return null;
}
