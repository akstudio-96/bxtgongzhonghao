/**
 * 模块6：草稿箱写入
 *  流程：封面图（必要时先下载到本地再传永久素材）→ 正文里的图片若为非微信图床也需要上传换 URL → 调 draft/add
 *  双路径：
 *   A. draft/add API 成功 → 拿到 media_id，草稿已入公众平台后台
 *   B. 报 48001/48002（个人未认证权限不足）→ 给出"降级模式"：把排版好的HTML以预览页展示，给您复制到后台，附带操作指引
 *  正文图的处理：如果是占位图/dataURL（svg base64），微信平台不接受，统一替换为上传到临时/永久素材的图床URL
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getAccessToken, resetToken } = require('../utils/wechatToken');
const { DATA_DIR, genId, writeJson, readJson, sleep } = require('../utils/helpers');

const IMG_DIR = path.join(DATA_DIR, 'images', 'downloaded');

/** 下载远程图片到本地临时文件（或把 base64 存为文件），返回绝对路径 */
async function ensureLocalImg(urlOrDataUrl, { prefix = 'img' } = {}) {
  if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
  const localFile = path.join(IMG_DIR, `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`);
  // data:image/svg+xml;base64
  if (urlOrDataUrl.startsWith('data:')) {
    const comma = urlOrDataUrl.indexOf(',');
    const head = urlOrDataUrl.slice(5, comma); // e.g. image/svg+xml;base64
    const body = urlOrDataUrl.slice(comma + 1);
    const isBase64 = /;\s*base64$/i.test(head);
    const mimeType = head.split(';')[0];
    const ext = mimeType.split('/')[1]?.split('+')[0] || 'png';
    const realFile = localFile.replace(/\.jpg$/, `.${ext}`);
    fs.writeFileSync(realFile, isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf-8'));
    return realFile;
  }
  // http(s) URL → 下载
  const resp = await axios.get(urlOrDataUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  // 猜后缀
  const ct = resp.headers['content-type'] || 'image/jpeg';
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'jpg' : ct.includes('svg') ? 'svg' : ct.includes('gif') ? 'gif' : 'jpg';
  const realFile = localFile.replace(/\.jpg$/, `.${ext}`);
  fs.writeFileSync(realFile, Buffer.from(resp.data));
  return realFile;
}

/** 上传封面图为永久素材（取 thumb_media_id），失败返回 null */
async function uploadPermanentImage(localPath) {
  const token = await getAccessToken();
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('media', fs.createReadStream(localPath));
  const resp = await axios.post(
    `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=image`,
    form,
    { headers: form.getHeaders(), timeout: 60000, maxBodyLength: Infinity }
  );
  const d = resp.data;
  if (!d.media_id) {
    const msg = `[errcode=${d.errcode}] ${d.errmsg || '上传失败'}`;
    if (d.errcode === 48001 || d.errcode === 48002) {
      const e = new Error(`权限不足（${d.errcode}）：素材管理接口未开放。建议走降级模式手动复制。`);
      e.code = d.errcode;
      e.kind = 'permission';
      throw e;
    }
    if (d.errcode === 40001) { resetToken(); }
    throw new Error('上传永久素材失败：' + msg);
  }
  return { media_id: d.media_id, url: d.url || '' };
}

/** 上传正文图到素材图床（取URL，给content里的<img src>） */
async function uploadContentImage(localPath) {
  const token = await getAccessToken();
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('media', fs.createReadStream(localPath));
  // 用临时素材接口（上传图文消息内的图片获取URL）
  const resp = await axios.post(
    `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${token}`,
    form,
    { headers: form.getHeaders(), timeout: 60000, maxBodyLength: Infinity }
  );
  const d = resp.data;
  if (!d.url) {
    if (d.errcode === 48001 || d.errcode === 48002) {
      const e = new Error(`权限不足（${d.errcode}）：正文图上传接口未开放。建议走降级模式。`);
      e.code = d.errcode;
      e.kind = 'permission';
      throw e;
    }
    if (d.errcode === 40001) resetToken();
    throw new Error('上传正文图失败：' + JSON.stringify(d));
  }
  return d.url;
}

/**
 * 核心：把草稿推入微信草稿箱
 *  - rendered 来自 wechatRenderer.renderDraftToWechatHtml() 的返回
 *  - coverImage 来自 imageSearch.getCoverImage() 的返回（含url / source）
 *  - inlineImages 来自 imageSearch.getInlineImages()
 */
async function submitToWechatDraft({ rendered, coverImage, inlineImages = [], authorOverride }) {
  // 1. 处理封面图：传永久素材 → thumb_media_id
  let thumbMediaId = null;
  try {
    if (coverImage?.url) {
      const localCover = await ensureLocalImg(coverImage.url, { prefix: 'cover' });
      const up = await uploadPermanentImage(localCover);
      thumbMediaId = up.media_id;
    }
  } catch (e) {
    if (e.kind === 'permission') throw e;
    console.warn('[draft] 封面上传失败，将使用空白封面：', e.message);
  }

  // 2. 处理正文里的每张图：先替换为微信图床URL
  let contentHtml = rendered.content || '';
  // 2.1 先搜集 contentHtml 中的 <img src="xxx">
  const srcRegex = /<img\b[^>]*?\s+src\s*=\s*"([^"]+)"[^>]*>/g;
  const uniqueSrcs = [];
  const seen = new Set();
  let m;
  while ((m = srcRegex.exec(contentHtml)) !== null) {
    const s = m[1];
    if (!seen.has(s) && !s.startsWith('https://mmbiz.qpic.cn/')) { // 已经是微信图床的不用再传
      seen.add(s); uniqueSrcs.push(s);
    }
  }
  // 2.2 逐个上传，构建映射 oldSrc -> newWechatSrc
  const srcMap = {};
  for (const src of uniqueSrcs) {
    try {
      const local = await ensureLocalImg(src, { prefix: 'content' });
      const wechatUrl = await uploadContentImage(local);
      srcMap[src] = wechatUrl;
      // 尝试清理本地（省空间），失败忽略
      try { fs.unlinkSync(local); } catch (_) {}
    } catch (e) {
      if (e.kind === 'permission') throw e;
      console.warn('[draft] 正文图上传失败，保留原图 src：', src.slice(0, 50), e.message);
      srcMap[src] = src;
    }
  }
  // 2.3 替换
  for (const [oldS, newS] of Object.entries(srcMap)) {
    contentHtml = contentHtml.split(oldS).join(newS);
  }
  // 封面本地图也删掉
  try { if (coverImage?.url && coverImage.url.startsWith('data:')) {} } catch (_) {}

  const articles = [{
    title: (rendered.title || '').slice(0, 64),
    author: (authorOverride || rendered.author || '冰箱贴大王').slice(0, 16),
    digest: (rendered.digest || '').slice(0, 128),
    content: contentHtml,
    thumb_media_id: thumbMediaId || '',
    content_source_url: '',
    need_open_comment: 1,
    only_fans_can_comment: 0,
  }];

  // 3. 调 draft/add
  const token = await getAccessToken();
  try {
    const { data } = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`,
      { articles },
      { timeout: 30000 }
    );
    if (data.media_id) {
      return {
        ok: true,
        path: 'api',
        media_id: data.media_id,
        thumb_media_id: thumbMediaId,
        message: '已写入微信公众平台草稿箱，您可以在后台「草稿箱」或手机公众号助手看到。',
        rendered,
      };
    }
    const code = data.errcode;
    const msg = data.errmsg || '未知错误';
    if (code === 48001 || code === 48002) {
      const e = new Error(`草稿写入权限不足（${code}）。`);
      e.code = code;
      e.kind = 'permission';
      throw e;
    }
    if (code === 40001) { resetToken(); const e = new Error('token 过期，重试一次'); e.code = 40001; throw e; }
    throw new Error(`draft/add 返回错误：[${code}] ${msg}`);
  } catch (e) {
    if (e.code === 40001) throw e;
    if (e.kind === 'permission' || (e.code && (e.code === 48001 || e.code === 48002))) {
      // 降级模式：返回 HTML 让用户手动复制
      return {
        ok: false,
        path: 'fallback',
        message: '个人未认证订阅号 draft/add 接口未开放。请使用"降级模式"：复制下方 HTML 或 Markdown，粘贴到公众号后台编辑器即可。',
        fallbacks: {
          renderedHtml: contentHtml, // 已经被图床替换好的
          title: articles[0].title,
          author: articles[0].author,
          digest: articles[0].digest,
          coverImage: coverImage?.url || '',
          instructions: [
            '1. 登录 mp.weixin.qq.com → 图文消息 → 新建草稿',
            '2. 填标题/作者/摘要',
            '3. 在正文区右键"粘贴"或使用公众号自带"HTML编辑"插件粘贴 renderedHtml（若粘贴样式丢失可切到富文本框手动再微调）',
            '4. 上传封面图',
            '5. 保存到草稿箱',
          ],
        },
        rendered,
      };
    }
    throw e;
  }
}

module.exports = {
  submitToWechatDraft,
  ensureLocalImg,
};
