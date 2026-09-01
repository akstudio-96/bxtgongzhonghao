/**
 * 模块5：Markdown → 微信内联样式HTML
 *  不依赖第三方重量级库，实现一个足够好用的极简Markdown解析器 + 默认样式（与历史文章风格合并）
 *  输出结构：微信公众号后台认可的 <section> 为主的 HTML
 *
 *  支持：# / ## / ### / 段落 / 粗体 ** / 斜体 / 列表（- 1.）/ 分割线 --- / 图片占位符![alt]({{img_N}})
 *        / 引用（>）
 */
const { getStyleProfile } = require('./styleLearning');

/** 默认排版样式（如果没有学习到模板就用这个冰箱贴风格默认款） */
const DEFAULT_STYLES = {
  section: 'margin: 0; padding: 0;',
  h1: 'font-size: 22px; font-weight: 700; color: #1A1D29; line-height: 1.6; margin: 28px 0 14px; padding-left: 12px; border-left: 4px solid #6D5CEC;',
  h2: 'font-size: 18px; font-weight: 700; color: #1A1D29; line-height: 1.6; margin: 24px 0 12px;',
  h3: 'font-size: 16px; font-weight: 700; color: #333; line-height: 1.6; margin: 20px 0 10px;',
  p: 'font-size: 16px; color: #333; line-height: 1.9; margin: 14px 0; text-align: justify; letter-spacing: 0.5px;',
  strong: 'color: #6D5CEC; font-weight: 700;',
  em: 'font-style: italic; color: #555;',
  blockquote: 'border-left: 3px solid #D7D3F8; background: #F8F7FF; padding: 12px 16px; margin: 16px 0; font-size: 15px; color: #555; line-height: 1.8; border-radius: 0 8px 8px 0;',
  ul: 'margin: 14px 0 14px 20px; padding: 0;',
  ol: 'margin: 14px 0 14px 20px; padding: 0;',
  li: 'font-size: 16px; color: #333; line-height: 1.9; margin: 6px 0;',
  hr: 'border: 0; height: 1px; background: linear-gradient(to right, transparent, #C9CDD9, transparent); margin: 28px 0;',
  img: 'display: block; max-width: 100%; height: auto; margin: 18px auto; border-radius: 8px;',
  imgCaption: 'text-align: center; font-size: 13px; color: #888; margin: -8px 0 20px;',
};

/** 根据 styleProfile 叠加用户的高频样式到默认样式 */
function mergeStylesWithProfile() {
  const merged = { ...DEFAULT_STYLES };
  const profile = getStyleProfile();
  const common = profile?.template?.commonStyles || [];
  // 简单合并：把学到的高频 section / p / h1-h3 样式作为补丁叠加
  for (const item of common) {
    const tag = (item.tag || '').toLowerCase();
    if (tag === 'h1') merged.h1 += item.style.replace(/margin[^;]*;?/gi, '') + ';';
    if (tag === 'h2') merged.h2 += item.style.replace(/margin[^;]*;?/gi, '') + ';';
    if (tag === 'p') merged.p += item.style.replace(/margin[^;]*;?/gi, '') + ';';
    if (tag === 'section') merged.section += item.style + ';';
  }
  return merged;
}

/** 解析行内：粗体/斜体 */
function parseInline(text, S) {
  let out = text;
  // **粗体**
  out = out.replace(/\*\*([^*]+?)\*\*/g, `<strong style="${S.strong}">$1</strong>`);
  // *斜体* 但保留**
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, `$1<em style="${S.em}">$2</em>`);
  // _斜体_
  out = out.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, `$1<em style="${S.em}">$2</em>`);
  // 普通超链接 [文字](url) 转成 span（微信公众号不支持外链href跳转，保留文字）
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span style="color:#6D5CEC;text-decoration:underline;">$1</span>');
  return out;
}

