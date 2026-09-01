/**
 * 模块2：历史文章导入 + 风格学习
 *  个人号无API拉取权限，所以是：手动粘贴HTML/正文 → 本地解析 → LLM归纳风格档案
 *  风格档案分为两部分：
 *   1) writing_profile.json：写作风格画像（语气、结构、篇幅、开头结尾模式等）
 *   2) template.json：排版模板（标题样式、段落、分割线、配图位置等，结构化描述）
 */
const cheerio = require('cheerio');
const { readJson, writeJson, listJsonFiles, genId, DATA_DIR, hashString } = require('../utils/helpers');
const path = require('path');
const { callLLM } = require('./llm');

const ARTICLES_DIR = path.join(DATA_DIR, 'articles');
const STYLE_DIR = path.join(DATA_DIR, 'style');
const WRITING_PROFILE = path.join(STYLE_DIR, 'writing_profile.json');
const TEMPLATE = path.join(STYLE_DIR, 'template.json');

/** 从HTML里提取纯文本、标题元数据、样式特征 */
function parseArticleHtml(html, { title = '', url = '', author = '' } = {}) {
  const $ = cheerio.load(html || '');
  // 去掉script/style/noscript
  $('script, style, noscript').remove();
  // 提取正文所有section/p/span的内联样式作为特征
  const styleSignatures = [];
  $('*').each((_, el) => {
    const tag = (el.name || '').toLowerCase();
    if (['script', 'style', 'noscript', 'meta', 'link', 'img', 'svg'].includes(tag)) return;
    const style = $(el).attr('style');
    if (!style) return;
    const compact = style.replace(/\s+/g, ' ').trim();
    if (compact.length > 6) styleSignatures.push({ tag, style: compact });
  });
  // 统计元素分布
  const tags = {};
  $('*').each((_, el) => {
    const tag = (el.name || '').toLowerCase();
    tags[tag] = (tags[tag] || 0) + 1;
  });
  // 纯文本正文
  const bodyText = ($('#js_content').text() || $('body').text() || $('section').text() || $(html).text()).replace(/\s+/g, ' ').trim();
  // 取标题：如果传了就用传的，否则尝试从<title>取
  let finalTitle = title;
  if (!finalTitle) finalTitle = $('title').text().trim();
  if (!finalTitle) {
    // 找字号最大的那个元素做标题
    let maxSize = 0;
    let candidate = '';
    $('*').each((_, el) => {
      const st = $(el).attr('style') || '';
      const m = /font-size\s*:\s*(\d+)px/i.exec(st);
      if (m) {
        const s = parseInt(m[1]);
        if (s > maxSize) {
          const txt = $(el).text().trim();
          if (txt && txt.length < 60) { maxSize = s; candidate = txt; }
        }
      }
    });
    finalTitle = candidate;
  }
  // 图片数量与占位
  const imgCount = $('img').length;

  return {
    title: finalTitle,
    author,
    url,
    bodyText,
    wordCount: bodyText.length,
    imgCount,
    styleSignatures: styleSignatures.slice(0, 200), // 前200个足够
    tagStats: tags,
  };
}

/** 保存一篇原始文章 */
function saveArticle(input) {
  const rawHtml = input.html || '';
  const meta = parseArticleHtml(rawHtml, {
    title: input.title || '',
    url: input.url || '',
    author: input.author || '',
  });
  const id = input.id || genId('art');
  const record = {
    id,
    createdAt: Date.now(),
    originalTitle: input.title || meta.title,
    parsedMeta: meta,
    htmlHash: hashString(rawHtml),
    html: rawHtml,
  };
  writeJson(path.join(ARTICLES_DIR, `${id}.json`), record);
  return record;
}

