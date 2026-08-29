// Yhchat Web - message rendering (all content types)
(function () {
  const CT = window.YHApi ? window.YHApi.CT : {};

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walk = (node) => {
      [...node.children].forEach(child => {
        const tag = child.tagName.toLowerCase();
        if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'].includes(tag)) { child.remove(); return; }
        [...child.attributes].forEach(attr => {
          const n = attr.name.toLowerCase();
          if (n.startsWith('on')) child.removeAttribute(attr.name);
          if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(attr.value)) child.removeAttribute(attr.name);
        });
        walk(child);
      });
    };
    walk(tpl.content);
    return tpl.innerHTML;
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fileSize(n) {
    if (!n) return '';
    n = Number(n);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // 媒体地址经反向代理转发（规避 jwznb CDN Referer 校验）+ 缓存；库未就绪时回退原地址
  function media(url) {
    if (!url) return url;
    // 优先使用缓存（blob/data URL），无缓存则返回代理 URL 并异步缓存
    if (window.YH && window.YH.getMediaSrc) return window.YH.getMediaSrc(url);
    return (window.YHApi && window.YHApi.mediaUrl) ? window.YHApi.mediaUrl(url) : url;
  }
  function failedImage() {
    const d = document.createElement('div');
    d.className = 'yh-img-failed'; d.textContent = '图片加载失败';
    return d;
  }

  // Render inner content for a message, returns HTML string
  function renderContent(msg, hooks) {
    const c = msg.content || {};
    const ct = msg.content_type;
    const myId = window.YHApi.userId;
    switch (ct) {
      case CT.IMAGE:
        if (c.image_url) return `<img class="yh-img" src="${escapeHtml(media(c.image_url))}" loading="lazy" data-url="${escapeHtml(c.image_url)}" alt="图片" onerror="this.replaceWith(window.YHRender.failedImage())"/>`;
        return '';
      case CT.FILE:
        return `<a class="yh-file" href="${escapeHtml(media(c.file_url))}" target="_blank" rel="noopener">
                  <span class="yh-file-ico">📄</span>
                  <span class="yh-file-meta"><b>${escapeHtml(c.file_name || '文件')}</b><small>${fileSize(c.file_size)}</small></span>
                  <span class="yh-file-dl">下载</span></a>`;
      case CT.AUDIO: {
        const dur = c.audio_time ? ` / ${Math.floor(c.audio_time / 60)}:${String(c.audio_time % 60).padStart(2, '0')}` : '';
        return `<div class="yh-audio">🎤<audio controls src="${escapeHtml(media(c.audio_url))}"></audio><small>${dur}</small></div>`;
      }
      case CT.VIDEO:
        return `<video class="yh-video" src="${escapeHtml(media(c.video_url))}" controls preload="metadata"></video>`;
      case CT.EXPRESSION:
        if (c.sticker_url) return `<img class="yh-sticker" src="${escapeHtml(media(c.sticker_url))}" alt="表情" onerror="this.replaceWith(window.YHRender.failedImage())"/>`;
        return `<span class="yh-expression">[表情 ${escapeHtml(c.expression_id || '')}]</span>`;
      case CT.POST:
        return `<div class="yh-post" data-post="${escapeHtml(c.post_id || '')}">
                  <div class="yh-post-title">${escapeHtml(c.post_title || '文章')}</div>
                  <div class="yh-post-content">${escapeHtml((c.post_content || '').slice(0, 120))}${(c.post_content || '').length > 120 ? '…' : ''}</div>
                  <div class="yh-post-tag">📝 文章</div></div>`;
      case CT.A2UI: {
        let buttons = [];
        try { buttons = JSON.parse(c.buttons || c.text || '[]'); } catch (e) {}
        if (!Array.isArray(buttons)) buttons = buttons && buttons.buttons ? buttons.buttons : [];
        let html = '';
        buttons.forEach(group => {
          if (group.text) html += `<div class="yh-a2ui-text">${escapeHtml(group.text)}</div>`;
          if (Array.isArray(group.buttons)) {
            html += '<div class="yh-a2ui-row">';
            group.buttons.forEach(b => {
              html += `<button class="yh-a2ui-btn" data-value="${escapeHtml(b.value != null ? b.value : b.text)}">${escapeHtml(b.text || b.value)}</button>`;
            });
            html += '</div>';
          }
        });
        return html || escapeHtml(c.buttons || c.text || '');
      }
      case CT.FORM: {
        let form = null;
        try { form = JSON.parse(c.form || '{}'); } catch (e) {}
        return `<div class="yh-form">${escapeHtml(form.title || '表单')}</div>`;
      }
      case CT.MARKDOWN:
        try { return sanitizeHtml(window.marked ? window.marked.parse(c.text || '') : escapeHtml(c.text || '')); }
        catch (e) { return escapeHtml(c.text || ''); }
      case CT.HTML:
        return sanitizeHtml(c.text || '');
      default:
        // text (1) and others
        let text = c.text || '';
        text = escapeHtml(text).replace(/\n/g, '<br/>');
        // highlight @mentions
        text = text.replace(/@([^\s@<]{1,30})/g, '<span class="yh-at">@$1</span>');
        // 解析 yunhu:// url_scheme（ad 类型跳过）
        text = parseYunhuScheme(text);
        return text;
    }
  }

  // Build a bubble element
  function renderBubble(msg, opts) {
    opts = opts || {};
    const myId = window.YHApi.userId;
    const isSelf = msg.sender && msg.sender.chat_id === myId;
    const el = document.createElement('div');
    el.className = 'yh-msg ' + (isSelf ? 'self' : 'other');
    el.dataset.msgId = msg.msg_id || '';
    // 长按/右键菜单用：让 UI 层从 DOM 就能反查消息内容，不用保存另一份 ref map
    el.dataset.isSelf = isSelf ? '1' : '0';
    el.dataset.senderName = msg.sender ? (msg.sender.name || '') : '';
    el.dataset.chatId = msg.chat_id || '';
    el.dataset.chatType = String(msg.chat_type || '');
    el.dataset.contentType = String(msg.content_type || 1);
    el.dataset.senderChatId = msg.sender ? (msg.sender.chat_id || '') : '';
    // 防撤回：如果该消息在缓存中且已被标记撤回，用原始内容渲染并加标记
    let renderMsg = msg;
    let isRecalled = false;
    if (window.YH && window.YH.S && window.YH.S._antiRecallCache) {
      const cached = window.YH.S._antiRecallCache.get(String(msg.msg_id));
      if (cached && cached.recalled) {
        isRecalled = true;
        // 用原始内容渲染，但保留 msg_id 等元数据
        renderMsg = Object.assign({}, msg, {
          content: cached.content,
          content_type: cached.content_type
        });
      }
    }
    // 预览文本（用于复制文本 / 引用预览 / 编辑态回填文本）
    const c = msg.content || {};
    let previewText = c.text || '';
    if (!previewText) {
      if (c.image) previewText = '[图片]';
      else if (c.video) previewText = '[视频]';
      else if (c.audio) previewText = '[语音]';
      else if (c.file) previewText = '[文件] ' + (c.file_name || '');
      else if (c.post_id) previewText = '[帖子] ' + (c.post_title || '');
      else if (c.expression_id) previewText = '[表情]';
    }
    el.dataset.previewText = previewText;
    if (c.quote_msg_text) el.dataset.quoteMsgText = c.quote_msg_text;
    if (c.quote_image_url) el.dataset.quoteImageUrl = c.quote_image_url;
    if (c.quote_video_url) el.dataset.quoteVideoUrl = c.quote_video_url;
    if (msg.quote_msg_id) el.dataset.quoteMsgId = msg.quote_msg_id;

    // quote block
    if (msg.quote_msg_id && (msg.content.quote_msg_text || msg.content.quote_image_url || msg.content.quote_video_url)) {
      const q = document.createElement('div');
      q.className = 'yh-quote';
      let qt = '';
      if (msg.content.quote_image_url) qt = '🖼️ [图片]';
      else if (msg.content.quote_video_url) qt = '🎬 [视频]';
      else qt = msg.content.quote_msg_text || '';
      q.textContent = qt;
      q.dataset.quote = msg.quote_msg_id;
      el.appendChild(q);
    }

    const bubble = document.createElement('div');
    bubble.className = 'yh-bubble';
    if (!isSelf && msg.sender) {
      const name = document.createElement('div');
      name.className = 'yh-sender';
      name.textContent = msg.sender.name || '';
      if (opts.showName) bubble.appendChild(name);
    }
    const inner = document.createElement('div');
    inner.className = 'yh-inner';
    inner.innerHTML = renderContent(isRecalled ? renderMsg : msg, opts);
    bubble.appendChild(inner);

    // 防撤回标记
    if (isRecalled) {
      const tag = document.createElement('div');
      tag.className = 'yh-recalled-tag';
      tag.textContent = '已撤回';
      bubble.insertBefore(tag, bubble.firstChild);
    }

    const time = document.createElement('div');
    time.className = 'yh-time';
    time.textContent = formatTime(msg.send_time);
    bubble.appendChild(time);

    el.appendChild(bubble);
    return el;
  }

  function renderSystem(text) {
    const el = document.createElement('div');
    el.className = 'yh-system';
    el.textContent = text;
    return el;
  }

  // 生成 yunhu:// 链接的 span HTML
  function _yunhuSpan(scheme, query, match, customLabel) {
    const params = new URLSearchParams(query || '');
    const id = params.get('id') || '';
    let label = customLabel || '', dataType = '';
    if (scheme === 'chat-add') {
      const type = params.get('type') || 'user';
      dataType = type;
      if (!customLabel) {
        const typeLabel = type === 'group' ? '群聊' : (type === 'bot' ? '机器人' : '用户');
        label = '添加' + typeLabel + (id ? '#' + id : '');
      }
    } else if (scheme === 'post-detail') {
      if (!customLabel) label = '查看文章' + (id ? '#' + id : '');
    } else if (scheme === 'alley-detail') {
      if (!customLabel) label = '查看分区' + (id ? '#' + id : '');
    }
    return `<span class="yh-yunhu-link" data-scheme="${scheme}" data-id="${id}" data-type="${dataType}" data-raw="${match}">${escapeHtml(label)}</span>`;
  }

  // 解析 yunhu:// url_scheme（ad 类型跳过），返回包含可点击 <span> 的 HTML
  // 用于已转义的 HTML 文本（纯文本消息、评论）
  function parseYunhuScheme(html) {
    return html.replace(/yunhu:\/\/(chat-add|post-detail|alley-detail)(\?[^<\s]*)?/g, (match, scheme, query) => {
      return _yunhuSpan(scheme, query, match, '');
    });
  }

  // 解析 yunhu:// url_scheme（Markdown 专用），在 marked.js 之前预处理原始 Markdown 文本
  // 处理两种形式：[text](yunhu://...) 和 裸 yunhu://...
  function parseYunhuSchemeMarkdown(text) {
    // 1. Markdown 链接 [text](yunhu://...)
    text = text.replace(/\[([^\]]*)\]\(yunhu:\/\/(chat-add|post-detail|alley-detail)(\?[^)\s]*)?\)/g,
      (match, linkText, scheme, query) => {
        const raw = 'yunhu://' + scheme + (query || '');
        return _yunhuSpan(scheme, query, raw, linkText);
      });
    // 2. 裸 yunhu://...
    text = text.replace(/yunhu:\/\/(chat-add|post-detail|alley-detail)(\?[^\s<\]]*)?/g, (match, scheme, query) => {
      return _yunhuSpan(scheme, query, match, '');
    });
    return text;
  }

  window.YHRender = { escapeHtml, sanitizeHtml, formatTime, fileSize, renderContent, renderBubble, renderSystem, failedImage, parseYunhuScheme, parseYunhuSchemeMarkdown };
})();
