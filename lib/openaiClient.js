import axios from 'axios';

const DEFAULT_ATTEMPTS = Number(process.env.OPENAI_RETRY_ATTEMPTS || 3);
const DEFAULT_DELAY_MS = Number(process.env.OPENAI_RETRY_DELAY_MS || 2000);

// ═══════════════════════════════════════════════════════════════════════════
// Rate Limiter - 限制 OpenAI API 每秒請求數，避免 429 錯誤
// ═══════════════════════════════════════════════════════════════════════════
const OPENAI_MAX_RPS = 3; // 每秒最多 3 個請求 (保守設定)
const OPENAI_INTERVAL_MS = 1000 / OPENAI_MAX_RPS;

let lastOpenAIRequestTime = 0;
const openaiRequestQueue = [];
let isProcessingOpenAIQueue = false;

async function processOpenAIQueue() {
  if (isProcessingOpenAIQueue) return;
  isProcessingOpenAIQueue = true;

  while (openaiRequestQueue.length > 0) {
    const now = Date.now();
    const elapsed = now - lastOpenAIRequestTime;

    if (elapsed < OPENAI_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(resolve, OPENAI_INTERVAL_MS - elapsed));
    }

    const { resolve, reject, config } = openaiRequestQueue.shift();
    lastOpenAIRequestTime = Date.now();

    try {
      const response = await axios.post(config.url, config.data, config.options);
      resolve(response);
    } catch (err) {
      reject(err);
    }
  }

  isProcessingOpenAIQueue = false;
}

function throttledOpenAIPost(url, data, options = {}) {
  return new Promise((resolve, reject) => {
    openaiRequestQueue.push({ resolve, reject, config: { url, data, options } });
    processOpenAIQueue();
  });
}
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms){
  return new Promise(resolve=>setTimeout(resolve, ms));
}

function isRetryable(err){
  if(!err) return false;
  const status = err.response?.status;
  if(status && (status === 408 || status === 429 || status >= 500)) return true;
  const code = err.code;
  if(['ECONNRESET','ETIMEDOUT','ECONNABORTED','ENETUNREACH','EAI_AGAIN'].includes(code)) return true;
  const msg = err.message || '';
  return /timeout|socket hang up|ECONNRESET/i.test(msg);
}

export async function callOpenAIChat({
  openKey,
  model,
  messages,
  timeoutMs=60000,
  temperature=0,
  responseFormat,
  maxCompletionTokens,
  seed
}){
  if(!openKey) throw new Error('Missing OpenAI key');
  let lastErr;
  for(let attempt=1; attempt<=Math.max(1, DEFAULT_ATTEMPTS); attempt++){
    try{
      const payload = {
        model,
        messages,
        temperature
      };
      if(responseFormat) payload.response_format = responseFormat;
      if(Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0){
        payload.max_completion_tokens = Math.round(maxCompletionTokens);
      }
      if(Number.isFinite(seed)){
        payload.seed = Math.round(seed);
      }
      return await throttledOpenAIPost('https://api.openai.com/v1/chat/completions', payload,{
        headers:{ 'Authorization':`Bearer ${openKey}`, 'Content-Type':'application/json' },
        timeout: timeoutMs
      });
    }catch(err){
      lastErr = err;
      if(attempt === DEFAULT_ATTEMPTS || !isRetryable(err)) throw err;
      const delay = DEFAULT_DELAY_MS * (2 ** (attempt-1));
      const jitter = Math.random() * 300;
      await sleep(delay + jitter);
    }
  }
  throw lastErr;
}