/** 读取全部已导入文章 */
function listArticles() {
  const files = listJsonFiles(ARTICLES_DIR);
  return files
    .map((f) => readJson(f, null))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 删除一篇已导入文章 */
function deleteArticle(id) {
  const f = path.join(ARTICLES_DIR, `${id}.json`);
  try { require('fs').unlinkSync(f); return true; } catch (e) { return false; }
}

/** 统计：用前N篇汇总排版模板描述（结构化） */
function aggregateTemplate(articles) {
  const samples = articles.slice(0, Math.min(articles.length, 8));
  if (samples.length === 0) return null;

  // 统计样式频次
  const styleFreq = new Map(); // tag|style -> count
  let totalWordCount = 0;
  let totalImg = 0;
  for (const art of samples) {
    const p = art.parsedMeta;
    totalWordCount += p.wordCount || 0;
    totalImg += p.imgCount || 0;
    for (const s of p.styleSignatures || []) {
      const k = `${s.tag}|${s.style}`;
      styleFreq.set(k, (styleFreq.get(k) || 0) + 1);
    }
  }
  const avgWords = Math.round(totalWordCount / samples.length);
  const avgImg = Math.round((totalImg / samples.length) * 10) / 10;

  // 选出高频样式（>= 样本数一半）作为模板核心
  const threshold = Math.ceil(samples.length / 2);
  const commonStyles = [];
  for (const [k, cnt] of styleFreq.entries()) {
    if (cnt >= threshold) {
      const [tag, style] = k.split('|');
      commonStyles.push({ tag, style, rate: cnt / samples.length });
    }
  }
  commonStyles.sort((a, b) => b.rate - a.rate);

  return {
    sampleCount: samples.length,
    createdAt: Date.now(),
    avgWords,
    avgImg,
    commonStyles, // 高频样式：即您的排版习惯
  };
}

/** 用LLM汇总写作风格画像 */
async function generateWritingProfile(articles) {
  if (articles.length === 0) return null;
  const samples = articles.slice(0, Math.min(articles.length, 6));
  const corpus = samples.map((art, i) => {
    const m = art.parsedMeta;
    return `【文章${i + 1}】标题：${art.originalTitle || m.title}\n字数：${m.wordCount}\n正文摘要（前400字）：${(m.bodyText || '').slice(0, 400)}\n`;
  }).join('\n---\n');

  const prompt = `您是一位公众号风格分析师。下面是冰箱贴大王账号的${samples.length}篇已发布文章的语料样本，请分析出"写作风格画像"，输出严格JSON，不要任何其他文字：

【字段要求】
{
  "tone": "语气调性（一句话）",
  "structure": "典型的文章结构模式（如：开头引入→热点背景→冰箱贴关联→结尾互动；字数限制200字）",
  "typicalOpening": "典型的开头句/引入方式",
  "typicalEnding": "典型的结尾句/互动方式",
  "sentenceStyle": "句式偏好（长短句、口语化程度、是否爱用比喻/设问等）",
  "wordPreferences": "反复出现的关键词或词汇偏好（数组，8-15个）",
  "targetAudience": "目标读者画像",
  "targetWordRange": "建议字数区间，如 \"800-1500\"",
  "titlePattern": "标题的常用形式（如：\"用XX + 数字吸引 + 情感共鸣\"，并举1-3个您生成的冰箱贴文章标题示例）",
  "fridgeMagnetHookStyle": "把任意热点和冰箱贴关联时的切入方式（从语料里总结，如果语料里没有现成的，给一套适配这个账号风格的推荐写法，100字以内）"
}

【语料】
${corpus}

请严格输出JSON，不要加 \`\`\`json 或其他任何文字。`;

  const raw = await callLLM({ prompt, temperature: 0.2, jsonMode: true });
  let profile;
  try {
    const m = /\{[\s\S]*\}/.exec(raw);
    profile = JSON.parse(m ? m[0] : raw);
  } catch (e) {
    throw new Error('LLM返回风格画像解析失败：' + e.message + '\n原始输出：' + raw.slice(0, 300));
  }
  profile.sampleCount = samples.length;
  profile.generatedAt = Date.now();
  return profile;
}

/** 完整的风格学习流程 */
async function learnStyle() {
  const articles = listArticles();
  if (articles.length === 0) {
    throw new Error('请先导入至少1篇历史文章');
  }
  const template = aggregateTemplate(articles);
  const writing = await generateWritingProfile(articles);
  writeJson(TEMPLATE, template);
  writeJson(WRITING_PROFILE, writing);
  return { template, writing, articleCount: articles.length };
}

/** 读取当前风格档案 */
function getStyleProfile() {
  return {
    writing: readJson(WRITING_PROFILE, null),
    template: readJson(TEMPLATE, null),
    articleCount: listArticles().length,
  };
}

/** 重置风格档案（不清历史文章） */
function resetStyleProfile() {
  try { require('fs').unlinkSync(WRITING_PROFILE); } catch (_) {}
  try { require('fs').unlinkSync(TEMPLATE); } catch (_) {}
}

module.exports = {
  saveArticle,
  listArticles,
  deleteArticle,
  learnStyle,
  getStyleProfile,
  resetStyleProfile,
  parseArticleHtml,
};
