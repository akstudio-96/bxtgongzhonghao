/**
 * 系统/配置/诊断路由
 */
const express = require('express');
const router = express.Router();
const { ok, fail } = require('../utils/helpers');
const { getConfig: getWechatConfig } = require('../utils/wechatToken');
const { getConfig: getLLMConfig } = require('../modules/llm');
const { getSendKey, getPushPlusToken } = require('../modules/notify');
const { getStyleProfile, listArticles } = require('../modules/styleLearning');
const axios = require('axios');

/** GET /api/system/status - 运行态/配置自检，不回显密钥 */
router.get('/status', async (req, res) => {
  try {
    const wechat = getWechatConfig();
    const llm = getLLMConfig();
    const sck = getSendKey();
    const ppk = getPushPlusToken();

    let exitIp = process.env.LOCAL_EXIT_IP || '';
    if (!exitIp) {
      try {
        const { data } = await axios.get('https://ifconfig.me', { timeout: 8000 });
        exitIp = (typeof data === 'string' ? data : '').trim();
      } catch (_) {}
    }

    const profile = getStyleProfile();
    return ok(res, {
      env: {
        wechat: wechat.ready ? '已配置' : '未配置',
        wechatAppid: (process.env.WECHAT_APPID || '').slice(0, 8) + '...',
        llm: llm.ready ? `已配置 (${llm.model})` : '未配置',
        llmBase: llm.baseUrl,
        serverchan: (sck && !sck.includes('请替换')) ? '已配置' : '未配置',
        pushplus: ppk ? '已配置' : '未配置',
        unsplash: process.env.UNSPLASH_ACCESS_KEY ? '已配置' : '未配置',
        pexels: process.env.PEXELS_API_KEY ? '已配置' : '未配置',
      },
      localExitIp: exitIp,
      style: {
        articleCount: profile.articleCount,
        hasWritingProfile: !!profile.writing,
        hasTemplate: !!profile.template,
      },
      time: Date.now(),
    });
  } catch (e) {
    return fail(res, e.message);
  }
});

/** GET /api/system/articles - 已导入历史文章列表 */
router.get('/articles', (req, res) => {
  try {
    const list = listArticles().map((a) => ({
      id: a.id,
      createdAt: a.createdAt,
      title: a.originalTitle || a.parsedMeta?.title || '未命名',
      wordCount: a.parsedMeta?.wordCount || 0,
      imgCount: a.parsedMeta?.imgCount || 0,
    }));
    return ok(res, { list, total: list.length });
  } catch (e) { return fail(res, e.message); }
});

/** POST /api/system/articles - 手动导入一篇历史文章（HTML/正文） */
router.post('/articles', express.json({ limit: '20mb' }), (req, res) => {
  try {
    const { html, title, url, author, bodyText } = req.body || {};
    if (!html && !bodyText) return fail(res, '必须传HTML原文或正文纯文本');
    const { saveArticle } = require('../modules/styleLearning');
    const rec = saveArticle({ html, title, url, author });
    return ok(res, {
      id: rec.id,
      title: rec.originalTitle || rec.parsedMeta?.title || '未命名',
      wordCount: rec.parsedMeta?.wordCount || 0,
    });
  } catch (e) { return fail(res, e.message); }
});

/** DELETE /api/system/articles/:id */
router.delete('/articles/:id', (req, res) => {
  try {
    const { deleteArticle } = require('../modules/styleLearning');
    deleteArticle(req.params.id);
    return ok(res);
  } catch (e) { return fail(res, e.message); }
});

/** POST /api/system/learn-style - 触发风格学习 */
router.post('/learn-style', async (req, res) => {
  try {
    const { learnStyle } = require('../modules/styleLearning');
    const r = await learnStyle();
    return ok(res, r);
  } catch (e) { return fail(res, e.message); }
});

/** GET /api/system/style-profile - 获取当前风格档案 */
router.get('/style-profile', (req, res) => {
  try {
    return ok(res, getStyleProfile());
  } catch (e) { return fail(res, e.message); }
});

module.exports = router;
