export type OperationStage = 'capture' | 'answer' | 'transcription';
type Language = 'zh' | 'en';

function field(error: unknown, name: 'name' | 'message' | 'code'): string {
  if (name === 'message' && typeof error === 'string') return error.slice(0, 1024);
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return '';
  try {
    const value: unknown = (error as Record<string, unknown>)[name];
    return typeof value === 'string' ? value.slice(0, 1024) : '';
  } catch { return ''; }
}

/**
 * Native Electron APIs can reject strings, while IPC may cross Error realms.
 * Classify those failures without returning arbitrary messages, bodies, paths,
 * credentials, or submitted context to the renderer.
 */
export function operationError(error: unknown, stage: OperationStage, language: Language): string {
  const choose = (zh: string, en: string): string => language === 'zh' ? zh : en;
  const subject = stage === 'capture' ? choose('截图', 'Screen capture')
    : stage === 'transcription' ? choose('语音转写', 'Transcription') : choose('回答', 'Answer');
  const name = field(error, 'name');
  const detail = field(error, 'message');
  const code = field(error, 'code');

  if (name === 'AbortError') return choose(`${subject}已停止。`, `${subject} stopped.`);
  if (stage === 'capture' && name === 'TimeoutError') {
    return choose('截图等待超过时限，本次不使用屏幕内容。', 'Screen capture exceeded its time budget; no screen content is used for this answer.');
  }
  if (name === 'TimeoutError' || /^(ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code)) {
    return choose(`${subject}超时。请检查网络，稍后重试。`, `${subject} timed out. Check the connection and retry.`);
  }
  if (stage === 'capture') {
    return choose(
      '未能截取屏幕。请检查 Peek 的屏幕录制权限，完全退出并重新打开后重试。',
      'Screen capture was unavailable. Check Peek’s screen-recording permission, fully quit and reopen Peek, then retry.',
    );
  }

  // provider.ts creates these status messages without reflecting response bodies.
  // Preserve only the numeric status; do not trust any suffix of the message.
  const status = /^API\s+([45]\d{2})\b/i.exec(detail)?.[1];
  if (status) {
    const prefix = choose(`${subject}失败（API ${status}）。`, `${subject} failed (API ${status}). `);
    const advice = status === '401'
      ? choose('请在 Peek 的密钥设置中检查或更换 API 密钥。', 'Check or replace the API key in Peek’s key settings.')
      : status === '403'
        ? choose('请检查账号、地区及模型的访问权限。', 'Check account, region, and model access.')
        : status === '429'
          ? choose('请求过于频繁或额度不足。请检查 API 余额，稍后重试。', 'Rate limit or quota reached. Check API billing and retry later.')
          : status === '404'
            ? choose('请检查配置中的 API 地址和模型名称。', 'Check the API address and model name in the configuration.')
            : status === '400'
              ? stage === 'transcription'
                ? choose('请检查转写模型是否支持当前音频格式。', 'Check that the transcription model supports this audio format.')
                : choose('请检查所选模型是否支持图片及当前请求参数。', 'Check that the selected model supports images and the request parameters.')
              : status.startsWith('5')
                ? choose('服务暂时不可用，请稍后重试。', 'The provider is temporarily unavailable. Retry later.')
                : choose('服务拒绝了请求，请检查 API 配置。', 'The provider rejected the request. Check the API configuration.');
    return prefix + advice;
  }

  if (/^(fetch failed|failed to fetch|network error)$/i.test(detail) || /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH)$/.test(code)) {
    return choose(`${subject}未能连接 API。请检查网络和 API 地址后重试。`, `${subject} could not reach the API. Check the connection and API address, then retry.`);
  }
  if (detail === 'The connection ended before the answer completed. Please retry.' || detail === 'The provider reported a streaming error.') {
    return choose('回答传输中断，请重试。', 'The answer stream was interrupted. Please retry.');
  }
  if (detail === 'The model returned an empty answer.') return choose('模型没有返回回答，请重试或更换模型。', 'The model returned no answer. Retry or choose another model.');
  if (detail === 'Answer incomplete (length). Try a shorter question.') return choose('回答达到长度限制，请缩小问题范围后重试。', 'The answer reached its length limit. Narrow the question and retry.');
  if (detail === 'The transcription provider returned no text.') return choose('语音服务没有返回文字，请检查转写模型后重试。', 'The speech provider returned no text. Check the transcription model and retry.');
  return stage === 'transcription'
    ? choose('语音转写失败。请检查网络和转写模型，稍后重试。', 'Transcription failed. Check the connection and transcription model, then retry.')
    : choose('回答失败。请检查网络和所选模型，稍后重试。', 'Answer failed. Check the connection and selected model, then retry.');
}
