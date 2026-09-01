/**
 * 模块3：AI 文章生成
 *  输入：热点/选题（title，url，hot等）+ 风格档案
 *  输出：结构化中间稿 JSON（标题候选、正文Markdown、摘要、作者、配图建议）
 *  LLM 只产出数据，不拼HTML、不调接口
 */
const { callLLM } = require('./llm');
const { getStyleProfile } = require('./styleLearning');
const { writeJson, readJson, listJsonFiles, DATA_DIR, genId } = require('../utils/helpers');
const path = require('path');

const DRAFTS_DIR = path.join(DATA_DIR, 'drafts');

/** 风格档案 → 生成系统prompt */
function buildStylePrompt(profile) {
  if (!profile?.writing) return '';
  const w = profile.writing;
  const lines = [];
  lines.push(`## 您必须模仿的写作风格（冰箱贴大王公众号风格）\n`);
  if (w.tone) lines.push(`- 语气调性：${w.tone}`);
  if (w.structure) lines.push(`- 结构：${w.structure}`);
  if (w.typicalOpening) lines.push(`- 典型开头：${w.typicalOpening}`);
  if (w.typicalEnding) lines.push(`- 典型结尾/互动：${w.typicalEnding}`);
  if (w.sentenceStyle) lines.push(`- 句式风格：${w.sentenceStyle}`);
  if (w.titlePattern) lines.push(`- 标题形式：${w.titlePattern}`);
  if (w.fridgeMagnetHookStyle) lines.push(`- 热点切入冰箱贴的方式：${w.fridgeMagnetHookStyle}`);
  if (Array.isArray(w.wordPreferences) && w.wordPreferences.length) {
    lines.push(`- 常用词汇偏好：${w.wordPreferences.join('、')}`);
  }
  if (w.targetWordRange) lines.push(`- 建议字数：${w.targetWordRange}`);
  return lines.join('\n');
}

/**
 * 生成文章中间稿
 * @param {object} params
 * @param {object} params.hotspot  热点对象（含 title/url/hot/relevanceHits/source）
 * @param {string} params.overrideTitle 可选：自己指定的标题/选题
 * @param {string} params.extraContext 可选：补充背景信息
 */
async function generateArticle({ hotspot, overrideTitle, extraContext }) {
  const profile = getStyleProfile();
  const stylePrompt = buildStylePrompt(profile);
  const topic = overrideTitle || (hotspot?.titleNormalized || hotspot?.title || '');
  if (!topic) throw new Error('必须提供热点或自定义标题');

  const hitKeywords = (hotspot?.relevanceHits || []).join('、') || '（需要您在文中合理关联冰箱贴）';

  const systemPrompt = `您是公众号「冰箱贴大王」的御用撰稿人。您只会写冰箱贴主题的公众号文章。

${stylePrompt}

## 硬性要求
1. 全文必须围绕"冰箱贴"展开。即使给您的热点本身和冰箱贴不直接相关，也要用创意和想象力把它和冰箱贴关联起来（例如：做成冰箱贴周边、城市纪念冰箱贴、节日冰箱贴、联名款冰箱贴、冰箱贴收藏等）。
2. 标题必须是公众号风格的"钩子型"标题，有吸引力，带点情感。
3. 正文使用Markdown（#一级标题 = 文中小节标题；##二级 = 小节内子标题；- 列表；**粗体**）。
4. 给出 3 个候选标题；正文开头要有摘要(abstract)作为公众平台 digest 字段的来源。
5. 给出封面图的文字描述（中文，30字内），给 2~4 个文中小图位的描述（每个15字内）。
6. 输出严格 JSON，不要任何多余文字。

## 输出 JSON 字段（必须严格遵守字段名）
{
  "title_candidates": ["候选1", "候选2", "候选3"],
  "selected_title": "最终选的主标题，<=32字",
  "author": "冰箱贴大王",
  "digest": "摘要 <=128字，适合公众号摘要栏",
  "body_md": "正文Markdown（不含一级大标题），字数符合风格档案要求",
  "cover_description": "封面图描述（中文，<=30字，围绕冰箱贴+热点）",
  "inline_image_descriptions": ["文中配图1描述<=15字", "文中配图2描述<=15字", "文中配图3描述<=15字", "文中配图4描述<=15字"]
}`;

  const userPrompt = `【写作任务】
根据下面的热点/选题，写一篇"冰箱贴大王"风格的公众号文章。

主题：${topic}
来源平台：${hotspot?.source || '自定义'}
热度：${hotspot?.hot || 'N/A'}
关联关键词：${hitKeywords}
原文链接（可参考）：${hotspot?.url || '无'}
补充背景：${extraContext || '无'}

请按上面的JSON字段输出，不要任何多余文字，不要 \`\`\`json。`;

  const raw = await callLLM({
    system: systemPrompt,
    prompt: userPrompt,
    temperature: 0.8,
    jsonMode: true,
  });

  let draft;
  try {
    const m = /\{[\s\S]*\}/.exec(raw);
    draft = JSON.parse(m ? m[0] : raw);
  } catch (e) {
    throw new Error('文章生成结果解析失败：' + e.message + '\n原始：' + raw.slice(0, 500));
  }

  // 字段校验兜底
  draft.selected_title = (draft.selected_title || draft.title_candidates?.[0] || topic).slice(0, 64);
  draft.author = draft.author || '冰箱贴大王';
  draft.digest = (draft.digest || '').slice(0, 128);
  draft.body_md = draft.body_md || '';

  const record = {
    id: genId('dft'),
    createdAt: Date.now(),
    status: 'generated', // generated | rendered | submitted | failed
    fromHotspot: hotspot ? { id: hotspot.id, title: hotspot.title, source: hotspot.source } : null,
    customTopic: overrideTitle || null,
    middle: draft,
  };
  writeJson(path.join(DRAFTS_DIR, `${record.id}.json`), record);
  return record;
}

/** 读取所有草稿 */
function listDrafts() {
  const files = listJsonFiles(DRAFTS_DIR);
  return files
    .map((f) => readJson(f, null))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 读取单篇 */
function getDraft(id) {
  return readJson(path.join(DRAFTS_DIR, `${id}.json`), null);
}

/** 更新草稿状态/内容 */
function updateDraft(id, patch) {
  const f = path.join(DRAFTS_DIR, `${id}.json`);
  const cur = readJson(f, null);
  if (!cur) throw new Error('草稿不存在');
  const merged = { ...cur, ...patch, updatedAt: Date.now() };
  writeJson(f, merged);
  return merged;
}

/** 删除 */
function deleteDraft(id) {
  const f = path.join(DRAFTS_DIR, `${id}.json`);
  try { require('fs').unlinkSync(f); return true; } catch (e) { return false; }
}

module.exports = {
  generateArticle,
  listDrafts,
  getDraft,
  updateDraft,
  deleteDraft,
};
