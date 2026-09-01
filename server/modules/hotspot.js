/**
 * 模块1：热点搜集
 * 聚合3个来源：微博热搜、百度热搜、微信读书/搜一搜热搜
 * 然后做冰箱贴主题关联筛选：
 *  - 强关联：含关键词冰箱贴/magnet/磁吸/磁铁/磁力贴
 *  - 弱关联：含家居/装饰/旅行/文创/礼物/城市/纪念等关键词，可结合LLM判断是否能"蹭"
 *  - 分数排序，输出带关联度标签
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { readJson, writeJson, DATA_DIR, genId, sleep } = require('../utils/helpers');
const path = require('path');

const CACHE_FILE = path.join(DATA_DIR, 'hotspots.json');

// 强关联关键词（必中）
const STRONG_KEYWORDS = [
  '冰箱贴', '磁吸', '磁力贴', '磁铁', 'magnet',
  '文创', '纪念品', '纪念章', '伴手礼', '手信',
];

// 弱关联关键词（可蹭，结合实际判断）
const WEAK_KEYWORDS = [
  '家居', '装饰', '装修', '软装', '摆件', '收藏',
  '旅行', '旅游', '城市', '打卡', '探店', '景点',
  '美食', '餐厅', '小吃', '咖啡', '奶茶',
  '艺术', '设计', '手工', '小众', '可爱', '治愈',
  '开业', '新品', '联名', '限定', '周边',
  '节日', '春节', '中秋', '国庆', '圣诞', '情人节',
  '动物', '猫咪', '狗狗', '熊猫', '花', '植物',
  '人物', '明星', '影视', '动画', '游戏',
];

/** 抓取微博热搜 */
async function fetchWeiboHot() {
  try {
    const url = 'https://weibo.com/ajax/side/hotSearch';
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Referer: 'https://weibo.com/',
    };
    const { data } = await axios.get(url, { headers, timeout: 15000 });
    if (!data?.data?.realtime) return [];
    return data.data.realtime
      .filter((item, idx) => idx < 50)
      .map((item, rank) => ({
        rank: rank + 1,
        title: item.word || item.note,
        hot: item.num || item.raw_hot || 0,
        url: item.word ? `https://s.weibo.com/weibo?q=%23${encodeURIComponent(item.word)}%23` : '',
        category: item.category || '',
      }));
  } catch (e) {
    console.warn('[hotspot] 微博热搜拉取失败：', e.message);
    return [];
  }
}

/** 抓取百度热搜（PC端页面解析） */
async function fetchBaiduHot() {
  try {
    const url = 'https://top.baidu.com/board?tab=realtime';
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    };
    const { data: html } = await axios.get(url, { headers, timeout: 15000 });
    const $ = cheerio.load(html);
    const items = [];
    $('.category-wrap_iQLoo .content_1YWBm').each((i, el) => {
      if (i >= 50) return false;
      const $el = $(el);
      const title = $el.find('.c-single-text-ellipsis').text().trim();
      const hot = $el.find('.hot-index_1Bl1a').text().trim();
      const href = $el.find('a').attr('href') || '';
      if (title) items.push({ rank: i + 1, title, hot: parseInt(hot) || 0, url: href, category: '' });
    });
    return items;
  } catch (e) {
    console.warn('[hotspot] 百度热搜拉取失败：', e.message);
    return [];
  }
}

/** 抓取微信热搜（腾讯网微信热搜镜像 + 今日热榜API） */
async function fetchWechatHot() {
  try {
    // 先用今日热榜的API
    const url = 'https://api.vvhan.com/api/hotlist/wxHotSearch';
    const { data } = await axios.get(url, { timeout: 15000 });
    if (data && data.data && Array.isArray(data.data)) {
      return data.data.slice(0, 50).map((it, i) => ({
        rank: i + 1,
        title: it.title,
        hot: it.hot || 0,
        url: it.url || it.mobileUrl || '',
        category: '',
      }));
    }
    return [];
  } catch (e) {
    console.warn('[hotspot] 微信热搜拉取失败：', e.message);
    return [];
  }
}

/** 计算关联分 */
function calcRelevance(title) {
  const lower = (title || '').toLowerCase();
  let strong = 0;
  let weak = 0;
  const hits = [];
  for (const kw of STRONG_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) { strong++; hits.push(kw); }
  }
  for (const kw of WEAK_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) { weak++; hits.push(kw); }
  }
  let score = strong * 5 + weak;
  let label = '未关联';
  if (strong >= 1) label = '强关联';
  else if (weak >= 2) label = '中关联';
  else if (weak >= 1) label = '弱关联';
  return { score, label, hits: Array.from(new Set(hits)) };
}

/** 主入口：聚合 + 去重 + 打分 + 缓存 */
async function fetchAllHotspots({ force = false } = {}) {
  const cached = readJson(CACHE_FILE, null);
  if (!force && cached && cached.fetchedAt && Date.now() - cached.fetchedAt < 30 * 60 * 1000) {
    return cached; // 30分钟缓存
  }

  const [weibo, baidu, wechat] = await Promise.all([
    fetchWeiboHot(),
    fetchBaiduHot(),
    fetchWechatHot(),
  ]);

  const merged = [];
  const seen = new Set();
  for (const { source, list } of [
    { source: '微博', list: weibo },
    { source: '百度', list: baidu },
    { source: '微信', list: wechat },
  ]) {
    for (const item of list) {
      const key = item.title.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      const rel = calcRelevance(item.title);
      merged.push({
        id: genId('hs'),
        source,
        title: item.title,
        hot: item.hot,
        url: item.url,
        rank: item.rank,
        category: item.category,
        relevance: rel.label,
        relevanceScore: rel.score,
        relevanceHits: rel.hits,
        titleNormalized: key,
      });
    }
  }

  // 排序：关联分降序，热度降序
  merged.sort((a, b) => (b.relevanceScore - a.relevanceScore) || (b.hot - a.hot));

  const result = {
    fetchedAt: Date.now(),
    total: merged.length,
    summary: {
      strong: merged.filter((x) => x.relevance === '强关联').length,
      medium: merged.filter((x) => x.relevance === '中关联').length,
      weak: merged.filter((x) => x.relevance === '弱关联').length,
      none: merged.filter((x) => x.relevance === '未关联').length,
    },
    items: merged,
  };
  writeJson(CACHE_FILE, result);
  return result;
}

module.exports = {
  fetchAllHotspots,
};
