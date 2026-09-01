/**
 * LLM 通用封装
 *  兼容 OpenAI 协议（DeepSeek / 智谱 / 月之暗面 / OpenAI 都能用）
 *  支持 jsonMode（尽量让模型输出结构化JSON）
 */
const axios = require('axios');

function getConfig() {
  const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  return {
    baseUrl, apiKey, model,
    ready: !!baseUrl && !!apiKey && !apiKey.includes('请替换'),
  };
}

/**
 * 调用LLM
 * @param {object} opts
 * @param {string} opts.prompt 用户prompt
 * @param {string} opts.system 系统prompt（可选）
 * @param {number} opts.temperature 0~2
 * @param {boolean} opts.jsonMode 是否要求JSON输出
 */
async function callLLM({ prompt, system = '', temperature = 0.7, jsonMode = false }) {
  const { baseUrl, apiKey, model, ready } = getConfig();
  if (!ready) {
    throw new Error('LLM 未配置：请在.env里填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  const messages = [];
  const sysPrompt = system + (jsonMode ? '\n【重要】必须输出合法JSON，不要任何其他文字、不要markdown代码块。' : '');
  if (sysPrompt) messages.push({ role: 'system', content: sysPrompt });
  messages.push({ role: 'user', content: prompt });

  try {
    const url = `${baseUrl}/chat/completions`;
    const body = {
      model,
      messages,
      temperature,
    };
    if (jsonMode) {
      // 双保险：response_format + system 提示
      body.response_format = { type: 'json_object' };
    }
    const { data } = await axios.post(
      url,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 120000,
      }
    );
    const content = data?.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('LLM 返回空内容');
    return content.trim();
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    throw new Error(`LLM调用失败：${msg}`);
  }
}

module.exports = { callLLM, getConfig: getConfig };