/** 极简 Markdown → 微信HTML */
function mdToWechatHtml(md, { inlineImages = [] } = {}) {
  const S = mergeStylesWithProfile();
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inQuote = false;
  let inList = null; // 'ul' | 'ol'
  const closeList = () => { if (inList) { html.push(`</${inList}>`); inList = null; } };
  const closeQuote = () => { if (inQuote) { html.push('</section>'); inQuote = false; } };
  let imgIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行 → 关闭列表/引用
    if (!trimmed) {
      closeList();
      closeQuote();
      continue;
    }

    // 分割线
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      closeList();
      closeQuote();
      html.push(`<section style="${S.section}"><hr style="${S.hr}"/></section>`);
      continue;
    }

    // 图片占位 {{img_N}} 或 ![]({{img_N}})
    const imgMatch = trimmed.match(/\{\{img_(\d+)\}\}/) || trimmed.match(/!\[[^\]]*\]\s*\(\s*\{\{img_(\d+)\}\}\s*\)/);
    if (imgMatch) {
      closeList();
      closeQuote();
      const idx = parseInt(imgMatch[1]) - 1; // {{img_1}} = 第0张
      const info = inlineImages[idx];
      const img = info?.image;
      const src = img?.url || '';
      const alt = (info?.description || (img?.alt) || `配图${idx + 1}`).replace(/"/g, '&quot;');
      const caption = info?.description || '';
      html.push(`<section style="${S.section}"><img style="${S.img}" src="${src}" alt="${alt}"/>${caption ? `<section style="${S.imgCaption}">${caption}</section>` : ''}</section>`);
      imgIdx++;
      continue;
    }

    // 标题
    let m = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      closeList();
      closeQuote();
      const level = m[1].length;
      const style = S[`h${level}`];
      const text = parseInline(m[2], S);
      html.push(`<section style="${S.section}"><h${level} style="${style}">${text}</h${level}></section>`);
      continue;
    }

    // 引用
    if (/^>\s?/.test(trimmed)) {
      closeList();
      if (!inQuote) { html.push(`<section style="${S.section}"><section style="${S.blockquote}">`); inQuote = true; }
      const text = parseInline(trimmed.replace(/^>\s?/, ''), S);
      html.push(`<section style="${S.section}">${text}</section>`);
      continue;
    } else {
      closeQuote();
    }

    // 列表项 ul
    if (/^[-*+]\s+/.test(trimmed)) {
      if (inList !== 'ul') { closeList(); html.push(`<ul style="${S.ul}">`); inList = 'ul'; }
      const text = parseInline(trimmed.replace(/^[-*+]\s+/, ''), S);
      html.push(`<li style="${S.li}">${text}</li>`);
      continue;
    }
    // 列表项 ol
    if (/^\d+\.\s+/.test(trimmed)) {
      if (inList !== 'ol') { closeList(); html.push(`<ol style="${S.ol}">`); inList = 'ol'; }
      const text = parseInline(trimmed.replace(/^\d+\.\s+/, ''), S);
      html.push(`<li style="${S.li}">${text}</li>`);
      continue;
    }

    // 其它 = 段落
    closeList();
    const text = parseInline(trimmed, S);
    html.push(`<section style="${S.section}"><p style="${S.p}">${text}</p></section>`);
  }

  closeList();
  closeQuote();
  return html.join('\n');
}

/**
 * 主入口：把文章中间稿 + inlineImages → 渲染成微信可发的完整HTML
 *  同时把 inlineImages 的说明注入到正文里（每2个小节插一张图，或在 {{img_N}} 位置）
 */
function renderDraftToWechatHtml(draft, { cover, inlineImages = [] } = {}) {
  const m = draft.middle || {};
  let bodyMd = m.body_md || '';

  // 如果用户没手动写 {{img_N}} 占位，就自动在小节之间均匀插入图位
  if (!/\{\{img_\d+\}\}/.test(bodyMd) && inlineImages.length > 0) {
    const sections = bodyMd.split(/(?=^#{1,3}\s)/m);
    const injected = [];
    let imgIdx = 1;
    injected.push(sections[0]);
    for (let i = 1; i < sections.length; i++) {
      if (imgIdx <= inlineImages.length && Math.random() < 0.9) {
        injected.push(`\n\n{{img_${imgIdx}}}\n\n`);
        imgIdx++;
      }
      injected.push(sections[i]);
    }
    // 如果还有剩图，末尾补
    for (; imgIdx <= inlineImages.length; imgIdx++) {
      injected.push(`\n\n{{img_${imgIdx}}}\n\n`);
    }
    bodyMd = injected.join('');
  }

  const wechatHtml = mdToWechatHtml(bodyMd, { inlineImages });

  return {
    title: m.selected_title || '',
    author: m.author || '冰箱贴大王',
    digest: m.digest || '',
    content: wechatHtml,
    cover,
    inlineImages,
  };
}

module.exports = {
  renderDraftToWechatHtml,
  mdToWechatHtml,
  mergeStylesWithProfile,
};
