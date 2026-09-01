/**
 * 模块7：Server酱（FTQQ）推送审稿通知
 *  - 走官方 https://sctapi.ftqq.com/<sendkey>.send 接口
 *  - 兼容 PushPlus（pushplus.plus）——如果 sendkey 以 "SCT" 开头→Server酱，否则判断是不是 PUSH_PLUS_TOKEN
 *  - 同时维护一个通知历史（本地存储），方便前端查看
 */
const axios = require('axios');
const { writeJson, readJson, DATA_DIR, genId } = require('../utils/helpers');
const path = require('path');

const NOTIFY_LOG = path.join(DATA_DIR, 'notifications.json');

function getSendKey() {
  return process.env.SERVERCHAN_SENDKEY || '';
}
function getPushPlusToken() {
  return process.env.PUSHPLUS_TOKEN || '';
}

/** 通过 Server酱 推送 */
async function sendViaServerChan(title, content) {
  const key = getSendKey();
  if (!key || key.includes('请替换')) {
    throw new Error('Server酱未配置：请在.env填 SERVERCHAN_SENDKEY（前往 sct.ftqq.com 注册免费拿）');
  }
  try {
    const url = `https://sctapi.ftqq.com/${key}.send`;
    const { data } = await axios.post(url, new URLSearchParams({ title, desp: content }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
    });
    return { success: data.code === 0, raw: data };
  } catch (e) {
    throw new Error('Server酱推送失败：' + (e.response?.data?.message || e.message));
  }
}

/** 通过 PushPlus 推送（兜底） */
async function sendViaPushPlus(title, content) {
  const t = getPushPlusToken();
  if (!t) return null;
  try {
    const { data } = await axios.post('https://www.pushplus.plus/send', {
      token: t, title, content, template: 'markdown',
    }, { timeout: 20000 });
    return { success: data.code === 200, raw: data };
  } catch (e) {
    throw new Error('PushPlus推送失败：' + (e.response?.data?.msg || e.message));
  }
}

/** 统一发送通知，优先 Server酱，失败自动走 PushPlus；两者都没配就抛错 */
async function sendNotification({ title, content, draftInfo = {} }) {
  let lastResult = null;
  let lastErr = null;
  try {
    lastResult = await sendViaServerChan(title, content);
  } catch (e) {
    lastErr = e.message;
    try {
      lastResult = await sendViaPushPlus(title, content);
    } catch (e2) {
      lastErr = (lastErr ? lastErr + '；' : '') + e2.message;
    }
  }
  if (!lastResult) {
    throw new Error('通知发送失败：' + (lastErr || '未配置任何推送渠道'));
  }
  // 记录日志
  const all = readJson(NOTIFY_LOG, []);
  all.unshift({
    id: genId('ntf'),
    createdAt: Date.now(),
    channel: lastResult?.raw?.channel || (getSendKey() && !getPushPlusToken() ? 'serverchan' : 'pushplus'),
    title,
    content,
    draftId: draftInfo.id || null,
    result: lastResult,
  });
  writeJson(NOTIFY_LOG, all.slice(0, 200));
  return lastResult;
}

/** 生成审稿内容（Markdown格式，微信卡片兼容） */
function buildReviewMessage(draft, submitResult) {
  const m = draft.middle || {};
  const statusLine = submitResult?.ok
    ? `✅ **已成功存入微信草稿箱**（media_id=${submitResult.media_id}）`
    : `⚠️ **走降级模式**（draft/add接口无权限），请复制HTML粘贴到后台`;
  const line = [];
  line.push(`# 📩 新文章待审稿 · 冰箱贴大王`);
  line.push('');
  line.push(statusLine);
  line.push('');
  line.push(`**标题**：${m.selected_title || draft.id}`);
  line.push(`**作者**：${m.author || '冰箱贴大王'}`);
  line.push(`**摘要**：${m.digest || '无'}`);
  line.push(`**字数**：${(m.body_md || '').length} 字`);
  line.push(`**生成时间**：${new Date(draft.createdAt).toLocaleString('zh-CN')}`);
  line.push('');
  line.push('## 📝 正文开头预览（前200字）');
  line.push('');
  line.push(`> ${(m.body_md || '').replace(/[#*>\-]/g, '').slice(0, 200)}……`);
  line.push('');
  line.push('## 🚀 下一步');
  line.push('');
  if (submitResult?.ok) {
    line.push('1. 打开手机「公众号助手」或电脑 mp.weixin.qq.com 后台');
    line.push('2. 进入「草稿箱」，预览这篇文章');
    line.push('3. 审稿 OK → 点「发表」（占当天1次群发名额）');
    line.push('4. 审稿不通过 → 回到本地工具，重新生成或手动修改');
  } else {
    line.push('1. 回到本地工具（ http://localhost:3000 ）→「草稿」Tab');
    line.push('2. 点"复制HTML"或"下载MD"');
    line.push('3. 登录 mp.weixin.qq.com → 新建草稿 → 粘贴');
    line.push('4. 手动上传封面图、调样式 → 保存草稿 → 发表');
  }
  line.push('');
  line.push(`---`);
  line.push(`本消息由「冰箱贴大王自动化生产工具」自动推送`);
  return line.join('\n');
}

/** 读取通知历史 */
function listNotifications(limit = 50) {
  return (readJson(NOTIFY_LOG, [])).slice(0, limit);
}

module.exports = {
  sendNotification,
  buildReviewMessage,
  listNotifications,
  getSendKey,
  getPushPlusToken,
};
