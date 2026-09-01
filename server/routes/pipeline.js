/**
 * 热点 + 生成 + 草稿 + 通知 路由
 */
const express = require('express');
const router = express.Router();
const { ok, fail } = require('../utils/helpers');
const { fetchAllHotspots } = require('../modules/hotspot');
const { generateArticle, listDrafts, getDraft, updateDraft, deleteDraft } = require('../modules/articleGenerator');
const { getCoverImage, getInlineImages } = require('../modules/imageSearch');
const { renderDraftToWechatHtml } = require('../modules/wechatRenderer');
const { submitToWechatDraft } = require('../modules/wechatDraft');
const { sendNotification, buildReviewMessage, listNotifications } = require('../modules/notify');

// ========== 热点 ==========

router.get('/hotspots', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const data = await fetchAllHotspots({ force });
    return ok(res, data);
  } catch (e) { return fail(res, e.message); }
});

// ========== 文章生成 ==========

/** POST /api/articles/generate - 生成中间稿 */
router.post('/articles/generate', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { hotspot, overrideTitle, extraContext } = req.body || {};
    if (!hotspot && !overrideTitle) return fail(res, '必须传热点对象或自定义标题');
    const draft = await generateArticle({ hotspot, overrideTitle, extraContext });
    return ok(res, draft);
  } catch (e) { return fail(res, e.message); }
});

/** GET /api/articles/drafts - 草稿列表 */
router.get('/articles/drafts', (req, res) => {
  try {
    const list = listDrafts().map((d) => ({
      id: d.id,
      createdAt: d.createdAt,
      status: d.status,
      title: d.middle?.selected_title || '(未命名)',
      digest: d.middle?.digest || '',
      wordCount: (d.middle?.body_md || '').length,
      fromHotspot: d.fromHotspot,
      updatedAt: d.updatedAt || null,
      submitResult: d.submitResult || null,
      notifiedAt: d.notifiedAt || null,
    }));
    return ok(res, { list, total: list.length });
  } catch (e) { return fail(res, e.message); }
});

/** GET /api/articles/drafts/:id */
router.get('/articles/drafts/:id', (req, res) => {
  try {
    const d = getDraft(req.params.id);
    if (!d) return fail(res, '草稿不存在');
    return ok(res, d);
  } catch (e) { return fail(res, e.message); }
});

/** PATCH /api/articles/drafts/:id - 手动编辑中间稿 */
router.patch('/articles/drafts/:id', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const d = updateDraft(req.params.id, req.body || {});
    return ok(res, d);
  } catch (e) { return fail(res, e.message); }
});

/** DELETE /api/articles/drafts/:id */
router.delete('/articles/drafts/:id', (req, res) => {
  try { deleteDraft(req.params.id); return ok(res); }
  catch (e) { return fail(res, e.message); }
});

// ========== 渲染 ==========

/** POST /api/articles/drafts/:id/render - 配图 + 渲染微信HTML（不进草稿箱） */
router.post('/articles/drafts/:id/render', async (req, res) => {
  try {
    const d = getDraft(req.params.id);
    if (!d) return fail(res, '草稿不存在');
    const cover = await getCoverImage(d.middle?.cover_description || '冰箱贴');
    const inlines = await getInlineImages(d.middle?.inline_image_descriptions || []);
    const rendered = renderDraftToWechatHtml(d, { cover, inlineImages: inlines });
    const updated = updateDraft(req.params.id, { rendered, cover, inlineImages: inlines, status: 'rendered' });
    return ok(res, updated);
  } catch (e) { return fail(res, e.message); }
});

// ========== 写入微信草稿箱 ==========

/** POST /api/articles/drafts/:id/submit - 推入草稿箱（失败自动降级模式） */
router.post('/articles/drafts/:id/submit', async (req, res) => {
  try {
    const d = getDraft(req.params.id);
    if (!d) return fail(res, '草稿不存在');
    // 如果还没渲染，先渲染
    let rendered = d.rendered;
    let cover = d.cover;
    let inlines = d.inlineImages || [];
    if (!rendered) {
      cover = d.cover || await getCoverImage(d.middle?.cover_description || '冰箱贴');
      inlines = d.inlineImages?.length ? d.inlineImages : await getInlineImages(d.middle?.inline_image_descriptions || []);
      rendered = renderDraftToWechatHtml(d, { cover, inlineImages: inlines });
    }
    let submitResult;
    try {
      submitResult = await submitToWechatDraft({ rendered, coverImage: cover, inlineImages: inlines });
    } catch (e) {
      // 40001 token过期，再试一次
      if (e.code === 40001) {
        submitResult = await submitToWechatDraft({ rendered, coverImage: cover, inlineImages: inlines });
      } else {
        throw e;
      }
    }
    const updated = updateDraft(req.params.id, {
      rendered, cover, inlineImages: inlines,
      submitResult,
      status: submitResult.ok ? 'submitted' : 'fallback',
    });
    return ok(res, updated);
  } catch (e) { return fail(res, e.message); }
});

// ========== 通知 ==========

/** POST /api/articles/drafts/:id/notify - 推送审稿通知 */
router.post('/articles/drafts/:id/notify', async (req, res) => {
  try {
    const d = getDraft(req.params.id);
    if (!d) return fail(res, '草稿不存在');
    const submitResult = d.submitResult || (req.body?.submitResult);
    if (!submitResult) return fail(res, '请先推入草稿箱，再发通知');
    const title = `【审稿待办】${d.middle?.selected_title || d.id}`;
    const content = buildReviewMessage(d, submitResult);
    const r = await sendNotification({ title, content, draftInfo: d });
    const updated = updateDraft(d.id, { notifiedAt: Date.now(), notifyResult: r });
    return ok(res, { notify: r, draft: updated });
  } catch (e) { return fail(res, e.message); }
});

/** GET /api/notifications - 通知历史 */
router.get('/notifications', (req, res) => {
  try { return ok(res, { list: listNotifications(50) }); }
  catch (e) { return fail(res, e.message); }
});

module.exports = router;
