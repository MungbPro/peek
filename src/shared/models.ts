export const OPENAI_LIVE_MODELS = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
] as const;

export type OpenAILiveModel = typeof OPENAI_LIVE_MODELS[number]['id'];
export function isOpenAILiveModel(model: string): model is OpenAILiveModel {
  return OPENAI_LIVE_MODELS.some(profile => profile.id === model);
}
