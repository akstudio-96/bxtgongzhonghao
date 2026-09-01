/**
 * 模块4：图库搜索配图
 *  优先 Unsplash → 失败走 Pexels → 两者都没配 → 返回占位图（svg占位，标注"请手动替换"）
 *  返回统一结构：{ url, thumbnail, width, height, alt, source }
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, writeJson, readJson, genId } = require('../utils/helpers');

const IMG_CACHE_FILE = path.join(DATA_DIR, 'images', 'cache.json');
const LOCAL_IMG_DIR = path.join(DATA_DIR, 'images', 'downloaded');

function getUnsplashKey() { return process.env.UNSPLASH_ACCESS_KEY || ''; }
function getPexelsKey() { return process.env.PEXELS_API_KEY || ''; }

/** 构建占位图（base64 svg，不会断链） */
function placeholderImg({ text = '冰箱贴配图', color = '#6D5CEC', width = 900, height = 600 }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${color}"/>
  <rect x="30" y="30" width="${width - 60}" height="${height - 60}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="4" stroke-dasharray="12 8" rx="12"/>
  <text x="50%" y="48%" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="34" fill="#FFFFFF" font-weight="700">冰箱贴配图占位</text>
  <text x="50%" y="58%" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="22" fill="rgba(255,255,255,0.85)">${text.slice(0, 24)}</text>
  <text x="50%" y="78%" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="16" fill="rgba(255,255,255,0.7)">配置 Unsplash/Pexels Key 后可自动替换为真实图片</text>
  <rect x="40%" y="18%" width="20%" height="24%" rx="6" fill="rgba(255,255,255,0.18)"/>
  <circle cx="42%" cy="22%" r="5" fill="rgba(255,255,255,0.9)"/>
</svg>`;
  const b64 = Buffer.from(svg, 'utf-8').toString('base64');
  return `data:image/svg+xml;base64,${b64}`;
}

/** Unsplash 搜索 */
async function searchUnsplash(query, { count = 1, orientation = 'landscape' } = {}) {
  const key = getUnsplashKey();
  if (!key) return [];
  try {
    const q = `${(query || '冰箱贴').trim()} fridge magnet`; // 追加冰箱贴关键词提高贴合度
    const { data } = await axios.get('https://api.unsplash.com/search/photos', {
      params: {
        query: q,
        per_page: Math.max(1, Math.min(count, 30)),
        orientation,
        client_id: key,
      },
      timeout: 15000,
    });
    return (data.results || []).map((p) => ({
      source: 'unsplash',
      id: p.id,
      url: p.urls.regular,
      raw: p.urls.raw,
      thumbnail: p.urls.thumb,
      width: p.width,
      height: p.height,
      alt: p.alt_description || query,
      credit: p.user ? `Unsplash @${p.user.username}` : 'Unsplash',
    }));
  } catch (e) {
    console.warn('[img] Unsplash失败：', e.message);
    return [];
  }
}

/** Pexels 搜索 */
async function searchPexels(query, { count = 1, orientation = 'landscape' } = {}) {
  const key = getPexelsKey();
  if (!key) return [];
  try {
    const q = `${(query || '冰箱贴').trim()} fridge magnet`;
    const { data } = await axios.get('https://api.pexels.com/v1/search', {
      params: {
        query: q,
        per_page: Math.max(1, Math.min(count, 80)),
        orientation: orientation === 'portrait' ? 'portrait' : 'landscape',
      },
      headers: { Authorization: key },
      timeout: 15000,
    });
    return (data.photos || []).map((p) => ({
      source: 'pexels',
      id: String(p.id),
      url: p.src.large,
      raw: p.src.original,
      thumbnail: p.src.tiny,
      width: p.width,
      height: p.height,
      alt: p.alt || query,
      credit: 'Pexels',
    }));
  } catch (e) {
    console.warn('[img] Pexels失败：', e.message);
    return [];
  }
}

/** 缓存读/写 */
function getCache() { return readJson(IMG_CACHE_FILE, {}); }
function setCache(k, v) {
  const c = getCache();
  c[k] = { ...v, cachedAt: Date.now() };
  writeJson(IMG_CACHE_FILE, c);
}

/**
 * 搜索图片（综合），返回 count 个结果；不足则补占位
 */
async function searchImages(query, { count = 1, orientation = 'landscape', force = false } = {}) {
  const key = `${query}|${count}|${orientation}`;
  const cache = getCache();
  if (!force && cache[key] && Date.now() - cache[key].cachedAt < 7 * 24 * 3600 * 1000) {
    return cache[key].results;
  }
  let results = [];
  results = await searchUnsplash(query, { count, orientation });
  if (results.length < count) {
    const px = await searchPexels(query, { count: count - results.length, orientation });
    results = results.concat(px);
  }
  // 补占位
  while (results.length < count) {
    results.push({
      source: 'placeholder',
      id: genId('ph'),
      url: placeholderImg({ text: query }),
      thumbnail: placeholderImg({ text: query, width: 360, height: 240 }),
      width: 900,
      height: 600,
      alt: query,
      credit: '占位图',
      isPlaceholder: true,
    });
  }
  results = results.slice(0, count);
  setCache(key, { results });
  return results;
}

/** 取单张封面图 */
async function getCoverImage(desc) {
  const imgs = await searchImages(desc, { count: 1, orientation: 'landscape' });
  return imgs[0];
}

/** 批量取文中小图 */
async function getInlineImages(descriptions) {
  if (!Array.isArray(descriptions) || descriptions.length === 0) return [];
  const out = [];
  for (const d of descriptions) {
    const imgs = await searchImages(d, { count: 1, orientation: 'landscape' });
    out.push({ description: d, image: imgs[0] });
  }
  return out;
}

module.exports = {
  searchImages,
  getCoverImage,
  getInlineImages,
  placeholderImg,
};
