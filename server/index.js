/**
 * 服务入口
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const { getAccessToken, resetToken, getConfig } = require('./utils/wechatToken');
const { ok, fail } = require('./utils/helpers');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// 中间件：JSON body（小请求）；大请求在各路由里单独设置limit
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 静态前端
app.use(express.static(path.join(__dirname, '..', 'public')));

// 统一响应格式的辅助（放在 res.locals）
app.use((req, res, next) => {
  res.setHeader('X-Powered-By', 'FridgeMagnet-Publisher/1.0');
  next();
});

// ========== 调试接口：快速测 draft/add ==========
app.get('/api/debug/wechat-permission', async (req, res) => {
  try {
    const cfg = getConfig();
    const check = {
      appid: cfg.appid || '(未填)',
      configured: cfg.ready,
    };
    if (!cfg.ready) return fail(res, '凭证未填', 1, check);
    const token = await getAccessToken({ forceRefresh: true });
    check.tokenFetched = !!token;
    return ok(res, check);
  } catch (e) {
    return fail(res, e.message, 1, { errorCode: (e.message.match(/\[(\d+)\]/) || [])[1] });
  }
});

// ========== 挂载路由 ==========
app.use('/api/system', require('./routes/system'));
app.use('/api', require('./routes/pipeline'));

// ========== 前端单页 fallback ==========
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  fail(res, err.message || '服务器内部错误', err.code || 500);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🟣 冰箱贴大王 · 公众号自动化生产工具已启动');
  console.log(`   本地访问：   http://localhost:${PORT}`);
  console.log(`   局域网访问： http://<本机IP>:${PORT}`);
  console.log('');
  const wechat = getConfig();
  if (!wechat.ready) console.log('⚠️  微信凭证未配置：请复制 .env.example 为 .env，填写 WECHAT_APPID/WECHAT_APPSECRET');
  if ((process.env.LLM_API_KEY || '').includes('请替换')) console.log('⚠️  LLM 未配置：请在 .env 里填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  if ((process.env.SERVERCHAN_SENDKEY || '').includes('请替换')) console.log('⚠️  推送未配置：请在 .env 里填 SERVERCHAN_SENDKEY（sct.ftqq.com 免费注册）');
  console.log('');
});
