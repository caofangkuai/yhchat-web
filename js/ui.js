// Yhchat Web - main UI controller
(function () {
  // 惰性读取 window.mdui —— ESM 模块在 DOMContentLoaded 之后才执行并完成组件注册，
  // 因此 IIFE 解析时 window.mdui 尚未就绪。这里用 Proxy 转发到 window.mdui。
  const mdui = new Proxy({}, { get(_, k) { return window.mdui ? window.mdui[k] : undefined; } });
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const CT = window.YHApi.CT;

  const S = { profile: null, conversations: [], active: null, messages: [], baList: [], posts: [],
    // 当前引用的消息：{ msgId, senderName, previewText, contentType, quoteMsgText, quoteImageUrl, quoteVideoUrl }
    quoting: null,
    // 当前编辑的消息：{ msgId, originalText, contentType }
    editing: null,
    // 长按去抖：当前激活项的 yh-msg 元素
    longPressedEl: null,
    longPressTimer: 0,
    // 社区分页状态
    _commPage: { recommend: 0, mine: 0, posts: 0 },
    _commLoading: false,
    _commHasMore: { recommend: true, mine: true, posts: true },
    _baDetailId: null,
    // 消息定时刷新
    _msgTimer: 0,
    _convTimer: 0,
    // 聊天历史分页：加载更早消息
    _histLoading: false,
    _histHasMore: true,
    // 下拉刷新
    _pulling: false,
    _pullDist: 0,
    _pullStartY: 0,
    // 防撤回：消息缓存 { msg_id → { content, content_type, sender, send_time, msg_seq, recalled } }
    _antiRecallCache: new Map(),
    _antiRecallTimer: 0
  };

  function snack(msg, opts) { try { mdui.snackbar(Object.assign({ message: msg }, opts || {})); } catch (e) { console.warn(e); } }

  // ============ 头像缓存 ============
  // 缓存 proxiedUrl → blobUrl/dataUrl，避免同一头像反复从网络加载
  const _avatarCache = new Map();
  const _avatarPending = new Set();
  const _AVATAR_MAX = 500;

  function _setAvatarCache(key, val) {
    if (_avatarCache.size >= _AVATAR_MAX) {
      const oldest = _avatarCache.keys().next().value;
      const oldVal = _avatarCache.get(oldest);
      if (oldVal && oldVal.startsWith('blob:')) URL.revokeObjectURL(oldVal);
      _avatarCache.delete(oldest);
    }
    _avatarCache.set(key, val);
  }

  // 异步缓存头像：先试 fetch+blob（需 CORS），失败再试 Image+canvas，都失败则标记不可缓存
  async function _cacheAvatar(url) {
    if (_avatarCache.has(url) || _avatarPending.has(url)) return;
    _avatarPending.add(url);
    try {
      const resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      if (blob.size > 0 && blob.type.startsWith('image/')) {
        _setAvatarCache(url, URL.createObjectURL(blob));
        return;
      }
      throw new Error('not image');
    } catch (e) {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = function () {
            try {
              const c = document.createElement('canvas');
              c.width = img.naturalWidth;
              c.height = img.naturalHeight;
              c.getContext('2d').drawImage(img, 0, 0);
              resolve(c.toDataURL());
            } catch (e) { reject(e); }
          };
          img.onerror = () => reject(new Error('img load failed'));
          img.src = url;
        });
        _setAvatarCache(url, dataUrl);
      } catch (_) {
        _setAvatarCache(url, url);
      }
    } finally {
      _avatarPending.delete(url);
    }
  }

  // 同步查缓存：有缓存用 blobUrl/dataUrl，无缓存触发异步加载并返回原始 URL
  function _getAvatarSrc(originalUrl) {
    if (!originalUrl) return '';
    const proxied = window.YHApi.mediaUrl(originalUrl);
    if (!proxied) return '';
    const cached = _avatarCache.get(proxied);
    if (cached && cached !== proxied) return cached;
    _cacheAvatar(proxied);
    return proxied;
  }

  // 头像内部结构：img 加载失败时自动移除，露出下方首字母兜底；URL 走缓存 + mediaUrl 代理
  function avatarInner(url, name, size) {
    const sz = size || 40;
    const ch = window.YHRender.escapeHtml((name || '?').slice(0, 1));
    const src = _getAvatarSrc(url);
    const img = src ? `<img src="${window.YHRender.escapeHtml(src)}" alt="" onerror="this.remove()">` : '';
    return `${img}<span class="yh-avatar-fb">${ch}</span>`;
  }
  function avatarHtml(url, name, size) {
    const sz = size || 40;
    return `<div class="yh-avatar" style="--size:${sz}px">${avatarInner(url, name, sz)}</div>`;
  }

  function openDialog(html, opts) {
    opts = opts || {};
    const d = document.createElement('mdui-dialog');
    d.style.maxWidth = (opts.width || 560) + 'px';
    d.innerHTML = html;
    const close = document.createElement('mdui-button-icon');
    close.icon = 'close';
    close.className = 'yh-dialog-close';
    close.setAttribute('aria-label', '关闭');
    close.onclick = () => { d.open = false; };
    d.appendChild(close);
    $('#dialog-host').appendChild(d);
    requestAnimationFrame(() => { d.open = true; });
    d.addEventListener('close', () => d.remove());
    return d;
  }

  function confirmDialog(headline, description, onOk) {
    mdui.dialog({
      headline, description,
      actions: [
        { text: '取消' },
        { text: '确定', onClick: onOk }
      ]
    });
  }

  // ============ "发送到 xxx" 统一改为下拉选择框 ============
  // 用于：推荐文章列表卡片、分区文章列表、帖子详情顶栏。
  // 渲染：一个 native <select>（下拉），选项来自 S.conversations（最近一次拉取的会话列表）
  // + "刷新会话列表" 占位 + 手动输入 chat_id 的兜底。
  function renderSendToSelect(variant, post, opts) {
    const ph = window.YHRender.escapeHtml((opts && opts.placeholder) || '发送到会话…');
    const suffix = (post && post.id) ? String(post.id) : '';
    const cls = variant === 'inline' ? 'yh-send-to-inline' : 'yh-send-to-detail';
    // 先渲染空 select；bindSendToSelect 会在 bind 阶段用异步拉到的会话列表填充 <option>。
    return `
      <span class="yh-send-to-wrap ${cls}" data-post-id="${window.YHRender.escapeHtml(suffix || '')}">
        <select class="yh-send-to-select" aria-label="${ph}">
          <option value="" disabled selected>${ph}</option>
          <option value="__load__">⟳ 加载会话列表…</option>
        </select>
      </span>`;
  }

  // 将 (S.conversations + 兜底) 填进容器内所有 .yh-send-to-select，并绑定 change 事件发送 POST 卡片。
  function bindSendToSelect(container, postInfo) {
    if (!container) return;
    const selects = container.querySelectorAll && container.querySelectorAll('.yh-send-to-select');
    if (!selects || !selects.length) return;

    const fillOptions = (sel, list) => {
      const current = sel.value;
      const ph = sel.querySelector('option[disabled]');
      const placeholder = ph ? ph.textContent : '发送到会话…';
      const opts = [`<option value="" disabled${sel.selectedIndex === 0 || !current ? ' selected' : ''}>${placeholder}</option>`];
      // 最多 30 个最近会话，按当前 S.conversations 顺序（置顶+时间倒序）
      (list || S.conversations || []).slice(0, 50).forEach(c => {
        const id = c.chatId || c.chat_id || ''; if (!id) return;
        const label = ((c.chatType == 2 || c.chat_type == 2) ? '👥 ' : '👤 ')
          + (c.name || '(无标题)')
          + (c.unreadMessage ? `  [${c.unreadMessage}]` : '');
        // chatType 编码到 value，用 | 分隔，避免新增属性
        const ct = (c.chatType != null) ? c.chatType : (c.chat_type != null ? c.chat_type : 0);
        opts.push(`<option value="${window.YHRender.escapeHtml(id)}|${ct}|${window.YHRender.escapeHtml(c.name || '')}">${window.YHRender.escapeHtml(label)}</option>`);
      });
      opts.push('<option value="__manual__">✎ 手动输入 chat_id…</option>');
      sel.innerHTML = opts.join('');
    };

    const sendToConv = async (chatId, chatType, chatName) => {
      if (!chatId) { snack('请选择目标会话'); return; }
      try {
        await window.YHApi.sendMessage({
          chatId,
          chatType: (chatType == null || chatType === '') ? 0 : Number(chatType) || 0,
          contentType: window.YHApi.CT.POST,
          postId: String(postInfo.postId == null ? '' : postInfo.postId),
          postTitle: postInfo.postTitle || '',
          postContent: postInfo.postContent || '',
          postType: String((postInfo.postType == null ? 1 : postInfo.postType) || 1),
        });
        snack(`已发送到 ${chatName || chatId}`);
      } catch (e) { snack('发送失败：' + e.message); }
    };

    selects.forEach(sel => {
      // 如果已经有会话列表，立刻填充一次（避免让用户每次点"加载"）
      if (S.conversations && S.conversations.length) fillOptions(sel, S.conversations);
      sel.addEventListener('change', async () => {
        const v = sel.value;
        if (!v) return;
        if (v === '__load__') {
          // 重新拉会话列表并回填
          try {
            snack('正在加载会话列表…');
            await window.YH.loadConversations && window.YH.loadConversations();
            // 若 S.conversations 还是空，兜底走 listConversations
            if ((!S.conversations || !S.conversations.length) && window.YHApi && window.YHApi.listConversations) {
              try { S.conversations = await window.YHApi.listConversations(); } catch (_) {}
            }
            fillOptions(sel, S.conversations);
          } catch (e) { snack('加载会话失败：' + e.message); }
          return;
        }
        if (v === '__manual__') {
          // 用 mdui 原生 dialog 让用户输入 chat_id + 可选 chat_type
          mdui.dialog({
            headline: '发送到会话（手动）',
            description: '如果会话列表还没加载到，可以手动填写。chat_type：1=私聊 2=群聊 4=机器人',
            content: `
              <mdui-text-field label="chat_id" id="man-chat-id" class="yh-compose-field"></mdui-text-field>
              <mdui-select label="chat_type" id="man-chat-type" value="1" class="yh-compose-field">
                <mdui-menu-item value="1">1 - 私聊</mdui-menu-item>
                <mdui-menu-item value="2">2 - 群聊</mdui-menu-item>
                <mdui-menu-item value="4">4 - 机器人</mdui-menu-item>
              </mdui-select>`,
            actions: [
              { text: '取消' },
              {
                text: '发送', onClick: async (d) => {
                  const idEl = d.querySelector('#man-chat-id');
                  const typeEl = d.querySelector('#man-chat-type');
                  const chatId = idEl ? idEl.value.trim() : '';
                  const chatType = typeEl ? Number(typeEl.value || 1) : 1;
                  if (!chatId) { snack('chat_id 不能为空'); return; }
                  await sendToConv(chatId, chatType, '手动输入');
                }
              },
            ]
          });
          // 恢复默认占位选项（让用户下次仍可再次选择"手动输入"）
          sel.value = '';
          return;
        }
        // 常规选项 value 格式: chatId|chatType|name
        const [chatId, ct, name] = v.split('|');
        sel.value = '';
        await sendToConv(chatId, ct, name);
      });
    });
  }

  // ============ 初始化 ============
  function init() {
    try { window.YHApi.init(); } catch (e) { console.error(e); alert('依赖加载失败：' + e.message); return; }
    bindLogin(); bindNav(); bindChat(); bindContacts(); bindCommunity();
    if (window.YHApi.isLoggedIn()) autoLogin(); else showLogin();
  }

  // ============ 登录 ============
  function showLogin() { $('#login-view').hidden = false; $('#main-view').hidden = true; loadCaptcha(); }
  function hideLogin() { $('#login-view').hidden = true; $('#main-view').hidden = false; }

  function bindLogin() {
    const tabs = $('#login-tabs');
    tabs.addEventListener('change', (e) => {
      const v = e.target.value;
      $$('.yh-panel').forEach(p => p.hidden = (p.dataset.panel !== v));
      if (v === 'phone') loadCaptcha();
    });
    $('#btn-login-token').onclick = () => {
      const t = $('#login-token').value.trim();
      if (!t) return setLoginError('请输入 Token');
      doLogin(() => window.YHApi.loginByToken(t), 'Token 登录失败');
    };
    $('#btn-login-email').onclick = () => {
      const email = $('#login-email').value.trim(), pwd = $('#login-pwd').value;
      if (!email || !pwd) return setLoginError('请输入邮箱和密码');
      doLogin(() => window.YHApi.loginEmail(email, pwd), '邮箱登录失败');
    };
    $('#btn-login-phone').onclick = () => {
      const mobile = $('#login-phone').value.trim(), code = $('#login-sms').value.trim();
      if (!mobile || !code) return setLoginError('请输入手机号和验证码');
      doLogin(() => window.YHApi.loginPhone(mobile, code), '手机号登录失败');
    };
    $('#login-captcha').onclick = loadCaptcha;
    $('#btn-sms').onclick = async () => {
      const mobile = $('#login-phone').value.trim(), code = $('#login-captcha-code').value.trim();
      const id = $('#login-captcha').dataset.id;
      if (!mobile || !code || !id) return setLoginError('请先填写手机号和图片验证码');
      try { const r = await window.YHApi.getSmsCaptcha(mobile, code, id); snack('验证码已发送'); }
      catch (e) { setLoginError(e.message); }
    };
  }

  async function loadCaptcha() {
    try {
      const r = await window.YHApi.getCaptcha();
      if (r && r.code === 1 && r.data) {
        $('#login-captcha').src = r.data.b64s;
        $('#login-captcha').dataset.id = r.data.id;
      }
    } catch (e) { /* 验证码可选 */ }
  }

  function setLoginError(msg) { const el = $('#login-error'); el.textContent = msg; el.hidden = false; }

  async function doLogin(fn, errMsg) {
    setLoginError('');
    try { await fn(); afterLogin(); }
    catch (e) { setLoginError(errMsg + '：' + e.message); }
  }

  async function autoLogin() {
    try { await window.YHApi.loginByToken(window.YHApi.token); afterLogin(); }
    catch (e) { window.YHApi.clearSession(); showLogin(); }
  }

  async function afterLogin() {
    hideLogin();
    await loadProfile();
    connectWS();
    await loadConversations();
    switchView('messages');
    startCronScheduler(); // 启动定时发送调度器
    startAntiRecallPoller(); // 启动防撤回轮询
  }

  async function loadProfile() {
    try { S.profile = await window.YHApi.getProfile(); renderSidebarFooter(); }
    catch (e) { snack('获取个人信息失败：' + e.message); }
  }

  // 桌面端侧边栏底部：显示当前用户头像 + 昵称
  function renderSidebarFooter() {
    const ft = $('#sidebar-footer'); if (!ft || !S.profile || !S.profile.data) return;
    const d = S.profile.data;
    ft.innerHTML = `<div class="yh-sidebar-user">
      ${avatarInner(d.avatar_url, d.name, 32)}
      <span class="yh-sidebar-user-name">${window.YHRender.escapeHtml(d.name || '')}</span>
    </div>`;
    ft.querySelector('.yh-sidebar-user').onclick = () => switchView('profile');
  }

  // ============ WebSocket ============
  function connectWS() {
    window.YHWs.connect(window.YHApi.userId, window.YHApi.token);
    window.YHWs.on('message', onWsMessage);
    window.YHWs.on('edit', onWsEdit);
    window.YHWs.on('board', (b) => { if (S.active && b.chatId === S.active.chatId) snack('机器人公告：' + (b.content || '')); });
    window.YHWs.on('status', (st) => {
      const ind = $('#ws-indicator');
      if (ind) { ind.style.background = st === 'connected' ? '#4caf50' : (st === 'connecting' ? '#ff9800' : '#f44336'); }
    });
  }

  function onWsMessage(msg) {
    if (!msg) return;
    cacheMsgForAntiRecall(msg); // 防撤回缓存
    // 更新会话列表预览
    const conv = S.conversations.find(c => c.chatId === msg.chat_id);
    if (S.active && msg.chat_id === S.active.chatId) {
      appendMessage(msg);
    } else if (conv) {
      conv.chatContent = previewOf(msg);
      conv.timestampMs = msg.send_time || Date.now();
      conv.unreadMessage = 1;
      renderConversations();
    } else {
      // 新会话：刷新列表
      loadConversations();
    }
  }
  function onWsEdit(msg) { /* 简单处理：刷新当前会话 */ if (S.active && msg.chat_id === S.active.chatId) loadMessages(S.active.chatId, S.active.chatType); }

  function previewOf(msg) {
    const c = msg.content || {};
    if (c.text) return c.text;
    if (c.image_url) return '[图片]';
    if (c.file_url) return '[文件] ' + (c.file_name || '');
    if (c.audio_url) return '[语音]';
    if (c.video_url) return '[视频]';
    if (c.sticker_url) return '[表情]';
    if (c.post_title) return '[文章] ' + c.post_title;
    return '[消息]';
  }

  // ============ 导航 ============
  function bindNav() {
    const go = (v) => switchView(v);
    // 桌面端侧边栏导航
    $$('#sidebar .yh-sidebar-item').forEach(item => {
      item.addEventListener('click', () => go(item.dataset.view));
    });
    // 手机端底部导航
    $('#bottom-nav').addEventListener('change', e => go(e.target.value));
  }

  // ============ yunhu:// URL Scheme 解析 ============
  function openYunhuScheme(scheme, id, type) {
    if (!id) { snack('链接缺少 ID 参数'); return; }
    if (scheme === 'chat-add') {
      // type: user→1, group→2, bot→3
      const typeCode = type === 'group' ? 2 : (type === 'bot' ? 3 : 1);
      showDetail(typeCode, id, '');
    } else if (scheme === 'post-detail') {
      // 跳转到社区文章详情
      switchView('community');
      openPost(id);
    } else if (scheme === 'alley-detail') {
      // 跳转到社区分区文章列表
      switchView('community');
      openBaDetail(id);
    } else {
      snack('暂不支持此链接类型：' + scheme);
    }
  }

  function switchView(v) {
    // 离开消息页时停止后台刷新
    if (v !== 'messages') stopMsgRefresh();
    // 更新侧边栏 active 状态
    $$('#sidebar .yh-sidebar-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === v);
    });
    $('#bottom-nav').value = v;
    ['messages', 'contacts', 'community', 'profile'].forEach(name => {
      $('#view-' + name).hidden = (name !== v);
    });
    if (v === 'contacts') loadContacts();
    if (v === 'community') loadRecommend();
    if (v === 'profile') renderProfile();
  }

  // ============ 会话 / 聊天 ============
  async function loadConversations() {
    try {
      // 允许 listConversations 返回 []，但一旦抛错要立刻提示；避免静默导致用户
      // 看到"消息页空空如也、连个报错都没有"。
      const list = await window.YHApi.listConversations();
      S.conversations = Array.isArray(list) ? list : [];
      // 加载置顶列表（与渲染解耦：失败不应把整个会话列表也吞掉）。
      try {
        const sd = await window.YHApi.stickyList();
        if (sd && Array.isArray(sd.sticky)) {
          S._pinned = sd.sticky.map(s => s && (s.chat_id || s.chatId)).filter(Boolean).map(String);
        } else if (Array.isArray(sd)) {
          S._pinned = sd.map(s => s && (s.chat_id || s.chatId)).filter(Boolean).map(String);
        } else {
          S._pinned = S._pinned || [];
        }
      } catch (e) { S._pinned = S._pinned || []; }
      // 排序：置顶优先，再按时间倒序（越新越靠前）
      S.conversations.sort((a, b) => {
        const ap = (S._pinned || []).includes(String(a.chatId)) ? 1 : 0;
        const bp = (S._pinned || []).includes(String(b.chatId)) ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (b.timestampMs || 0) - (a.timestampMs || 0);
      });
      renderConversations();
      // 没有会话时给个可见提示，而不是一片白
      const listEl = $('#conv-list');
      if (!S.conversations.length) {
        const tip = document.createElement('div');
        tip.className = 'yh-empty-tip';
        tip.innerHTML = '还没有会话<br/><span style="opacity:.6;font-size:12px">点击右上角 + 发起聊天</span>';
        if (listEl) listEl.appendChild(tip);
      }
    } catch (e) { snack('获取会话失败：' + e.message); }
  }

  function renderConversations() {
    const list = $('#conv-list'); list.innerHTML = '';
    S.conversations.forEach(conv => {
      const el = document.createElement('div');
      const pinned = (S._pinned || []).includes(String(conv.chatId));
      el.className = 'yh-conv' + (S.active && S.active.chatId === conv.chatId ? ' active' : '') + (pinned ? ' yh-conv-pinned' : '');
      el.style.position = 'relative';
      const dnd = conv.doNotDisturb === 1 ? '<span class="yh-dot-dnd"></span>' : '';
      const unread = conv.unreadMessage === 1 ? `<span class="yh-badge">${conv.at === 1 ? '@' : '•'}</span>` : '';
      const pinMark = pinned ? '<span class="yh-pin-mark">📌</span>' : '';
      el.innerHTML = `<div class="yh-conv-avatar">${avatarHtml(conv.avatarUrl, conv.name, 46)}${dnd}</div>
        <div class="yh-conv-main">
          <div class="yh-conv-name"><span class="t">${pinMark}${window.YHRender.escapeHtml(conv.name || '')}</span><span class="yh-conv-time">${window.YHRender.formatTime(conv.timestampMs)}</span></div>
          <div class="yh-conv-last">${unread}${window.YHRender.escapeHtml(conv.chatContent || '')}</div>
        </div>`;
      el.onclick = () => openChat(conv);
      // 长按置顶/删除
      let pressTimer = null;
      el.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => convMenu(conv, pinned), 500);
      }, { passive: true });
      el.addEventListener('touchend', () => { clearTimeout(pressTimer); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); convMenu(conv, pinned); });
      list.appendChild(el);
    });
  }

  function convMenu(conv, pinned) {
    const d = openDialog(`<div style="padding:8px 0">
      <mdui-list>
        <mdui-list-item id="cm-pin" icon="${pinned ? 'push_pin' : 'push_pin'}">${pinned ? '取消置顶' : '置顶会话'}</mdui-list-item>
        <mdui-list-item id="cm-del" icon="delete">删除会话</mdui-list-item>
      </mdui-list>
    </div>`, { width: 320 });
    d.querySelector('#cm-pin').onclick = async () => {
      try {
        if (pinned) await window.YHApi.stickyDelete(conv.chatId, conv.chatType);
        else await window.YHApi.stickyAdd(conv.chatId, conv.chatType);
        snack(pinned ? '已取消置顶' : '已置顶'); d.open = false; loadConversations();
      } catch (e) { snack(e.message); }
    };
    d.querySelector('#cm-del').onclick = () => {
      d.open = false;
      confirmDialog('删除会话', '确定删除此会话吗？', async () => {
        try { await window.YHApi.removeConversation(conv.chatId); snack('已删除'); loadConversations(); }
        catch (e) { snack(e.message); }
      });
    };
  }

  async function openChat(conv) {
    S.active = { chatId: conv.chatId, chatType: conv.chatType, name: conv.name, avatar: conv.avatarUrl };
    $('#view-messages').classList.add('chat-open');
    $('#chat-empty').hidden = true; $('#chat-active').hidden = false;
    $('#chat-title').textContent = conv.name || '';
    $('#chat-avatar').innerHTML = avatarInner(conv.avatarUrl, conv.name, 36);
    renderConversations();
    // 清未读
    conv.unreadMessage = 0;
    try { await window.YHApi.dismissNotification(conv.chatId); } catch (e) {}
    S._histHasMore = true; S._histLoading = false;
    await loadMessages(conv.chatId, conv.chatType);
    startMsgRefresh();
  }

  async function loadMessages(chatId, chatType) {
    try {
      const msgs = await window.YHApi.getMessages(chatId, chatType, 30);
      // 列表接口返回的顺序通常是"从新到旧"（最近一条放最前），而展示我们要求
      // "新的在下面（靠输入框一侧）" → 需要按时间升序稳定排序。
      // 先按 send_time（秒/毫秒都兼容）升序，再按 msg_seq 保证同秒两条消息有稳定顺序。
      const ordered = [...msgs].sort((a, b) => {
        const ta = (a && (a.send_time || a.sendTime || a.msg_seq || 0)) * 1 || 0;
        const tb = (b && (b.send_time || b.sendTime || b.msg_seq || 0)) * 1 || 0;
        if (ta !== tb) return ta - tb;
        const sa = (a && (a.msg_seq || a.msgSeq)) * 1 || 0;
        const sb = (b && (b.msg_seq || b.msgSeq)) * 1 || 0;
        return sa - sb;
      });
      S.messages = ordered.map(m => window.YHWs ? normalizeRest(m) : m);
      // 防撤回：缓存加载的消息
      S.messages.forEach(m => cacheMsgForAntiRecall(m));
      renderMessages();
    } catch (e) { snack('获取消息失败：' + e.message); }
  }

  // ============ 消息/会话后台定时刷新 ============
  function startMsgRefresh() {
    stopMsgRefresh();
    // 每 15 秒拉取一次最新消息（WS 断线时的兜底）
    S._msgTimer = setInterval(refreshMessages, 15000);
    // 每 30 秒刷新会话列表（更新未读数 / 最新消息预览）
    S._convTimer = setInterval(() => { if (S.active || S.conversations.length) loadConversations(); }, 30000);
  }
  function stopMsgRefresh() {
    if (S._msgTimer) { clearInterval(S._msgTimer); S._msgTimer = 0; }
    if (S._convTimer) { clearInterval(S._convTimer); S._convTimer = 0; }
  }
  // 后台静默拉取新消息：与已有列表去重后追加
  async function refreshMessages() {
    if (!S.active) return;
    try {
      const msgs = await window.YHApi.getMessages(S.active.chatId, S.active.chatType, 30);
      const existingIds = new Set(S.messages.map(m => m.msg_id));
      const newMsgs = (msgs || []).filter(m => !existingIds.has(m.msg_id))
        .map(m => window.YHWs ? normalizeRest(m) : m);
      if (!newMsgs.length) return;
      // 按时间升序排列
      newMsgs.sort((a, b) => {
        const ta = (a && (a.send_time || a.msg_seq || 0)) * 1 || 0;
        const tb = (b && (b.send_time || b.msg_seq || 0)) * 1 || 0;
        return ta - tb;
      });
      newMsgs.forEach(m => appendMessage(m));
    } catch (e) { /* 后台刷新静默失败 */ }
  }

  // ============ 聊天历史：滚到顶部加载更早消息 ============
  async function loadEarlierMessages() {
    if (!S.active || S._histLoading || !S._histHasMore || !S.messages.length) return;
    S._histLoading = true;
    const box = $('#chat-messages');
    const oldScrollHeight = box.scrollHeight;
    const oldScrollTop = box.scrollTop;
    // 取最早一条消息的 msg_id 作为游标
    const oldest = S.messages[0];
    const cursorId = oldest && (oldest.msg_id || oldest.msgId);
    if (!cursorId) { S._histLoading = false; return; }
    // 顶部加载指示器
    const indicator = document.createElement('div');
    indicator.className = 'yh-hist-loading';
    indicator.innerHTML = '<span class="material-icons yh-hist-spin">refresh</span> 加载中…';
    box.insertBefore(indicator, box.firstChild);
    try {
      const msgs = await window.YHApi.getMessages(S.active.chatId, S.active.chatType, 30, cursorId);
      const existingIds = new Set(S.messages.map(m => m.msg_id));
      const older = (msgs || []).filter(m => !existingIds.has(m.msg_id))
        .map(m => window.YHWs ? normalizeRest(m) : m);
      indicator.remove();
      if (!older.length) { S._histHasMore = false; return; }
      // 按时间升序排列（最旧的在最前）
      older.sort((a, b) => {
        const ta = (a && (a.send_time || a.msg_seq || 0)) * 1 || 0;
        const tb = (b && (b.send_time || b.msg_seq || 0)) * 1 || 0;
        return ta - tb;
      });
      // 在列表头部插入旧消息
      const myId = window.YHApi.userId;
      older.forEach(m => {
        const showName = m.sender && m.sender.chat_id !== myId;
        const bubble = window.YHRender.renderBubble(m, { showName });
        box.insertBefore(bubble, box.firstChild);
      });
      S.messages = older.concat(S.messages);
      // 保持滚动位置不变（不跳到顶部）
      const newScrollHeight = box.scrollHeight;
      box.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
      bindMessageEvents(box);
    } catch (e) { indicator.remove(); }
    finally { S._histLoading = false; }
  }

  // ============ 消息列表下拉刷新 ============
  function bindPullRefresh() {
    const container = $('#conv-list');
    if (!container || container._pullBound) return;
    container._pullBound = true;
    // 创建下拉指示器
    const indicator = document.createElement('div');
    indicator.className = 'yh-pull-refresh';
    indicator.innerHTML = '<span class="material-icons yh-pull-ico">arrow_downward</span><span class="yh-pull-txt">下拉刷新</span>';
    container.parentElement.insertBefore(indicator, container);

    const THRESHOLD = 60;
    let startY = 0, pulling = false, dist = 0;

    // 触摸下拉（移动端）
    container.addEventListener('touchstart', (e) => {
      if (container.scrollTop <= 0) { startY = e.touches[0].clientY; pulling = true; dist = 0; }
    }, { passive: true });
    container.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      dist = e.touches[0].clientY - startY;
      if (dist > 0) {
        indicator.style.height = Math.min(dist, 80) + 'px';
        indicator.style.opacity = Math.min(dist / THRESHOLD, 1);
        const ico = indicator.querySelector('.yh-pull-ico');
        const txt = indicator.querySelector('.yh-pull-txt');
        if (dist >= THRESHOLD) { ico.style.transform = 'rotate(180deg)'; txt.textContent = '释放刷新'; }
        else { ico.style.transform = ''; txt.textContent = '下拉刷新'; }
      }
    }, { passive: true });
    container.addEventListener('touchend', () => {
      if (!pulling) return;
      pulling = false;
      if (dist >= THRESHOLD) {
        indicator.style.height = '40px';
        indicator.querySelector('.yh-pull-ico').style.transform = 'rotate(180deg)';
        indicator.querySelector('.yh-pull-txt').textContent = '刷新中…';
        loadConversations().then(() => {
          indicator.style.height = '0'; indicator.style.opacity = '0';
        });
      } else {
        indicator.style.height = '0'; indicator.style.opacity = '0';
      }
      dist = 0;
    });

    // 鼠标滚轮到顶部（桌面端）
    container.addEventListener('wheel', (e) => {
      if (container.scrollTop <= 0 && e.deltaY < 0 && !S._pulling) {
        S._pulling = true;
        indicator.style.height = '40px'; indicator.style.opacity = '1';
        indicator.querySelector('.yh-pull-ico').style.transform = 'rotate(180deg)';
        indicator.querySelector('.yh-pull-txt').textContent = '刷新中…';
        loadConversations().then(() => {
          indicator.style.height = '0'; indicator.style.opacity = '0';
          setTimeout(() => { S._pulling = false; }, 1000);
        });
      }
    }, { passive: true });
  }

  function normalizeRest(m) {
    return {
      msg_id: m.msg_id, sender: m.sender ? { chat_id: m.sender.chat_id, chat_type: m.sender.chat_type, name: m.sender.name, avatar_url: m.sender.avatar_url } : null,
      recv_id: m.recv_id, chat_id: m.chat_id, chat_type: m.chat_type, content_type: m.content_type,
      content: m.content || {}, send_time: m.send_time, msg_seq: m.msg_seq, quote_msg_id: m.quote_msg_id, cmd: m.cmd ? (m.cmd.name || m.cmd) : null
    };
  }

  // 统一把滚动容器滚到底部：
  // 1) 先 requestAnimationFrame 一次，等 layout/reflow（浏览器在 appendChild 后未必立刻更新 scrollHeight）
  // 2) 再把 scrollTop 设成最大值（scrollHeight - clientHeight），比直接 = scrollHeight 更稳
  //    （部分浏览器 / 部分字体下 scrollHeight 本身可能在 overflow:overlay/scrollbar-gutter 变化时抖动）
  // 3) 再补一次 rAF 兜底，处理 mdui 组件 / 字体 / 图片加载引起的二次尺寸变化。
  function scrollMessagesToBottom() {
    const box = $('#chat-messages');
    if (!box) return;
    const gotoBottom = () => { try { box.scrollTop = box.scrollHeight - box.clientHeight; } catch (_) {} };
    requestAnimationFrame(() => {
      gotoBottom();
      requestAnimationFrame(gotoBottom);
    });
  }

  function renderMessages() {
    const box = $('#chat-messages'); box.innerHTML = '';
    const myId = window.YHApi.userId;
    S.messages.forEach((m, i) => {
      const prev = S.messages[i - 1];
      const showName = m.sender && m.sender.chat_id !== myId && (!prev || prev.sender && prev.sender.chat_id !== m.sender.chat_id);
      box.appendChild(window.YHRender.renderBubble(m, { showName }));
    });
    bindMessageEvents(box);
    scrollMessagesToBottom();
  }

  function appendMessage(msg) {
    if (msg.msg_id && S.messages.some(m => m.msg_id === msg.msg_id)) return; // 去重
    const myId = window.YHApi.userId;
    const showName = msg.sender && msg.sender.chat_id !== myId;
    const box = $('#chat-messages');
    // 只有当用户离底部已经很近（<120px，说明他本来就等着看新消息）时才自动滚到底；
    // 否则保留用户的阅读位置（比如正在翻历史消息，不应被新消息打断）。
    const shouldAutoScroll = box
      ? (box.scrollHeight - box.clientHeight - box.scrollTop) < 120
      : true;
    box.appendChild(window.YHRender.renderBubble(msg, { showName }));
    bindMessageEvents(box);
    S.messages.push(msg);
    if (shouldAutoScroll) scrollMessagesToBottom();
  }

  function bindMessageEvents(box) {
    $$('.yh-img', box).forEach(img => img.onclick = () => openImage(img.dataset.url || img.src));
    $$('.yh-post', box).forEach(p => p.onclick = () => openPost(p.dataset.post));
    $$('.yh-a2ui-btn', box).forEach(b => b.onclick = async () => {
      const bubble = b.closest('.yh-msg');
      const msgId = bubble ? bubble.dataset.msgId : '';
      if (!S.active) return;
      try { await window.YHApi.buttonReport(msgId, S.active.chatType, S.active.chatId, b.dataset.value); snack('已提交：' + b.textContent); }
      catch (e) { snack('操作失败：' + e.message); }
    });
    // 长按 & 右键 消息气泡：弹出 action sheet
    $$('.yh-msg', box).forEach(el => bindMsgPress(el));
    // yunhu:// url_scheme 链接点击
    $$('.yh-yunhu-link', box).forEach(link => {
      link.onclick = () => openYunhuScheme(link.dataset.scheme, link.dataset.id, link.dataset.type);
    });
  }

  // 可编辑消息的 content_type 白名单：TEXT / MARKDOWN / HTML / FORM（文本类）
  function canEditContentType(ctStr) {
    const ct = Number(ctStr) || 0;
    return ct === CT.TEXT || ct === CT.MARKDOWN || ct === CT.HTML || ct === CT.FORM;
  }
  function msgDataFromEl(el) {
    if (el.dataset.kind === 'comment') {
      return {
        kind: 'comment',
        commentId: el.dataset.commentId || '',
        postId: el.dataset.postId || (S._lastPostId || ''),
        isSelf: el.dataset.isSelf === '1',
        senderName: el.dataset.senderName || '匿名',
        senderChatId: el.dataset.senderId || '',
        text: el.dataset.text || ''
      };
    }
    return {
      kind: 'msg',
      msgId: el.dataset.msgId || '',
      isSelf: el.dataset.isSelf === '1',
      senderName: el.dataset.senderName || '',
      senderChatId: el.dataset.senderChatId || '',
      chatId: el.dataset.chatId || (S.active && S.active.chatId) || '',
      chatType: Number(el.dataset.chatType) || (S.active && S.active.chatType) || 0,
      contentType: Number(el.dataset.contentType) || CT.TEXT,
      text: el.dataset.previewText || '',
      quoteMsgId: el.dataset.quoteMsgId || '',
      quoteMsgText: el.dataset.quoteMsgText || '',
      quoteImageUrl: el.dataset.quoteImageUrl || '',
      quoteVideoUrl: el.dataset.quoteVideoUrl || ''
    };
  }
  function bindMsgPress(el) {
    const start = (e, pointFn) => {
      // 不要在图片/链接上长按误触发：忽略这些节点
      const t = e.target;
      if (t.closest && (t.closest('a') || t.closest('button') || t.closest('.yh-img') || t.closest('.yh-a2ui-btn'))) return;
      const cancel = () => {
        clearTimeout(S.longPressTimer);
        S.longPressTimer = 0;
        if (S.longPressedEl) { S.longPressedEl.classList.remove('yh-msg-active'); S.longPressedEl = null; }
      };
      cancel();
      S.longPressedEl = el;
      S.longPressTimer = setTimeout(() => {
        S.longPressTimer = 0;
        try { if (navigator.vibrate) navigator.vibrate(10); } catch (_) {}
        el.classList.add('yh-msg-active');
        openMsgActionSheet(el, pointFn(e));
      }, 380);
      // 触摸移动 / 滚动 / 松手 < 380ms 时取消
      const cleanup = () => { cancel(); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', cleanup); el.removeEventListener('touchcancel', cleanup); el.removeEventListener('mousemove', move); el.removeEventListener('mouseup', cleanup); el.removeEventListener('mouseleave', cleanup); };
      const move = (ev) => {
        const p1 = pointFn(ev); const p0 = pointFn(e);
        if (Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y) > 10) cleanup();
      };
      el.addEventListener('touchmove', move, { passive: true });
      el.addEventListener('touchend', cleanup, { passive: true, once: true });
      el.addEventListener('touchcancel', cleanup, { once: true });
      el.addEventListener('mousemove', move);
      el.addEventListener('mouseup', cleanup, { once: true });
      el.addEventListener('mouseleave', cleanup);
    };
    el.addEventListener('touchstart', (e) => start(e, ev => {
      const t = (ev.touches && ev.touches[0]) || ev;
      return { x: t.clientX || 0, y: t.clientY || 0 };
    }), { passive: true });
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      start(e, ev => ({ x: ev.clientX, y: ev.clientY }));
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearTimeout(S.longPressTimer); S.longPressTimer = 0;
      if (S.longPressedEl) { S.longPressedEl.classList.remove('yh-msg-active'); }
      S.longPressedEl = el;
      el.classList.add('yh-msg-active');
      openMsgActionSheet(el, { x: e.clientX, y: e.clientY });
    });
  }

  function openMsgActionSheet(el, point) {
    const d = msgDataFromEl(el);
    // ============ 评论（社区文章） ============
    if (d.kind === 'comment') {
      const items = [];
      // 复制
      items.push({ icon: 'content_copy', label: '复制文本', fn: () => copyText(d.text || '') });
      // 回复：任何评论都可以回复（引用 @对方 + commentId 传给 createComment 的 commentId 形参）
      items.push({ icon: 'reply', label: '回复', fn: () => startCommentReply(d) });
      // 删除：仅自己
      if (d.isSelf) items.push({ icon: 'delete', label: '删除', danger: true, fn: () => doDeleteComment(d) });
      if (!items.length) return closeMsgSheet();
      renderMsgActionSheet(el, point, items); return;
    }
    // ============ 私聊/群聊 消息 ============
    // Material Icons (经典字体) 的正式 ligature 名字要选"该字体实际包含"的条目：
    //   - 引用：format_quote 在 material-icons 里存在（不是 format_quote_outlined）
    //   - 复制：content_copy 存在
    //   - 编辑：edit 存在（不是 edit_note）
    //   - 撤销：material-icons 没有 delete_sweep/restore_from_trash，用 backspace 删除语义最贴
    // 之前用 material-symbols-outlined 家族名是错的，和项目实际加载的 'Material Icons'
    // 字体不匹配，ligature 全部解析成"不认识的词"→ 退回字体 fallback 显示为空块。
    const items = [];
    items.push({ icon: 'format_quote', label: '引用', fn: () => startQuoting(d) });
    if (d.text && /^(\[图片\]|\[视频\]|\[语音\]|\[文件\])/.test(d.text) === false) {
      items.push({ icon: 'content_copy', label: '复制文本', fn: () => copyText(d.text) });
    } else {
      items.push({ icon: 'content_copy', label: '复制', fn: () => copyText(d.text || '') });
    }
    // 仅自己消息允许编辑/撤销；仅文本类消息允许编辑
    if (d.isSelf && canEditContentType(d.contentType) && d.text) {
      items.push({ icon: 'edit', label: '编辑', fn: () => startEditing(d) });
    }
    if (d.isSelf) {
      items.push({ icon: 'backspace', label: '撤销', danger: true, fn: () => doRecall(d) });
    }
    if (!items.length) return closeMsgSheet();
    renderMsgActionSheet(el, point, items);
  }

  // 共享 sheet 渲染：桌面端走右键式上下文菜单；移动端走底部 sheet
  function renderMsgActionSheet(el, point, items) {
    const isDesktop = !matchMedia('(pointer: coarse)').matches && matchMedia('(min-width: 840px)').matches;
    if (isDesktop) return renderDesktopMenu(el, point, items);
    // ---- 移动端：底部 sheet ----
    let sheet = document.getElementById('yh-msg-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'yh-msg-sheet';
      sheet.innerHTML = `
        <div class="yh-sheet-mask"></div>
        <div class="yh-sheet-panel" role="dialog" aria-modal="true" aria-label="操作">
          <div class="yh-sheet-anchor"></div>
          <div class="yh-sheet-actions"></div>
          <button type="button" class="yh-sheet-cancel">取消</button>
        </div>`;
      sheet.querySelector('.yh-sheet-mask').addEventListener('click', closeMsgSheet);
      sheet.querySelector('.yh-sheet-cancel').addEventListener('click', closeMsgSheet);
      document.body.appendChild(sheet);
    }
    const box = sheet.querySelector('.yh-sheet-actions');
    box.innerHTML = '';
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yh-sheet-item' + (it.danger ? ' danger' : '');
      b.innerHTML = `<span class="material-icons yh-sheet-ico">${it.icon}</span><span class="yh-sheet-lbl">${it.label}</span>`;
      b.addEventListener('click', () => { closeMsgSheet(); it.fn && it.fn(); });
      box.appendChild(b);
    });
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add('open'));
    const panel = sheet.querySelector('.yh-sheet-panel');
    panel.classList.add('bottom-sheet');
    panel.style.top = ''; panel.style.left = '';
    sheet.querySelector('.yh-sheet-anchor').hidden = true;
  }

  // 桌面端上下文菜单：无遮罩、无取消按钮，点击外部/Escape 关闭
  function renderDesktopMenu(el, point, items) {
    closeMsgSheet();
    let menu = document.getElementById('yh-ctx-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'yh-ctx-menu';
      menu.className = 'yh-ctx-menu';
      document.body.appendChild(menu);
    }
    menu.innerHTML = '';
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yh-sheet-item' + (it.danger ? ' danger' : '');
      b.innerHTML = `<span class="material-icons yh-sheet-ico">${it.icon}</span><span class="yh-sheet-lbl">${it.label}</span>`;
      b.addEventListener('click', () => { closeMsgSheet(); it.fn && it.fn(); });
      menu.appendChild(b);
    });
    // 定位到鼠标/消息旁
    const menuW = 220, itemH = 44, menuH = itemH * items.length + 12;
    let left = point.x;
    let top = point.y;
    if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 8;
    if (top + menuH > window.innerHeight) top = Math.max(8, window.innerHeight - menuH - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.hidden = false;
    requestAnimationFrame(() => menu.classList.add('open'));
    // 点击外部或 Escape 关闭
    const handler = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.target && menu.contains(e.target)) return;
      closeMsgSheet();
      document.removeEventListener('click', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
    setTimeout(() => {
      document.addEventListener('click', handler, true);
      document.addEventListener('keydown', handler, true);
    }, 0);
  }

  function closeMsgSheet() {
    const sheet = document.getElementById('yh-msg-sheet');
    if (sheet) { sheet.classList.remove('open'); setTimeout(() => { sheet.hidden = true; }, 180); }
    const menu = document.getElementById('yh-ctx-menu');
    if (menu) { menu.classList.remove('open'); setTimeout(() => { menu.hidden = true; }, 120); }
    if (S.longPressedEl) { S.longPressedEl.classList.remove('yh-msg-active'); S.longPressedEl = null; }
  }

  async function copyText(t) {
    if (!t) { snack('无文本可复制'); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
        snack('已复制'); return;
      }
    } catch (_) {}
    // fallback: textarea
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); snack('已复制'); }
    catch { snack('复制失败'); }
    finally { document.body.removeChild(ta); }
  }

  // ========== 引用 ==========
  function startQuoting(d) {
    S.quoting = {
      msgId: d.msgId,
      senderName: d.senderName || '对方',
      previewText: d.text || '',
      contentType: d.contentType
    };
    // 进入编辑态时，如果本身是引用他人消息的，不会再继承原引用（避免级联嵌套）——
    // 但如果目标消息本身有 quoteMsgText（是对 A 的引用），把它合并为预览内容里的前缀。
    if (d.quoteMsgText || d.quoteImageUrl || d.quoteVideoUrl) {
      const prefix = d.quoteImageUrl ? '[图片]' : (d.quoteVideoUrl ? '[视频]' : (d.quoteMsgText || ''));
      if (prefix) S.quoting.previewText = (S.quoting.previewText ? S.quoting.previewText : '') +
        (S.quoting.previewText ? '  \n↩ ' : '') + '引用: ' + prefix;
    }
    // 取消可能进行中的编辑态
    if (S.editing) { S.editing = null; updateActionBar(); }
    updateActionBar();
    const inp = $('#chat-input');
    inp.focus();
    try { inp.rows = Math.max(1, Math.min(4, inp.value.split('\n').length + 1)); } catch (_) {}
  }
  // ========== 编辑 ==========
  function startEditing(d) {
    S.editing = { msgId: d.msgId, contentType: d.contentType, originalText: d.text || '' };
    if (S.quoting) { S.quoting = null; }
    const inp = $('#chat-input');
    inp.value = d.text || '';
    try { inp.rows = Math.max(1, Math.min(4, inp.value.split('\n').length + 1)); } catch (_) {}
    updateActionBar();
    inp.focus();
    // 光标置于末尾
    const len = inp.value.length;
    try { if (inp.setSelectionRange) inp.setSelectionRange(len, len); } catch (_) {}
  }
  function cancelActionMode() {
    S.quoting = null; S.editing = null;
    updateActionBar();
    const inp = $('#chat-input'); if (inp) inp.value = '';
  }
  function updateActionBar() {
    const bar = $('#chat-action-bar');
    const preview = $('#chat-action-preview');
    const sendBtn = $('#btn-send');
    const saveBtn = $('#btn-edit-save');
    const inp = $('#chat-input');
    bar.hidden = !(S.quoting || S.editing);
    if (S.editing) {
      const label = S.editing.contentType === CT.MARKDOWN ? '（Markdown）'
        : (S.editing.contentType === CT.HTML ? '（HTML）' : '');
      preview.innerHTML = `<div class="yh-ac-title">正在编辑消息 ${label}</div>` +
        `<div class="yh-ac-text">${window.YHRender.escapeHtml((S.editing.originalText || '').slice(0, 120))}${S.editing.originalText && S.editing.originalText.length > 120 ? '…' : ''}</div>`;
      sendBtn.hidden = true; saveBtn.hidden = false;
      inp.setAttribute('placeholder', '编辑消息内容…');
    } else if (S.quoting) {
      preview.innerHTML = `<div class="yh-ac-title">回复 ${window.YHRender.escapeHtml(S.quoting.senderName)} ${S.quoting.msgId ? `<span class="yh-ac-mid">#${window.YHRender.escapeHtml(String(S.quoting.msgId).slice(-6))}</span>` : ''}</div>` +
        `<div class="yh-ac-text">${window.YHRender.escapeHtml((S.quoting.previewText || '').slice(0, 120))}${S.quoting.previewText && S.quoting.previewText.length > 120 ? '…' : ''}</div>`;
      sendBtn.hidden = false; saveBtn.hidden = true;
      inp.setAttribute('placeholder', '回复消息…');
    } else {
      sendBtn.hidden = false; saveBtn.hidden = true;
      inp.setAttribute('placeholder', '发消息…');
    }
  }

  async function saveEdit() {
    if (!S.editing || !S.active) return;
    const inp = $('#chat-input');
    const text = inp.value;
    // 没改就算了
    if (text === S.editing.originalText) { cancelActionMode(); snack('未修改'); return; }
    const ct = Number(S.editing.contentType) || CT.TEXT;
    const opts = {};
    if (ct === CT.MARKDOWN) opts.markdown = text;
    else if (ct === CT.HTML) opts.html = text;
    // FORM 暂不开放编辑（要保留 JSON 完整性，直接当文本改太危险），强行回落 TEXT 编辑
    else opts.text = text;
    try {
      await window.YHApi.editMessage(S.editing.msgId, S.active.chatId, S.active.chatType, opts);
      snack('已编辑');
      cancelActionMode();
      await loadMessages(S.active.chatId, S.active.chatType);
    } catch (e) { snack('编辑失败：' + e.message); }
  }

  async function doRecall(d) {
    if (!d.isSelf) { snack('只能撤销自己的消息'); return; }
    const ok = confirm(`确定要撤销这条消息吗？\n${(d.text || '').slice(0, 60)}${d.text && d.text.length > 60 ? '…' : ''}`);
    if (!ok) return;
    try {
      await window.YHApi.recallMessage(d.msgId, S.active.chatId, S.active.chatType);
      snack('已撤销');
      if (S.active) await loadMessages(S.active.chatId, S.active.chatType);
    } catch (e) { snack('撤销失败：' + e.message); }
  }

  // ========== 评论：回复 / 删除 辅助 ==========
  function startCommentReply(d) {
    if (!d.commentId) { snack('目标评论缺失 ID'); return; }
    S._replyingComment = {
      commentId: d.commentId,
      postId: d.postId || S._lastPostId,
      senderName: d.senderName || '对方',
      text: d.text || ''
    };
    renderCommentActionBar();
    const inp = document.querySelector('#comment-input');
    if (inp) { inp.focus(); try { inp.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {} }
  }
  async function doDeleteComment(d) {
    if (!d.isSelf) { snack('只能删除自己的评论'); return; }
    const ok = confirm(`确定要删除这条评论吗？\n${(d.text || '').slice(0, 80)}${d.text && d.text.length > 80 ? '…' : ''}`);
    if (!ok) return;
    try {
      const postId = d.postId || S._lastPostId;
      await window.YHApi.deleteComment(postId, d.commentId);
      snack('已删除');
      if (postId) await loadComments(postId);
    } catch (e) { snack('删除失败：' + e.message); }
  }
  function renderCommentActionBar() {
    const bar = document.querySelector('#comment-action-bar');
    const preview = document.querySelector('#comment-action-preview');
    if (!bar || !preview) return;
    const r = S._replyingComment;
    if (!r) { bar.hidden = true; return; }
    bar.hidden = false;
    preview.innerHTML = `<div class="yh-ac-title">回复 ${window.YHRender.escapeHtml(r.senderName || '对方')}</div>` +
      `<div class="yh-ac-text">${window.YHRender.escapeHtml((r.text || '').slice(0, 120))}${r.text && r.text.length > 120 ? '…' : ''}</div>`;
  }

  function openImage(url) {
    const ov = document.createElement('div'); ov.className = 'yh-img-preview';
    ov.innerHTML = `<img src="${window.YHRender.escapeHtml(window.YHApi.mediaUrl(url))}"/>`;
    ov.onclick = () => ov.remove();
    document.body.appendChild(ov);
  }

  // ============ 发送 ============
  function bindChat() {
    $('#btn-send').onclick = sendText;
    const saveBtn = $('#btn-edit-save'); if (saveBtn) saveBtn.onclick = saveEdit;
    const cancelBtn = $('#chat-action-cancel'); if (cancelBtn) cancelBtn.onclick = cancelActionMode;
    const input = $('#chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        // 编辑态 Enter = 保存；引用态 Enter = 立即发送含引用
        e.preventDefault();
        if (S.editing) saveEdit(); else sendText();
      }
      // Escape 取消编辑/引用
      if (e.key === 'Escape' && (S.editing || S.quoting)) {
        e.preventDefault();
        cancelActionMode();
      }
    });
    // 全局 Escape：关闭图片预览
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const preview = $('.yh-img-preview');
        if (preview) { preview.remove(); return; }
      }
    });
    input.addEventListener('input', () => { if (S.active) window.YHWs.sendDraft(S.active.chatId, input.value); });
    $('#btn-chat-back').onclick = () => { $('#view-messages').classList.remove('chat-open'); S.active = null; stopMsgRefresh(); cancelActionMode(); renderConversations(); };
    $('#btn-chat-info').onclick = () => { if (S.active) showDetail(S.active.chatType, S.active.chatId, S.active.name); };
    $('#btn-search').onclick = openSearch;
    $('#btn-new-chat').onclick = openSearch;
    // 聊天消息滚到顶部自动加载更早消息
    const msgBox = $('#chat-messages');
    if (msgBox) {
      msgBox.addEventListener('scroll', () => {
        if (msgBox.scrollTop < 60) loadEarlierMessages();
      }, { passive: true });
    }
    // 会话列表下拉刷新
    bindPullRefresh();
    // 聊天输入栏左边：把“图片链接 / 文件链接 / 语音链接 / 视频链接”改成一个
    // <select> 下拉（见 index.html）。点“+”展开菜单项的路径不再使用。
    const attachSel = $('#attach-select');
    if (attachSel) {
      attachSel.addEventListener('change', (e) => {
        const kind = e.target.value;
        // 无论用户点了哪个，最后都复位到占位选项，下次还能重复选同一个
        e.target.value = '';
        if (!kind || !S.active) return;
        const map = {
          img: ['图片链接', CT.IMAGE, 'image'],
          file: ['文件链接', CT.FILE, 'file'],
          audio: ['语音链接', CT.AUDIO, 'audio'],
          video: ['视频链接', CT.VIDEO, 'video'],
        };
        const [label, ct, field] = map[kind] || [];
        if (!label) return;
        const url = prompt('输入' + label + '（直链 URL）：');
        if (url) sendPayload({ [field]: url, contentType: ct });
      });
    }
  }

  async function sendText() {
    const input = $('#chat-input');
    const text = input.value;
    // 引用态允许空 text 发送（"纯引用"提醒），编辑态必须有文字
    if (S.editing) {
      // sendText 在编辑态不触发保存（点 Enter 会走 saveEdit）；若误进这里直接返回
      return;
    }
    if (!S.quoting && !text.trim()) return;
    if (!S.active) return;
    await sendPayload({ text: text.trim(), contentType: CT.TEXT });
    input.value = '';
    try { input.rows = 1; } catch (_) {}
  }

  async function sendPayload(opts) {
    if (!S.active) return;
    const payload = Object.assign({ chatId: S.active.chatId, chatType: S.active.chatType }, opts);
    // 引用态：自动贴 quoteMsgId + quoteMsgText
    if (S.quoting) {
      payload.quoteMsgId = S.quoting.msgId;
      if (!payload.quoteMsgText) payload.quoteMsgText = S.quoting.previewText || '';
    }
    try {
      await window.YHApi.sendMessage(payload);
      // 发送成功后清除引用态；编辑态不走这里（走 saveEdit）
      S.quoting = null; updateActionBar();
      // 重新拉取最新消息以显示自己发出内容
      await loadMessages(S.active.chatId, S.active.chatType);
    } catch (e) { snack('发送失败：' + e.message); }
  }

  // ============ 搜索 ============
  async function openSearch() {
    const d = openDialog(`<div style="padding:16px">
      <mdui-text-field id="search-input" label="搜索用户 / 群聊 / 机器人" class="yh-full"></mdui-text-field>
      <div id="search-results" style="margin-top:12px"></div></div>`, { width: 520 });
    const inp = d.querySelector('#search-input');
    const res = d.querySelector('#search-results');
    const run = async () => {
      const w = inp.value.trim(); if (!w) return;
      try {
        const data = await window.YHApi.search(w);
        res.innerHTML = '';
        (data.list || []).forEach(cat => {
          const label = (cat.type_name || cat.list_name || '').toString();
          if (cat.list && cat.list.length) {
            res.insertAdjacentHTML('beforeend', `<div class="yh-cat-head">${window.YHRender.escapeHtml(label) || '搜索结果'}</div>`);
          }
          (cat.list || []).forEach(it => {
            const el = document.createElement('div'); el.className = 'yh-contact-item';
            const id = it.friendId || it.friend_id || it.id || '';
            const name = it.nickname || it.name || '';
            const typeCode = it.friendType != null ? it.friendType : (it.chat_type != null ? it.chat_type : 0);
            const typeLabel = typeName(typeCode);
            // 用户要求：搜索结果里的"板块/分区"也要显示 ID 并能点击进入 → 同时对
            // 用户/群聊/机器人统一显示 ID，点击按类型开对应详情：群(2)→群详情，
            // 机器人(3)→机器人详情，用户(1)→用户详情，其他→打开聊天。
            const idChip = id
              ? `<span class="yh-ba-id">#${window.YHRender.escapeHtml(String(id))}</span>`
              : '';
            el.innerHTML =
              `${avatarHtml(it.avatarUrl || it.avatar_url, name, 40)}
               <div style="flex:1;min-width:0">
                 <div class="yh-contact-name" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                   ${window.YHRender.escapeHtml(name)}${idChip}
                 </div>
                 <div class="yh-contact-sub">${typeLabel} · ID: <code>${window.YHRender.escapeHtml(String(id || '—'))}</code></div>
               </div>`;
            el.onclick = () => {
              d.open = false;
              // 群聊 / 机器人 → 先打开详情（含邀请成员 / 介绍 / 加群按钮）；用户和未知类型走打开聊天。
              if (typeCode === 2 || typeCode === 3) {
                showDetail(typeCode, id, name);
              } else {
                openChat({ chatId: id, chatType: Number(typeCode || 1), name, avatarUrl: it.avatarUrl || it.avatar_url });
              }
            };
            res.appendChild(el);
          });
        });
        if (!res.children.length) res.innerHTML = '<div class="yh-contact-sub">无结果</div>';
      } catch (e) { res.innerHTML = '<div class="yh-error">' + window.YHRender.escapeHtml(e.message) + '</div>'; }
    };
    inp.addEventListener('input', debounce(run, 400));
    setTimeout(() => inp.focus(), 100);
  }
  function typeName(t) { return ({ 1: '用户', 2: '群聊', 3: '机器人' })[t] || '未知'; }
  function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

  // ============ 联系人 ============
  function bindContacts() {
    $('#contacts-tabs').addEventListener('change', e => {
      const v = e.target.value;
      $('#contacts-body').dataset.tab = v;
      if (v === 'book') renderAddressBook(S._book); else renderRequests(S._reqs);
    });
  }
  async function loadContacts() {
    try {
      const book = await window.YHApi.addressBook(); S._book = book;
      const reqs = await window.YHApi.friendRequests(); S._reqs = reqs;
      const tab = ($('#contacts-body').dataset.tab) || 'book';
      if (tab === 'book') renderAddressBook(book); else renderRequests(reqs);
    } catch (e) { snack('获取联系人失败：' + e.message); }
  }
  function renderAddressBook(book) {
    const body = $('#contacts-body'); body.innerHTML = '';
    // 通讯录按 list_name 分类展示。服务端在 AddressBookListResponse.Data.chat_type 字段（field 3）
    // 直接给出类别（1=用户 2=群聊 3=机器人），优先使用它；若缺失则按 list_name 文案推断。
    function inferType(ln) {
      const s = (ln || '').toLowerCase();
      if (s.includes('群') || s.includes('group')) return 2;
      if (s.includes('机器') || s.includes('bot')) return 3;
      return 1;
    }
    const map = new Map(); // key = list_name, value = { label, t, items }
    (book || []).forEach(group => {
      const ln = group.list_name || '联系人';
      // group.chat_type 由 proto.js 解析（int32），无则为 0 -> 用 list_name 推断
      const t = group.chat_type ? group.chat_type : inferType(ln);
      if (!map.has(ln)) map.set(ln, { label: ln, t, items: [] });
      const cat = map.get(ln);
      (group.data || group.DataList || []).forEach(it => cat.items.push(it));
    });
    // 按类型排序：用户(1) → 群聊(2) → 机器人(3) → 其他
    const cats = [...map.values()].sort((a, b) => a.t - b.t);
    cats.forEach(cat => {
      if (!cat.items.length) return;
      const g = document.createElement('div'); g.className = 'yh-contact-group';
      g.innerHTML = `<div class="yh-cat-head">${window.YHRender.escapeHtml(cat.label)}（${cat.items.length}）</div>`;
      cat.items.forEach(it => {
        // proto.js 修正后：name 在 field 8（真实名称），remark 在 field 2（备注名）。优先显示备注名，无则用真实名。
        const display = it.remark || it.name || '';
        const el = document.createElement('div'); el.className = 'yh-contact-item';
        el.innerHTML = `${avatarHtml(it.avatar_url, display, 42)}<div><div class="yh-contact-name">${window.YHRender.escapeHtml(display)}</div><div class="yh-contact-sub">${typeName(cat.t)}</div></div>`;
        el.onclick = () => { switchView('messages'); openChat({ chatId: it.chat_id, chatType: cat.t, name: display, avatarUrl: it.avatar_url }); };
        g.appendChild(el);
      });
      body.appendChild(g);
    });
    if (!body.children.length) body.innerHTML = '<div class="yh-contact-sub" style="padding:14px">暂无联系人</div>';
  }
  function requestStatus(result) {
    return ({ 0: '待处理', 1: '已通过', 2: '已拒绝', 3: '已过期', 4: '已解散' })[result] || '未知';
  }
  function renderRequests(reqs) {
    const body = $('#contacts-body'); body.innerHTML = '';
    if (!reqs || !reqs.length) { body.innerHTML = '<div class="yh-contact-sub" style="padding:14px">暂无好友请求</div>'; return; }
    reqs.forEach(r => {
      const el = document.createElement('div'); el.className = 'yh-contact-item'; el.style.flexDirection = 'column'; el.style.alignItems = 'stretch';
      const who = r.name || r.botName || r.groupName || '用户';
      const pending = (r.result == null || r.result === 0);
      const statusText = requestStatus(r.result);
      el.innerHTML = `${avatarHtml(r.avatar || r.botAvatar || r.groupAvatar, who, 42)}
        <div style="flex:1"><div class="yh-contact-name">${window.YHRender.escapeHtml(who)}</div>
        <div class="yh-contact-sub">${typeName(r.targetType)} · ${window.YHRender.escapeHtml(r.note || '')} · <span class="yh-req-status${pending ? ' is-pending' : ''}">${statusText}</span></div></div>
        ${pending ? `<div class="yh-request-actions">
          <mdui-button variant="filled" data-act="agree">同意</mdui-button>
          <mdui-button variant="outlined" data-act="ignore">忽略</mdui-button>
        </div>` : ''}`;
      const agree = el.querySelector('[data-act="agree"]');
      if (agree) agree.onclick = async () => {
        try { await window.YHApi.agreeFriend(r.requestId, r.targetId, r.targetType); snack('已同意'); loadContacts(); }
        catch (e) { snack('操作失败：' + e.message); }
      };
      const ignore = el.querySelector('[data-act="ignore"]');
      if (ignore) ignore.onclick = () => el.remove();
      body.appendChild(el);
    });
  }

  // ============ 社区 ============
  function bindCommunity() {
    const tabs = $('#community-tabs');
    if (!tabs) return;
    tabs.addEventListener('change', (e) => {
      const v = e.target.value;
      showCommunityTab(v);
      if (v === 'recommend') loadRecommend();
      else if (v === 'ba') loadCommunityBa();
      else if (v === 'mine') loadMine();
    });
    const compose = $('#btn-compose-post'); if (compose) compose.onclick = openCompose;
    const search = $('#btn-community-search'); if (search) search.onclick = openCommunitySearch;
    // 无限滚动：滚到底部自动加载下一页
    const onListScroll = (box, loader) => {
      if (!box) return;
      box.addEventListener('scroll', () => {
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) loader(true);
      }, { passive: true });
    };
    onListScroll($('#community-recommend'), loadRecommend);
    onListScroll($('#community-mine'), loadMine);
    onListScroll($('#community-posts'), loadMoreBaPosts);
  }

  function showCommunityTab(v) {
    // 'posts' 和 'post-detail' 不是真正的 tab（HTML 中无对应 <mdui-tab>），不能设置 tabs.value，
    // 否则 mdui-tabs 会因找不到匹配项而重置到首个 tab 并触发 change 事件，把目标 div 又隐藏掉。
    const tabs = $('#community-tabs');
    if (tabs && ['recommend', 'ba', 'mine'].includes(v)) tabs.value = v;
    const layout = document.querySelector('.yh-community-layout');
    if (v === 'post-detail') {
      // 显示文章详情（桌面端右侧面板，手机端覆盖列表）
      if (layout) layout.classList.add('detail-open');
    } else {
      // 显示列表，隐藏详情（恢复占位提示）
      if (layout) layout.classList.remove('detail-open');
      const detail = $('#community-post-detail');
      if (detail) detail.innerHTML = '<div class="yh-community-placeholder yh-chat-empty">选择一篇文章查看详情</div>';
      ['recommend', 'ba', 'mine', 'posts'].forEach(id => { const el = $('#community-' + id); if (el) el.hidden = (id !== v); });
    }
  }

  async function loadCommunityBa() {
    showCommunityTab('ba');
    try {
      const data = await window.YHApi.communityBaList(1, 30, 2);
      S.baList = (data && data.ba) || [];
      renderBa();
    } catch (e) { snack('获取社区分区失败：' + e.message); }
  }
  function renderBa() {
    const box = $('#community-ba');
    box.innerHTML = '';
    if (!S.baList.length) { box.innerHTML = '<div class="yh-contact-sub" style="padding:14px">暂无分区</div>'; return; }
    S.baList.forEach(ba => {
      const el = document.createElement('div'); el.className = 'yh-ba-card';
      // 用户要求：每个分区卡片上都显示"分区 ID"，便于发起文章 / 搜索等操作时直接使用。
      const baIdLabel = (ba && (ba.id || ba.baId || ba.board_area_id || ba.boardId)) != null
        ? String(ba.id || ba.baId || ba.board_area_id || ba.boardId)
        : '';
      el.innerHTML = `${avatarHtml(ba.avatar, ba.name, 48)}
        <div class="yh-ba-meta">
          <div class="yh-ba-title">
            ${window.YHRender.escapeHtml(ba.name || '')}
            ${baIdLabel ? `<span class="yh-ba-id" title="分区 ID">#${window.YHRender.escapeHtml(baIdLabel)}</span>` : ''}
          </div>
          <div class="yh-ba-desc">${ba.memberNum || 0} 成员 · ${ba.postNum || 0} 文章
            ${baIdLabel ? ` · ID: <code>${window.YHRender.escapeHtml(baIdLabel)}</code>` : ''}
          </div>
        </div><mdui-icon-button icon="chevron_right"></mdui-icon-button>`;
      el.onclick = () => openBaDetail(ba.id);
      box.appendChild(el);
    });
  }

  async function openBaDetail(baId) {
    S._baDetailId = baId;
    S._commPage.posts = 1;
    S._commHasMore.posts = true;
    try {
      const data = await window.YHApi.baInfo(baId);
      const ba = (data && data.ba) || {};
      const posts = await window.YHApi.communityPosts(baId, 1, 20).catch(() => null);
      S._baPosts = (posts && posts.posts) || [];
      if (S._baPosts.length < 20) S._commHasMore.posts = false;
      showCommunityTab('posts');
      renderPosts(S._baPosts, ba.name || '分区文章', () => loadCommunityBa());
      S._commPage.posts = 2;
    } catch (e) { snack('获取分区详情失败：' + e.message); }
  }

  async function loadMoreBaPosts() {
    if (S._commLoading || !S._commHasMore.posts || !S._baDetailId) return;
    S._commLoading = true;
    const box = $('#community-posts');
    const oldSentinel = box && box.querySelector('.yh-scroll-sentinel'); if (oldSentinel) oldSentinel.remove();
    if (box) {
      const el = document.createElement('div');
      el.className = 'yh-scroll-sentinel';
      el.innerHTML = '<div class="yh-scroll-loading">加载中…</div>';
      box.appendChild(el);
    }
    try {
      const page = S._commPage.posts || 2;
      const data = await window.YHApi.communityPosts(S._baDetailId, page, 20);
      const posts = (data && data.posts) || [];
      if (posts.length < 20) S._commHasMore.posts = false;
      // 追加到已有列表
      const newPosts = (S._baPosts || []).concat(posts);
      S._baPosts = newPosts;
      renderPostsAppend(posts);
      S._commPage.posts = page + 1;
    } catch (e) { /* silent */ }
    finally { S._commLoading = false; }
  }

  // 追加 ba 文章到列表（不清空已有内容）
  function renderPostsAppend(posts) {
    const box = $('#community-posts');
    if (!box) return;
    const oldSentinel = box.querySelector('.yh-scroll-sentinel'); if (oldSentinel) oldSentinel.remove();
    const backBtn = box.querySelector('mdui-button'); // 保留返回按钮
    if (!posts.length) return;
    posts.forEach(p => {
      const el = document.createElement('div'); el.className = 'yh-post-card';
      const author = p.senderNickname || '匿名';
      const stats = `${p.likeNum || 0} 赞 · ${p.commentNum || 0} 评 · ${p.collectNum || 0} 藏`;
      let text = p.content || '';
      if (p.contentType === 2) { try { text = window.marked ? window.marked.parse(text) : text; } catch (e) {} text = window.YHRender.sanitizeHtml(text); }
      else text = window.YHRender.escapeHtml(text);
      el.innerHTML = `<div class="yh-post-head">${avatarHtml(p.senderAvatar, author, 32)}<div><div class="yh-post-card-title">${window.YHRender.escapeHtml(p.title || '无标题')}</div><div class="yh-contact-sub">${window.YHRender.escapeHtml(author)} · ${window.YHRender.formatTime(p.createTime)}</div></div></div>
        <div class="yh-post-card-text">${text}</div><div class="yh-post-card-stats">${stats}${renderSendToSelect('inline', p, { placeholder: '发送到…' })}</div>`;
      el.onclick = (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest('.yh-send-to-wrap')) return;
        openPost(p.id);
      };
      bindSendToSelect(el, { postId: p.id, postTitle: p.title, postContent: p.content, postType: p.contentType });
      box.appendChild(el);
    });
  }

  async function loadRecommend(append) {
    if (!append) { S._commPage.recommend = 1; S._commHasMore.recommend = true; showCommunityTab('recommend'); }
    if (S._commLoading || !S._commHasMore.recommend) return;
    S._commLoading = true;
    _showCommLoading('#community-recommend', append);
    try {
      const page = S._commPage.recommend || 1;
      const data = await window.YHApi.postListRecommend(page, 20);
      const posts = (data && data.posts) || [];
      if (posts.length < 20) S._commHasMore.recommend = false;
      renderPostList('#community-recommend', posts, false, append);
      S._commPage.recommend = page + 1;
    } catch (e) { snack('获取推荐文章失败：' + e.message); }
    finally { S._commLoading = false; }
  }

  async function loadMine(append) {
    if (!append) { S._commPage.mine = 1; S._commHasMore.mine = true; showCommunityTab('mine'); }
    if (S._commLoading || !S._commHasMore.mine) return;
    S._commLoading = true;
    _showCommLoading('#community-mine', append);
    try {
      const page = S._commPage.mine || 1;
      const data = await window.YHApi.myPostList(page, 20);
      const posts = (data && data.posts) || [];
      if (posts.length < 20) S._commHasMore.mine = false;
      renderPostList('#community-mine', posts, true, append);
      S._commPage.mine = page + 1;
    } catch (e) { snack('获取我的文章失败：' + e.message); }
    finally { S._commLoading = false; }
  }

  // 显示/移除社区列表加载状态
  function _showCommLoading(sel, append) {
    const box = $(sel); if (!box) return;
    const old = box.querySelector('.yh-scroll-sentinel'); if (old) old.remove();
    if (append) {
      const el = document.createElement('div');
      el.className = 'yh-scroll-sentinel';
      el.innerHTML = '<div class="yh-scroll-loading">加载中…</div>';
      box.appendChild(el);
    }
  }

  function renderPostList(selector, posts, isMine, append) {
    const box = $(selector);
    // 追加模式：移除旧 sentinel，保留已有内容；非追加：清空
    const oldSentinel = box.querySelector('.yh-scroll-sentinel'); if (oldSentinel) oldSentinel.remove();
    if (!append) box.innerHTML = '';
    if (!posts.length && !append) { box.innerHTML = '<div class="yh-contact-sub" style="padding:14px">暂无文章</div>'; return; }
    posts.forEach(p => {
      const el = document.createElement('div'); el.className = 'yh-post-card';
      const author = p.senderNickname || '匿名';
      const stats = `${p.likeNum || 0} 赞 · ${p.commentNum || 0} 评 · ${p.collectNum || 0} 藏`;
      let text = p.content || '';
      if (p.contentType === 2) { try { text = window.marked ? window.marked.parse(text) : text; } catch (e) {} text = window.YHRender.sanitizeHtml(text); }
      else text = window.YHRender.escapeHtml(text);
      const delBtn = isMine ? `<mdui-button-icon icon="delete" data-del="${p.id}" class="yh-post-del"></mdui-button-icon>` : '';
      el.innerHTML = `<div class="yh-post-head">${avatarHtml(p.senderAvatar, author, 32)}<div style="flex:1"><div class="yh-post-card-title">${window.YHRender.escapeHtml(p.title || '无标题')}</div><div class="yh-contact-sub">${window.YHRender.escapeHtml(author)} · ${window.YHRender.formatTime(p.createTime)}</div></div>${delBtn}</div>
        <div class="yh-post-card-text">${text}</div><div class="yh-post-card-stats">${stats}</div>`;
      el.onclick = (e) => { if (e.target.closest('[data-del]')) return; openPost(p.id); };
      const del = el.querySelector('[data-del]');
      if (del) del.onclick = async (e) => {
        e.stopPropagation();
        confirmDialog('删除文章', '确定删除这篇文章吗？', async () => {
          try { await window.YHApi.deletePost(p.id); snack('已删除'); loadMine(); }
          catch (err) { snack(err.message); }
        });
      };
      box.appendChild(el);
    });
  }

  function renderPosts(posts, title, onBack) {
    const box = $('#community-posts');
    box.innerHTML = '';
    const back = document.createElement('mdui-button'); back.icon = 'arrow_back'; back.textContent = title || '返回'; back.onclick = onBack || loadCommunityBa; box.appendChild(back);
    if (!posts || !posts.length) { box.innerHTML += '<div class="yh-contact-sub" style="padding:14px">暂无文章</div>'; return; }
    posts.forEach(p => {
      const el = document.createElement('div'); el.className = 'yh-post-card';
      const author = p.senderNickname || '匿名';
      const stats = `${p.likeNum || 0} 赞 · ${p.commentNum || 0} 评 · ${p.collectNum || 0} 藏`;
      let text = p.content || '';
      if (p.contentType === 2) { try { text = window.marked ? window.marked.parse(text) : text; } catch (e) {} text = window.YHRender.sanitizeHtml(text); }
      else text = window.YHRender.escapeHtml(text);
      el.innerHTML = `<div class="yh-post-head">${avatarHtml(p.senderAvatar, author, 32)}<div><div class="yh-post-card-title">${window.YHRender.escapeHtml(p.title || '无标题')}</div><div class="yh-contact-sub">${window.YHRender.escapeHtml(author)} · ${window.YHRender.formatTime(p.createTime)}</div></div></div>
        <div class="yh-post-card-text">${text}</div><div class="yh-post-card-stats">${stats}${renderSendToSelect('inline', p, { placeholder: '发送到…' })}</div>`;
      el.onclick = (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest('.yh-send-to-wrap')) return; // 点到下拉选择框不要跳详情
        openPost(p.id);
      };
      // 绑定"发送到…"下拉
      bindSendToSelect(el, {
        postId: p.id, postTitle: p.title, postContent: p.content, postType: p.contentType,
      });
      box.appendChild(el);
    });
  }

  function postBodyHtml(post) {
    let text = post.content || '';
    if (post.contentType === 2) { try { text = window.marked ? window.marked.parse(text) : text; } catch (e) {} text = window.YHRender.sanitizeHtml(text); }
    else text = window.YHRender.escapeHtml(text).replace(/\n/g, '<br/>');
    return text;
  }

  async function openPost(postId) {
    // 帖子详情以页面展示（非 dialog），填充 #community-post-detail 并切换显示
    const box = $('#community-post-detail');
    box.innerHTML = '<div style="padding:18px;text-align:center">加载中…</div>';
    showCommunityTab('post-detail');
    box.scrollTop = 0;
    // 记录当前 postId，评论长按菜单里的回复/删除 需要知道是在哪个 post 上下文
    S._lastPostId = postId;
    try {
      const data = await window.YHApi.postDetail(postId);
      const post = (data && data.post) || {};
      const ba = (data && data.ba) || {};
      const author = post.senderNickname || '匿名';
      const text = postBodyHtml(post);
      const myId = window.YHApi.userId;
      const isMine = post.senderId && String(post.senderId) === String(myId);
      box.innerHTML = `<div class="yh-post-detail">
        <div class="yh-post-detail-back">
          <mdui-button-icon icon="arrow_back" id="pd-back"></mdui-button-icon>
          <span class="yh-post-detail-back-title">文章详情</span>
          ${renderSendToSelect('detail', post, { placeholder: '发送到会话…' })}
        </div>
        ${avatarHtml(post.senderAvatar, author, 40)}
        <div class="yh-post-detail-meta"><span class="yh-contact-sub">${window.YHRender.escapeHtml(author)}</span></div>
        <div class="yh-post-detail-title">${window.YHRender.escapeHtml(post.title || '')}</div>
        <div class="yh-post-detail-body">${text}</div>
        <div class="yh-post-actions">
          <button class="yh-post-act" data-act="like" data-id="${post.id}">👍 ${post.likeNum || 0}</button>
          <button class="yh-post-act" data-act="collect" data-id="${post.id}">⭐ ${post.collectNum || 0}</button>
          <button class="yh-post-act" data-act="comment">💬 ${post.commentNum || 0}</button>
          ${ba.name ? `<button class="yh-post-act" data-act="ba" data-ba="${ba.id}">${window.YHRender.escapeHtml(ba.name)}</button>` : ''}
          ${isMine ? `<button class="yh-post-act is-danger" data-act="delete" data-id="${post.id}">删除</button>` : ''}
        </div>
        <div class="yh-comments" id="post-comments">
          <div class="yh-comments-title">评论</div>
          <!-- 评论回复引用条：和聊天界面的引用提示条同款视觉 -->
          <div id="comment-action-bar" class="yh-comment-action-bar" hidden>
            <div id="comment-action-preview" class="yh-action-preview"></div>
            <mdui-button-icon id="comment-action-cancel" icon="close" tooltip="取消回复" size="small"></mdui-button-icon>
          </div>
          <div id="comment-list">加载中…</div>
          <div class="yh-comment-input">
            <mdui-text-field id="comment-input" class="yh-grow" placeholder="写评论…" rows="1"></mdui-text-field>
            <mdui-button id="btn-comment" icon="send">发送</mdui-button>
          </div>
        </div>
      </div>`;
      box.querySelector('#pd-back').onclick = () => {
        S._replyingComment = null; renderCommentActionBar();
        if (S._baPosts && S._baPosts.length) showCommunityTab('posts'); else loadRecommend();
      };
      // 顶部"发送到会话…"下拉选择框
      bindSendToSelect(box, {
        postId: post.id, postTitle: post.title, postContent: post.content, postType: post.contentType,
      });
      // 评论：初始化引用态
      S._replyingComment = null;
      renderCommentActionBar();
      loadComments(postId);

      const doSendComment = async () => {
        const inp = box.querySelector('#comment-input');
        const raw = inp.value;
        const replyTo = S._replyingComment || null;
        const replyCommentId = replyTo ? Number(replyTo.commentId) || 0 : 0;
        let finalText = raw;
        // 贴 @对方 前缀（常见论坛风格），如果用户已经手写了就不重复
        if (replyTo && replyTo.senderName) {
          const at = '@' + replyTo.senderName;
          if (finalText.trim() && !finalText.trim().startsWith(at + ' ') && !finalText.trim().startsWith(at + '\n')) {
            finalText = at + ' ' + finalText;
          } else if (!finalText.trim()) {
            finalText = at;
          }
        }
        // 纯空内容（既没写也没选回复目标）就不发
        if (!finalText.trim() && !replyCommentId) return;
        try {
          await window.YHApi.createComment(postId, finalText, replyCommentId);
          inp.value = ''; S._replyingComment = null; renderCommentActionBar();
          snack('评论成功'); loadComments(postId);
        } catch (e) { snack(e.message); }
      };
      box.querySelector('#btn-comment').onclick = doSendComment;
      const commentInp = box.querySelector('#comment-input');
      commentInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault(); doSendComment();
        }
      });
      box.querySelector('#comment-action-cancel').onclick = () => {
        S._replyingComment = null; renderCommentActionBar();
      };
      // 点赞/收藏
      box.querySelector('[data-act="like"]').onclick = async (e) => {
        try { await window.YHApi.postLike(postId); e.target.classList.toggle('active'); snack('已操作'); }
        catch (err) { snack(err.message); }
      };
      box.querySelector('[data-act="collect"]').onclick = async (e) => {
        try { await window.YHApi.postCollect(postId); e.target.classList.toggle('active'); snack('已操作'); }
        catch (err) { snack(err.message); }
      };
      box.querySelector('[data-act="comment"]').onclick = () => { box.querySelector('#comment-input').focus(); };
      const baBtn = box.querySelector('[data-act="ba"]');
      if (baBtn) baBtn.onclick = () => { openBaDetail(parseInt(baBtn.dataset.ba)); };
      const delBtn = box.querySelector('[data-act="delete"]');
      if (delBtn) delBtn.onclick = () => {
        confirmDialog('删除文章', '确定删除这篇文章吗？', async () => {
          try { await window.YHApi.deletePost(postId); snack('已删除'); loadMine(); }
          catch (e) { snack(e.message); }
        });
      };
    } catch (e) { box.innerHTML = `<div style="padding:18px" class="yh-error">${window.YHRender.escapeHtml(e.message)}</div>`; }
  }

  async function loadComments(postId) {
    const box = document.querySelector('#comment-list');
    if (!box) return;
    // 重置分页状态
    S._commentPage = 1;
    S._commentLoading = false;
    S._commentHasMore = true;
    box.innerHTML = '';
    await loadCommentsPage(postId, 1);
    // 绑定滚动加载
    const scrollContainer = box.closest('.yh-scroll') || box.parentElement;
    if (scrollContainer && !scrollContainer._commentScrollBound) {
      scrollContainer._commentScrollBound = true;
      scrollContainer.addEventListener('scroll', () => {
        if (scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 80) {
          if (S._lastPostId && S._commentHasMore && !S._commentLoading) {
            loadCommentsPage(S._lastPostId, (S._commentPage || 1) + 1);
          }
        }
      }, { passive: true });
    }
  }

  async function loadCommentsPage(postId, page) {
    const box = document.querySelector('#comment-list');
    if (!box || S._commentLoading) return;
    S._commentLoading = true;
    S._commentPage = page;
    // 底部加载指示器
    let indicator = null;
    if (page > 1) {
      indicator = document.createElement('div');
      indicator.className = 'yh-hist-loading';
      indicator.innerHTML = '<span class="material-icons yh-hist-spin">refresh</span> 加载中…';
      box.appendChild(indicator);
    }
    try {
      const data = await window.YHApi.commentList(postId, page, 20);
      const comments = (data && data.comments) || [];
      if (indicator) indicator.remove();
      if (!comments.length) {
        S._commentHasMore = false;
        if (page === 1) box.innerHTML = '<div class="yh-contact-sub">暂无评论</div>';
        else {
          const end = document.createElement('div');
          end.className = 'yh-contact-sub'; end.style.textAlign = 'center'; end.style.padding = '12px';
          end.textContent = '没有更多评论了';
          box.appendChild(end);
        }
        return;
      }
      const myId = String(window.YHApi.userId || '');
      const html = comments.map(c => {
        const senderId = String(c.senderId || c.sender_userid || c.senderUserId || '');
        const isSelf = senderId === myId;
        return `<div class="yh-comment" data-kind="comment"
             data-post-id="${window.YHRender.escapeHtml(String(postId))}"
             data-comment-id="${window.YHRender.escapeHtml(String(c.id))}"
             data-sender-name="${window.YHRender.escapeHtml(c.senderNickname || '匿名')}"
             data-sender-id="${window.YHRender.escapeHtml(senderId)}"
             data-is-self="${isSelf ? '1' : '0'}"
             data-text="${window.YHRender.escapeHtml(c.content || '')}">
        ${avatarHtml(c.senderAvatar, c.senderNickname, 28)}
        <div class="yh-comment-main">
          <div class="yh-comment-author">${window.YHRender.escapeHtml(c.senderNickname || '匿名')}</div>
          <div class="yh-comment-text">${window.YHRender.escapeHtml(c.content || '')}</div>
          <div class="yh-comment-meta">${window.YHRender.formatTime(c.createTime)} · ${c.likeNum || 0} 赞</div>
        </div></div>`;
      }).join('');
      if (page === 1) box.innerHTML = html;
      else box.insertAdjacentHTML('beforeend', html);
      $$('#comment-list .yh-comment', box).forEach(el => bindMsgPress(el));
      S._commentHasMore = comments.length >= 20;
    } catch (e) {
      if (indicator) indicator.remove();
      if (page === 1) box.innerHTML = '<div class="yh-contact-sub">评论加载失败</div>';
    } finally {
      S._commentLoading = false;
    }
  }

  function openCompose() {
    const d = openDialog(`<div style="padding:18px">
      <div style="font-weight:800;margin-bottom:12px">发布文章</div>
      <mdui-text-field id="compose-baid" label="分区 ID" class="yh-compose-field"></mdui-text-field>
      <mdui-text-field id="compose-title" label="标题" class="yh-compose-field"></mdui-text-field>
      <mdui-text-field id="compose-content" label="内容" rows="6" class="yh-compose-field"></mdui-text-field>
      <mdui-segmented-button-group selects="single" value="text">
        <mdui-segmented-button value="text">文本</mdui-segmented-button>
        <mdui-segmented-button value="md">Markdown</mdui-segmented-button>
      </mdui-segmented-button-group>
      <div class="yh-compose-actions">
        <mdui-button variant="outlined" id="compose-cancel">取消</mdui-button>
        <mdui-button variant="filled" id="compose-submit">发布</mdui-button>
      </div>
    </div>`, { width: 560 });
    d.querySelector('#compose-cancel').onclick = () => { d.open = false; };
    const seg = d.querySelector('mdui-segmented-button-group');
    d.querySelector('#compose-submit').onclick = async () => {
      const baId = parseInt(d.querySelector('#compose-baid').value) || 0;
      const title = d.querySelector('#compose-title').value.trim();
      const content = d.querySelector('#compose-content').value.trim();
      if (!baId || !title || !content) { snack('请填写分区ID、标题和内容'); return; }
      const ct = (seg && seg.value === 'md') ? 2 : 1;
      try { await window.YHApi.createPost(baId, title, content, ct); snack('发布成功'); d.open = false; loadRecommend(); }
      catch (e) { snack(e.message); }
    };
  }

  function openCommunitySearch() {
    const d = openDialog(`<div style="padding:16px">
      <mdui-text-field id="cs-input" label="搜索文章 / 分区" class="yh-full"></mdui-text-field>
      <div id="cs-results" style="margin-top:12px"></div></div>`, { width: 560 });
    const inp = d.querySelector('#cs-input'); const res = d.querySelector('#cs-results');
    const run = async () => {
      const w = inp.value.trim(); if (!w) return;
      try {
        const data = await window.YHApi.searchCommunity(w, 1, 20);
        res.innerHTML = '';
        const posts = (data && data.posts) || [];
        const ba = (data && data.ba) || [];
        if (ba.length) {
          res.innerHTML += '<div class="yh-cat-head">分区</div>';
          ba.forEach(b => {
            const el = document.createElement('div'); el.className = 'yh-ba-card';
            const baId = b.id != null ? String(b.id) : '';
            // 用户要求：社区搜索的分区也要显示"分区 ID"，并可以点卡片进去
            el.innerHTML = `${avatarHtml(b.avatar, b.name, 40)}
              <div class="yh-ba-meta">
                <div class="yh-ba-title">
                  ${window.YHRender.escapeHtml(b.name || '')}
                  ${baId ? `<span class="yh-ba-id" title="分区 ID">#${window.YHRender.escapeHtml(baId)}</span>` : ''}
                </div>
                <div class="yh-ba-desc">
                  ${b.memberNum || 0} 成员 · ${b.postNum || 0} 文章
                  ${baId ? ` · ID: <code>${window.YHRender.escapeHtml(baId)}</code>` : ''}
                </div>
              </div>
              <mdui-icon-button icon="chevron_right"></mdui-icon-button>`;
            el.onclick = () => { d.open = false; openBaDetail(b.id); };
            res.appendChild(el);
          });
        }
        if (posts.length) {
          res.innerHTML += '<div class="yh-cat-head">文章</div>';
          posts.forEach(p => {
            const el = document.createElement('div'); el.className = 'yh-post-card';
            // 文章也顺手显示一下所属分区 ID（board_area_id / baId / boardId），
            // 免得用户要翻帖子所属分区时还得切界面。
            const belongId = String(p.board_area_id || p.baId || p.boardId || '');
            el.innerHTML =
              `<div class="yh-post-card-title">${window.YHRender.escapeHtml(p.title || '无标题')}</div>
               <div class="yh-contact-sub">
                 ${window.YHRender.escapeHtml(p.senderNickname || '')}
                 ${belongId ? ` · 分区 ID: <code>${window.YHRender.escapeHtml(belongId)}</code>` : ''}
               </div>`;
            el.onclick = () => { d.open = false; openPost(p.id); };
            res.appendChild(el);
          });
        }
        if (!res.children.length) res.innerHTML = '<div class="yh-contact-sub">无结果</div>';
      } catch (e) { res.innerHTML = '<div class="yh-error">' + window.YHRender.escapeHtml(e.message) + '</div>'; }
    };
    inp.addEventListener('input', debounce(run, 400));
    setTimeout(() => inp.focus(), 100);
  }

  // ============ 详情（用户/群/机器人） ============
  // 先拉取数据再 openDialog，避免「先开空弹窗再异步替换 innerHTML」导致 mdui-dialog slot 内容不刷新
  async function showDetail(type, id, fallbackName) {
    const d = openDialog('<div style="padding:18px;text-align:center">加载中…</div>', { width: 480 });
    try {
      let name, avatar, sub = '', extra = '';
      if (type === 1) {
        const u = await window.YHApi.getUser(id);
        name = u.name; avatar = u.avatar_url;
        sub = (u.profile_info && u.profile_info.introduction) || '';
        const days = u.online_day ? `连续在线 ${u.continuous_online_day || 0} 天 · ` : '';
        extra = `${days}注册：${u.register_time || '—'}${u.ipGeo ? '<br/>IP 归属：' + window.YHRender.escapeHtml(u.ipGeo) : ''}`;
      } else if (type === 2) {
        const g = await window.YHApi.getGroupInfo(id);
        name = g.name; avatar = g.avatar_url; sub = g.introduction || '';
        extra = `成员：${g.member || 0}<br/>群口令：${g.group_code || '—'}${g.category_name ? '<br/>分类：' + window.YHRender.escapeHtml(g.category_name) : ''}<br/>群 ID：<code>${window.YHRender.escapeHtml(String(id))}</code>`;
      } else if (type === 3) {
        const b = await window.YHApi.getBotInfo(id);
        name = b.name; avatar = b.avatar_url; sub = b.introduction || '';
        extra = `创建者：${b.create_by || '—'}<br/>使用人数：${b.headcount || 0}`;
      } else {
        throw new Error('未知的会话类型');
      }
      // 重新构建完整内容后一次性替换
      // 判断是否已加入群聊：会话列表中存在该群 → 已是成员
      const isJoined = type === 2 && S.conversations.some(c => String(c.chatId) === String(id));
      const inviteBtn = type === 2 ? '<mdui-button variant="tonal" id="d-invite" icon="person_add">邀请成员</mdui-button>' : '';
      const filesBtn = type === 2 ? '<mdui-button variant="tonal" id="d-files" icon="folder">群文件</mdui-button>' : '';
      d.innerHTML = `<div style="padding:18px">
        <div style="text-align:center">${avatarHtml(avatar, name, 72)}<div style="font-size:20px;font-weight:800;margin-top:8px">${window.YHRender.escapeHtml(name || fallbackName || '')}</div>
        <div class="yh-contact-sub">${window.YHRender.escapeHtml(sub || '')}</div></div>
        <div style="margin:12px 0;font-size:14px">${extra}</div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <mdui-button variant="filled" id="d-msg">发消息</mdui-button>
          ${type === 1 ? '<mdui-button variant="outlined" id="d-add">加好友</mdui-button>' : ''}
          ${type === 2 && !isJoined ? '<mdui-button variant="outlined" id="d-join">加入群聊</mdui-button>' : ''}
          ${inviteBtn}
          ${filesBtn}
          <mdui-button variant="text" id="d-share" icon="share">分享链接</mdui-button>
        </div></div>`;
      const close = document.createElement('mdui-button-icon');
      close.icon = 'close'; close.className = 'yh-dialog-close'; close.setAttribute('aria-label', '关闭');
      close.onclick = () => { d.open = false; }; d.appendChild(close);
      d.querySelector('#d-msg').onclick = () => { d.open = false; openChat({ chatId: id, chatType: type, name: name || fallbackName, avatarUrl: avatar }); };
      const add = d.querySelector('#d-add'); if (add) add.onclick = async () => { try { await window.YHApi.addFriend(id); snack('已发送好友申请'); } catch (e) { snack(e.message); } };
      const join = d.querySelector('#d-join'); if (join) join.onclick = async () => { try { await window.YHApi.joinGroup(id); snack('已申请加入'); } catch (e) { snack(e.message); } };
      const invite = d.querySelector('#d-invite');
      if (invite) invite.onclick = () => openInviteToGroupDialog({ groupId: id, groupName: name || fallbackName || '' });
      // 群文件
      const filesBtnEl = d.querySelector('#d-files');
      if (filesBtnEl) filesBtnEl.onclick = () => { d.open = false; openGroupFilesDialog({ chatId: id, chatName: name || fallbackName || '' }); };
      // 分享链接
      const share = d.querySelector('#d-share');
      if (share) share.onclick = async () => {
        try {
          share.loading = true;
          const data = await window.YHApi.createShare({ chatId: id, chatType: type, chatName: name || fallbackName || '' });
          // 分享链接格式: https://yhfx.jwznb.com/share?key={key}&ts={ts}
          const url = data && data.key ? `https://yhfx.jwznb.com/share?key=${data.key}&ts=${data.ts || ''}` : (data && data.shareUrl ? data.shareUrl : '');
          if (url) {
            try { await navigator.clipboard.writeText(url); snack('分享链接已复制：' + url); }
            catch (_) { snack('分享链接：' + url); }
          } else { snack('分享链接创建失败'); }
        } catch (e) { snack('分享失败：' + e.message); }
        finally { share.loading = false; }
      };
    } catch (e) {
      d.innerHTML = `<div style="padding:18px" class="yh-error">${window.YHRender.escapeHtml(e.message)}</div>`;
      const close = document.createElement('mdui-button-icon');
      close.icon = 'close'; close.className = 'yh-dialog-close'; close.setAttribute('aria-label', '关闭');
      close.onclick = () => { d.open = false; }; d.appendChild(close);
    }
  }

  // ============ 群文件查看 ============
  async function openGroupFilesDialog({ chatId, chatName }) {
    const dlg = openDialog(`<div style="padding:18px;width:560px;max-width:92vw">
      <div style="font-size:18px;font-weight:800;margin-bottom:4px">群文件</div>
      <div class="yh-contact-sub" style="margin-bottom:12px">${window.YHRender.escapeHtml(chatName || chatId)}</div>
      <div id="disk-breadcrumb" style="margin-bottom:8px;font-size:13px"></div>
      <div id="disk-file-list" style="min-height:200px"><div class="yh-contact-sub" style="text-align:center;padding:20px">加载中…</div></div>
      <div id="disk-file-size" style="margin-top:12px;font-size:13px;color:rgb(var(--mdui-color-on-surface-variant))"></div>
    </div>`);
    let currentFolderId = 0;
    const folderStack = [{ id: 0, name: '根目录' }];

    function renderBreadcrumb() {
      const bc = dlg.querySelector('#disk-breadcrumb');
      bc.innerHTML = folderStack.map((f, i) =>
        `<span style="cursor:pointer;color:rgb(var(--mdui-color-primary))" data-folder-idx="${i}">${window.YHRender.escapeHtml(f.name)}</span>`
      ).join(' <span style="opacity:.5">/</span> ');
      bc.querySelectorAll('[data-folder-idx]').forEach(el => {
        el.onclick = () => {
          const idx = parseInt(el.dataset.folderIdx);
          folderStack.splice(idx + 1);
          currentFolderId = folderStack[folderStack.length - 1].id;
          loadFileList();
        };
      });
    }

    async function loadFileList() {
      const listEl = dlg.querySelector('#disk-file-list');
      listEl.innerHTML = '<div class="yh-contact-sub" style="text-align:center;padding:20px">加载中…</div>';
      renderBreadcrumb();
      try {
        const data = await window.YHApi.diskFileList(chatId, 2, currentFolderId);
        const files = (data && data.list) || [];
        if (!files.length) {
          listEl.innerHTML = '<div class="yh-contact-sub" style="text-align:center;padding:20px">暂无文件</div>';
        } else {
          listEl.innerHTML = files.map(f => {
            const isFolder = f.objectType === 1;
            const icon = isFolder ? '📁' : '📄';
            const sizeStr = isFolder ? '' : window.YHRender.fileSize(f.fileSize);
            const time = f.uploadTime ? window.YHRender.formatTime(f.uploadTime * 1000) : '';
            // 文件下载 URL：七牛云 key → CDN 地址（经媒体代理）
            const fileUrl = f.qiniuKey ? window.YHApi.mediaUrl('https://chat-img.jwznb.com/' + f.qiniuKey) : '';
            return `<div class="yh-disk-item" data-id="${f.id}" data-type="${f.objectType}" data-name="${window.YHRender.escapeHtml(f.name)}" data-url="${window.YHRender.escapeHtml(fileUrl)}">
              <span class="yh-disk-icon">${icon}</span>
              <div class="yh-disk-info">
                <div class="yh-disk-name">${window.YHRender.escapeHtml(f.name || '')}</div>
                <div class="yh-disk-meta">${sizeStr ? sizeStr + ' · ' : ''}${window.YHRender.escapeHtml(f.uploadByName || '')}${time ? ' · ' + time : ''}</div>
              </div>
              ${!isFolder && fileUrl ? '<span class="yh-disk-dl">下载</span>' : ''}
            </div>`;
          }).join('');
          listEl.querySelectorAll('.yh-disk-item').forEach(el => {
            el.onclick = () => {
              if (el.dataset.type === '1') {
                // 文件夹：进入子目录
                currentFolderId = parseInt(el.dataset.id);
                folderStack.push({ id: currentFolderId, name: el.dataset.name });
                loadFileList();
              } else if (el.dataset.url) {
                // 文件：打开下载链接
                window.open(el.dataset.url, '_blank', 'noopener');
              }
            };
          });
        }
      } catch (e) {
        listEl.innerHTML = '<div class="yh-contact-sub" style="text-align:center;padding:20px">加载失败：' + window.YHRender.escapeHtml(e.message) + '</div>';
      }
    }
    try {
      const sz = await window.YHApi.diskFileSize(chatId, 2);
      const sizeEl = dlg.querySelector('#disk-file-size');
      if (sz && sz.totalSize != null) sizeEl.textContent = '总占用：' + window.YHRender.fileSize(sz.totalSize);
    } catch (e) {}
    loadFileList();
  }

  // 邀请好友 / 机器人 进群的对话框
  // 入口：群聊详情里的"邀请成员"按钮。
  // 提供两种方式：
  //   1) 下拉：从当前已加载的通讯录（S._book）里选一个好友（chatType=1）或机器人（chatType=3）
  //   2) 手动：输入 chatId 并选择 chatType
  async function openInviteToGroupDialog({ groupId, groupName }) {
    // 通讯录未加载时自动拉取，避免用户需要先去联系人页刷新
    if (!S._book || !S._book.length) {
      try { S._book = await window.YHApi.addressBook(); } catch (e) { snack('获取通讯录失败：' + e.message); }
    }
    // 把通讯录展平成一个 [{id,name,chatType}] 的列表，只包含用户(1)和机器人(3)，排除群聊(2)。
    const friends = [];
    (S._book || []).forEach(group => {
      const typeCode = (group.chat_type != null) ? Number(group.chat_type)
        : ((group.list_name || '').toString().includes('机器人') ? 3 : 1);
      // 群聊分组直接跳过，邀请成员不允许邀请群聊
      if (typeCode === 2) return;
      // addressBook 返回的结构：group.data 或 group.DataList 是联系人列表
      ((group.data || group.DataList || group.list || [])).forEach(it => {
        const id = it.chat_id || it.friendId || it.friend_id || it.id;
        if (!id) return;
        const ct = Number(it.chat_type != null ? it.chat_type : typeCode) || 1;
        // 跳过群聊 chatType=2
        if (ct === 2) return;
        friends.push({
          id: String(id),
          name: it.remark || it.nickname || it.name || `#${id}`,
          chatType: ct,
        });
      });
    });
    const groupOptions = friends.slice(0, 200).map(f => {
      const label = (f.chatType === 3 ? '🤖 ' : '👤 ') + f.name + '  #' + f.id;
      return `<mdui-menu-item value="${window.YHRender.escapeHtml(f.id)}|${f.chatType}">${window.YHRender.escapeHtml(label)}</mdui-menu-item>`;
    }).join('');

    const dlg = openDialog(`<div style="padding:18px;width:440px;max-width:92vw">
      <div style="font-size:18px;font-weight:800;margin-bottom:4px">邀请成员进群</div>
      <div class="yh-contact-sub" style="margin-bottom:14px">目标群：${window.YHRender.escapeHtml(groupName || groupId)}（${window.YHRender.escapeHtml(groupId)}）<br/>按接口要求，chatType 只能是 1（用户）或 3（机器人），邀请前必须已是好友。</div>
      <mdui-select id="inv-pick" label="从通讯录选择" class="yh-full" style="margin-bottom:10px">
        <mdui-menu-item value="" disabled${friends.length ? ' selected' : ''}>—— 选择一位好友/机器人 ——</mdui-menu-item>
        ${groupOptions || '<mdui-menu-item value="">（通讯录为空，可手动输入下方 chatId）</mdui-menu-item>'}
      </mdui-select>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <mdui-text-field id="inv-chat-id" label="或手动输入 chatId" class="yh-grow"></mdui-text-field>
        <mdui-select id="inv-chat-type" label="chatType" value="1" style="width:160px;flex-shrink:0">
          <mdui-menu-item value="1">1 - 用户</mdui-menu-item>
          <mdui-menu-item value="3">3 - 机器人</mdui-menu-item>
        </mdui-select>
      </div>
      <div class="yh-compose-actions" style="margin-top:16px;justify-content:flex-end">
        <mdui-button variant="text" id="inv-cancel">取消</mdui-button>
        <mdui-button variant="filled" id="inv-ok">邀请</mdui-button>
      </div>
    </div>`);

    // 如果用户从"通讯录选择"选了，自动填充下面的 chatId / chatType，避免手敲。
    const pickEl = dlg.querySelector('#inv-pick');
    const chatIdEl = dlg.querySelector('#inv-chat-id');
    const chatTypeEl = dlg.querySelector('#inv-chat-type');
    if (pickEl) {
      pickEl.addEventListener('change', (e) => {
        const v = e.target.value; if (!v) return;
        const [fid, ftype] = v.split('|');
        if (fid) chatIdEl.value = fid;
        if (ftype) chatTypeEl.value = ftype;
      });
    }
    dlg.querySelector('#inv-cancel').onclick = () => { dlg.open = false; };
    dlg.querySelector('#inv-ok').onclick = async () => {
      const chatId = (chatIdEl.value || '').trim();
      const chatType = Number(chatTypeEl.value || 1);
      if (!chatId) { snack('请先选择或输入 chatId'); return; }
      try {
        await window.YHApi.inviteToGroup({ chatId, chatType, groupId });
        snack('已发送邀请');
        dlg.open = false;
      } catch (e) { snack('邀请失败：' + e.message); }
    };
  }

  // ============ 我的 ============
  function renderProfile() {
    const p = S.profile; if (!p || !p.data) { $('#profile-body').innerHTML = '<div class="yh-contact-sub">未登录</div>'; return; }
    renderSidebarFooter();
    const d = p.data;
    const body = $('#profile-body');
    body.innerHTML = `<div class="yh-profile">
      ${avatarHtml(d.avatar_url, d.name, 80)}
      <div class="yh-profile-name">${window.YHRender.escapeHtml(d.name || '')}</div>
      <div class="yh-profile-sub">ID: ${window.YHRender.escapeHtml(d.id || '')} · 金币: ${d.coin || 0} · ${d.is_vip ? 'VIP' : '普通用户'}</div>
      <div class="yh-profile-sub">邀请码: ${window.YHRender.escapeHtml(d.invitation_code || '—')}</div>
    </div>
    <div class="yh-settings">
      <mdui-list>
        <mdui-list-item id="pf-edit-name" icon="edit">修改昵称</mdui-list-item>
        <mdui-list-item id="pf-edit-avatar" icon="account_box">修改头像</mdui-list-item>
        <mdui-list-item id="pf-edit-intro" icon="badge">修改个人简介</mdui-list-item>
        <mdui-list-item id="pf-refresh" icon="refresh">刷新会话</mdui-list-item>
        <mdui-list-item id="pf-theme" icon="dark_mode">切换深色模式</mdui-list-item>
        <mdui-list-item id="pf-password" icon="lock">修改密码</mdui-list-item>
        <mdui-list-item id="pf-bind-email" icon="email">绑定邮箱</mdui-list-item>
        <mdui-list-item id="pf-settings" icon="settings">设置</mdui-list-item>
        <mdui-list-item id="pf-logout" icon="logout">退出登录</mdui-list-item>
      </mdui-list>
    </div>`;
    body.querySelector('#pf-edit-name').onclick = async () => {
      const name = prompt('新昵称：', d.name || '');
      if (name && name !== d.name) { try { await window.YHApi.editNickname(name); d.name = name; snack('已修改'); renderProfile(); } catch (e) { snack(e.message); } }
    };
    body.querySelector('#pf-edit-avatar').onclick = async () => {
      const url = prompt('头像 URL：');
      if (url) { try { await window.YHApi.editAvatar(url); d.avatar_url = url; snack('已修改'); renderProfile(); } catch (e) { snack(e.message); } }
    };
    body.querySelector('#pf-edit-intro').onclick = async () => {
      const intro = prompt('个人简介：');
      if (intro != null) { try { await window.YHApi.saveUserData({ introduction: intro, gender: 3 }); snack('已修改'); } catch (e) { snack(e.message); } }
    };
    body.querySelector('#pf-refresh').onclick = () => loadConversations();
    body.querySelector('#pf-theme').onclick = () => {
      const cur = document.documentElement.getAttribute('mdui-color-scheme');
      document.documentElement.setAttribute('mdui-color-scheme', cur === 'dark' ? 'light' : 'dark');
    };
    body.querySelector('#pf-password').onclick = () => {
      const d2 = openDialog(`<div style="padding:18px">
        <div style="font-weight:800;margin-bottom:12px">修改密码</div>
        <mdui-text-field id="pw-email" label="邮箱" class="yh-full"></mdui-text-field>
        <mdui-text-field id="pw-captcha" label="邮箱验证码" class="yh-full"></mdui-text-field>
        <mdui-text-field id="pw-pwd" label="新密码" type="password" class="yh-full"></mdui-text-field>
        <div class="yh-compose-actions"><mdui-button variant="filled" id="pw-submit">确认</mdui-button></div>
      </div>`, { width: 420 });
      d2.querySelector('#pw-submit').onclick = async () => {
        const email = d2.querySelector('#pw-email').value.trim();
        const captcha = d2.querySelector('#pw-captcha').value.trim();
        const pwd = d2.querySelector('#pw-pwd').value;
        if (!email || !captcha || !pwd) { snack('请填写完整'); return; }
        try { await window.YHApi.changePassword(email, captcha, pwd); snack('密码已修改'); d2.open = false; }
        catch (e) { snack(e.message); }
      };
    };
    body.querySelector('#pf-bind-email').onclick = () => {
      const d2 = openDialog(`<div style="padding:18px">
        <div style="font-weight:800;margin-bottom:12px">绑定邮箱</div>
        <mdui-text-field id="be-email" label="邮箱" class="yh-full"></mdui-text-field>
        <mdui-text-field id="be-captcha" label="邮箱验证码" class="yh-full"></mdui-text-field>
        <div class="yh-compose-actions"><mdui-button variant="filled" id="be-submit">确认</mdui-button></div>
      </div>`, { width: 420 });
      d2.querySelector('#be-submit').onclick = async () => {
        const email = d2.querySelector('#be-email').value.trim();
        const captcha = d2.querySelector('#be-captcha').value.trim();
        if (!email || !captcha) { snack('请填写完整'); return; }
        try { await window.YHApi.bindEmail(email, captcha); snack('绑定成功'); d2.open = false; }
        catch (e) { snack(e.message); }
      };
    };
    body.querySelector('#pf-settings').onclick = showSettings;
    body.querySelector('#pf-logout').onclick = () => confirmDialog('退出登录', '确定要退出当前账号吗？', async () => {
      try { await window.YHApi.logout(); } catch (e) {}
      window.YHWs.disconnect(); window.YHApi.clearSession(); location.reload();
    });
  }

  // ============ 设置页 ============
  function showSettings() {
    $('#profile-body').hidden = true;
    const sp = $('#settings-page');
    sp.hidden = false;
    const curProxy = localStorage.getItem('yh_media_proxy') == null
      ? 'api.cfknb.vip/yhchat/img_proxy/'
      : (localStorage.getItem('yh_media_proxy') || '');
    const erudaOn = localStorage.getItem('yh_eruda') === '1';
    const curSig = localStorage.getItem('yh_msg_sig') || '';
    const cronCfg = loadCronConfig();
    // 多选目标初始化：兼容旧格式 cfg.target
    const _cronTargets = cronCfg.targets || (cronCfg.target ? [cronCfg.target] : ['all']);
    const cronTargetSet = new Set((_cronTargets || []).map(String));
    const cronAllChecked = cronTargetSet.has('all') || cronTargetSet.size === 0;
    // 防撤回配置
    const arCfg = loadAntiRecallConfig();
    const _arTargets = arCfg.targets || ['all'];
    const arTargetSet = new Set((_arTargets || []).map(String));
    const arAllChecked = arTargetSet.has('all') || arTargetSet.size === 0;
    sp.innerHTML = `<div class="yh-settings-page">
      <div class="yh-settings-back">
        <mdui-button-icon icon="arrow_back" id="st-back"></mdui-button-icon>
        <span class="yh-settings-back-title">设置</span>
      </div>
      <div class="yh-settings-section">
        <div class="yh-settings-section-title">消息小尾巴</div>
        <div class="yh-settings-row">
          <mdui-text-field id="st-sig" class="yh-full" variant="outlined" label="每条消息后自动追加的字符"
            value="${window.YHRender.escapeHtml(curSig)}" placeholder="例如：—— 来自 yhchat-web&#10;（支持多行，留空关闭）"
            rows="3"></mdui-text-field>
        </div>
        <div class="yh-settings-hint">发送文本/Markdown/HTML/表单消息时自动追加到正文最后。编辑消息时不会再重复加尾，
          图片/文件/视频/语音等非文本类内容不会贴小尾巴。</div>
      </div>
      <div class="yh-settings-section">
        <div class="yh-settings-section-title">图片代理</div>
        <div class="yh-settings-row">
          <mdui-text-field id="st-proxy" class="yh-full" label="图片代理地址" value="${window.YHRender.escapeHtml(curProxy)}" placeholder="api.cfknb.vip/yhchat/img_proxy/"></mdui-text-field>
        </div>
        <div class="yh-settings-hint">用于规避云湖 CDN 防盗链，留空则不代理。留空可恢复直连。</div>
      </div>
      <div class="yh-settings-section">
        <div class="yh-settings-section-title">调试工具</div>
        <div class="yh-settings-row">
          <span style="flex:1">启用 Eruda 调试控制台</span>
          <mdui-switch id="st-eruda" ${erudaOn ? 'checked' : ''}></mdui-switch>
        </div>
        <div class="yh-settings-hint">Eruda 提供移动端网页调试面板（Console / Network / Elements 等）。</div>
      </div>
      <div class="yh-settings-section">
        <div class="yh-settings-section-title">定时发送消息</div>
        <div class="yh-settings-row">
          <span style="flex:1">启用定时发送（页面需保持打开）</span>
          <mdui-switch id="st-cron-on" ${cronCfg.enabled ? 'checked' : ''}></mdui-switch>
        </div>
        <div class="yh-settings-row">
          <div class="yh-cron-targets" style="flex:1">
            <div class="yh-cron-targets-header">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;font-weight:600">
                <input type="checkbox" id="st-cron-all" ${cronAllChecked ? 'checked' : ''} />
                全部会话
              </label>
            </div>
            <div class="yh-cron-targets-list">
              ${(S.conversations || []).map(c => `
                <label class="yh-cron-target-item">
                  <input type="checkbox" class="st-cron-tgt" data-id="${window.YHRender.escapeHtml(String(c.chatId))}" data-type="${c.chatType}" data-name="${window.YHRender.escapeHtml(c.name || c.chatId)}" ${cronTargetSet.has(String(c.chatId)) ? 'checked' : ''} />
                  <span class="yh-cron-target-name">${window.YHRender.escapeHtml(c.name || c.chatId)}</span>
                  <span class="yh-cron-target-type">${typeName(c.chatType)}</span>
                </label>
              `).join('')}
              ${(S.conversations || []).length === 0 ? '<div class="yh-contact-sub" style="padding:12px;text-align:center">暂无会话</div>' : ''}
            </div>
          </div>
        </div>
        <div class="yh-settings-hint">选择发送目标：勾选"全部会话"或手动多选指定会话。</div>
        <div class="yh-settings-row">
          <mdui-text-field id="st-cron-content" class="yh-full" variant="outlined" label="发送内容" rows="3"
            value="${window.YHRender.escapeHtml(cronCfg.content || '')}" placeholder="输入要定时发送的文本消息"></mdui-text-field>
        </div>
        <div class="yh-settings-row">
          <mdui-text-field id="st-cron-expr" class="yh-full" variant="outlined" label="Cron 表达式（分 时 日 月 周）"
            value="${window.YHRender.escapeHtml(cronCfg.cron || '0 9 * * *')}" placeholder="0 9 * * *"></mdui-text-field>
        </div>
        <div class="yh-settings-hint">标准 5 字段 cron：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-7, 0和7=周日)。
          示例：<code>0 9 * * *</code> 每天9:00 · <code>*/30 * * * *</code> 每30分钟 · <code>0 9 * * 1-5</code> 工作日9:00</div>
      </div>
      <div class="yh-settings-section">
        <div class="yh-settings-section-title">防撤回</div>
        <div class="yh-settings-row">
          <span style="flex:1">启用防撤回（定期轮询检测撤回消息，保留原始内容）</span>
          <mdui-switch id="st-ar-on" ${arCfg.enabled ? 'checked' : ''}></mdui-switch>
        </div>
        <div class="yh-settings-row">
          <div class="yh-cron-targets" style="flex:1">
            <div class="yh-cron-targets-header">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;font-weight:600">
                <input type="checkbox" id="st-ar-all" ${arAllChecked ? 'checked' : ''} />
                全部会话
              </label>
            </div>
            <div class="yh-cron-targets-list">
              ${(S.conversations || []).map(c => `
                <label class="yh-cron-target-item">
                  <input type="checkbox" class="st-ar-tgt" data-id="${window.YHRender.escapeHtml(String(c.chatId))}" ${arTargetSet.has(String(c.chatId)) ? 'checked' : ''} />
                  <span class="yh-cron-target-name">${window.YHRender.escapeHtml(c.name || c.chatId)}</span>
                  <span class="yh-cron-target-type">${typeName(c.chatType)}</span>
                </label>
              `).join('')}
              ${(S.conversations || []).length === 0 ? '<div class="yh-contact-sub" style="padding:12px;text-align:center">暂无会话</div>' : ''}
            </div>
          </div>
        </div>
        <div class="yh-settings-hint">选择监听目标：勾选"全部会话"或手动多选指定会话。</div>
        <div class="yh-settings-row">
          <mdui-text-field id="st-ar-interval" class="yh-full" variant="outlined" label="轮询间隔（秒）" type="number"
            value="${arCfg.interval || 30}"></mdui-text-field>
        </div>
        <div class="yh-settings-hint">每隔指定秒数拉取一次目标会话的最新消息，对比缓存检测撤回。建议 30~120 秒，过短会增加服务器负担。</div>
      </div>
    </div>`;
    sp.querySelector('#st-back').onclick = () => { sp.hidden = true; $('#profile-body').hidden = false; };
    // 消息小尾巴：失焦/回车保存
    const sigInput = sp.querySelector('#st-sig');
    sigInput.addEventListener('change', () => {
      const v = sigInput.value;
      localStorage.setItem('yh_msg_sig', v);
      window.YHApi.MSG_SIG = v;
      snack(v ? '已启用消息小尾巴：发送时会自动追加到文本末尾' : '已关闭消息小尾巴');
    });
    // 图片代理：失焦时保存
    const proxyInput = sp.querySelector('#st-proxy');
    proxyInput.addEventListener('change', () => {
      let v = proxyInput.value.trim();
      localStorage.setItem('yh_media_proxy', v);
      // 补全 https:// 前缀（用户可能只填了域名路径）
      if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
      // 路径形式的代理末尾要 "/"，否则 mediaUrl() 会按 query 形式 encodeURIComponent
      // 贴到 url= 后面。保存前标准化一下：如果不是 "?url=" 结尾就补 '/'
      if (v && !v.endsWith('/') && !/[?&](?:url|src|target)=?$/.test(v)) v += '/';
      window.YHApi.MEDIA_PROXY = v;
      snack('图片代理已保存');
    });
    // Eruda 开关
    const erudaSw = sp.querySelector('#st-eruda');
    erudaSw.addEventListener('change', () => {
      const on = erudaSw.checked;
      localStorage.setItem('yh_eruda', on ? '1' : '0');
      if (on) loadEruda();
      else { try { if (window.eruda) window.eruda.destroy(); } catch (e) {} }
      snack(on ? 'Eruda 已启用' : 'Eruda 已关闭');
    });
    // 定时发送消息开关
    const cronSw = sp.querySelector('#st-cron-on');
    cronSw.addEventListener('change', () => {
      const cfg = loadCronConfig();
      cfg.enabled = cronSw.checked;
      saveCronConfig(cfg);
      if (cfg.enabled) { startCronScheduler(); snack('定时发送已开启'); }
      else { startCronScheduler(); snack('定时发送已关闭'); }
    });
    // 保存 cron 表达式
    const cronInput = sp.querySelector('#st-cron-expr');
    cronInput.addEventListener('change', () => {
      const cfg = loadCronConfig();
      const v = cronInput.value.trim();
      // 简单校验：5 字段
      if (v && v.split(/\s+/).length !== 5) { snack('Cron 表达式格式错误，需要 5 个字段：分 时 日 月 周'); return; }
      cfg.cron = v || '0 9 * * *';
      saveCronConfig(cfg);
      startCronScheduler();
      snack('Cron 表达式已保存');
    });
    // 保存发送内容
    const contentInput = sp.querySelector('#st-cron-content');
    contentInput.addEventListener('change', () => {
      const cfg = loadCronConfig();
      cfg.content = contentInput.value;
      saveCronConfig(cfg);
      snack('定时发送内容已保存');
    });
    // 目标选择：全部会话开关
    const allCheck = sp.querySelector('#st-cron-all');
    const tgtChecks = sp.querySelectorAll('.st-cron-tgt');
    function saveCronTargets() {
      const cfg = loadCronConfig();
      if (allCheck.checked) {
        cfg.targets = ['all'];
      } else {
        const ids = [];
        tgtChecks.forEach(cb => { if (cb.checked) ids.push(cb.dataset.id); });
        cfg.targets = ids.length ? ids : ['all']; // 空了就当全部
      }
      // 移除旧字段
      delete cfg.target; delete cfg.targetName; delete cfg.targetType;
      saveCronConfig(cfg);
    }
    allCheck.addEventListener('change', () => {
      // 勾选全部时，取消所有子项勾选
      if (allCheck.checked) {
        tgtChecks.forEach(cb => { cb.checked = false; });
      }
      saveCronTargets();
      snack('发送目标已保存');
    });
    tgtChecks.forEach(cb => {
      cb.addEventListener('change', () => {
        // 手动勾选子项时，自动取消"全部会话"
        if (cb.checked && allCheck.checked) allCheck.checked = false;
        saveCronTargets();
      });
    });
    // 防撤回：开关
    const arSw = sp.querySelector('#st-ar-on');
    arSw.addEventListener('change', () => {
      const cfg = loadAntiRecallConfig();
      cfg.enabled = arSw.checked;
      saveAntiRecallConfig(cfg);
      startAntiRecallPoller();
      snack(arSw.checked ? '防撤回已开启' : '防撤回已关闭');
    });
    // 防撤回：目标多选
    const arAll = sp.querySelector('#st-ar-all');
    const arTgts = sp.querySelectorAll('.st-ar-tgt');
    function saveARTargets() {
      const cfg = loadAntiRecallConfig();
      if (arAll.checked) {
        cfg.targets = ['all'];
      } else {
        const ids = [];
        arTgts.forEach(cb => { if (cb.checked) ids.push(cb.dataset.id); });
        cfg.targets = ids.length ? ids : ['all'];
      }
      saveAntiRecallConfig(cfg);
    }
    arAll.addEventListener('change', () => {
      if (arAll.checked) { arTgts.forEach(cb => { cb.checked = false; }); }
      saveARTargets();
      snack('防撤回目标已保存');
    });
    arTgts.forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked && arAll.checked) arAll.checked = false;
        saveARTargets();
      });
    });
    // 防撤回：轮询间隔
    const arInterval = sp.querySelector('#st-ar-interval');
    arInterval.addEventListener('change', () => {
      const cfg = loadAntiRecallConfig();
      const v = parseInt(arInterval.value) || 30;
      cfg.interval = Math.max(10, v);
      saveAntiRecallConfig(cfg);
      startAntiRecallPoller();
      snack('轮询间隔已保存');
    });
  }

  function loadEruda() {
    if (window.eruda) { try { window.eruda.init(); } catch (e) {} return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/eruda';
    s.onload = () => { try { window.eruda.init(); } catch (e) { console.warn(e); } };
    s.onerror = () => snack('Eruda 加载失败');
    document.head.appendChild(s);
  }

  // ============ 定时发送消息（Cron） ============
  // 配置存储在 localStorage（yh_cron_send），结构：
  //   { enabled, target, targetName, content, cron }
  //   target = "all" → 向所有会话发送；否则为具体 chatId
  //   cron 为标准 5 字段："分 时 日 月 周"
  let _cronTimer = null;
  let _cronLastFired = ''; // 防止同一分钟内重复触发

  function loadCronConfig() {
    try { return JSON.parse(localStorage.getItem('yh_cron_send') || '{}'); }
    catch (e) { return {}; }
  }
  function saveCronConfig(cfg) {
    localStorage.setItem('yh_cron_send', JSON.stringify(cfg));
  }

  // 简易 cron 匹配器：支持 * / 数字 / 逗号 / 范围(-) / 步长(/)
  function cronMatch(expr, date) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    function matchField(field, value) {
      if (field === '*') return true;
      for (const part of field.split(',')) {
        if (part.includes('/')) {
          const [range, stepStr] = part.split('/');
          const step = parseInt(stepStr);
          if (range === '*') {
            if (value % step === 0) return true;
          } else if (range.includes('-')) {
            const [lo, hi] = range.split('-').map(n => parseInt(n));
            if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
          } else {
            const base = parseInt(range);
            if (value >= base && (value - base) % step === 0) return true;
          }
        } else if (part.includes('-')) {
          const [lo, hi] = part.split('-').map(n => parseInt(n));
          if (value >= lo && value <= hi) return true;
        } else {
          if (parseInt(part) === value) return true;
        }
      }
      return false;
    }
    // dow: JS getDay() 0=Sunday；cron 里 0 和 7 都表示周日
    const dow = date.getDay();
    return matchField(parts[0], date.getMinutes()) &&
           matchField(parts[1], date.getHours()) &&
           matchField(parts[2], date.getDate()) &&
           matchField(parts[3], date.getMonth() + 1) &&
           matchField(parts[4], dow === 0 ? 7 : dow);
  }

  function startCronScheduler() {
    if (_cronTimer) { clearInterval(_cronTimer); _cronTimer = null; }
    const cfg = loadCronConfig();
    if (!cfg.enabled) return;
    _cronTimer = setInterval(() => {
      const cfgNow = loadCronConfig();
      if (!cfgNow.enabled || !cfgNow.cron || !cfgNow.content) return;
      const now = new Date();
      // 防止同一分钟重复触发
      const nowKey = now.getFullYear() + '-' + (now.getMonth()+1) + '-' + now.getDate() +
                     ' ' + now.getHours() + ':' + now.getMinutes();
      if (_cronLastFired === nowKey) return;
      if (!cronMatch(cfgNow.cron, now)) return;
      _cronLastFired = nowKey;
      executeCronSend(cfgNow);
    }, 30000); // 每 30 秒检查一次
  }

  async function executeCronSend(cfg) {
    if (!cfg.content) return;
    // 兼容旧格式：cfg.target 单目标 → 转数组
    let targetIds = cfg.targets || (cfg.target ? [cfg.target] : []);
    if (!Array.isArray(targetIds)) targetIds = [];
    const targets = [];
    const allConvs = S.conversations || [];
    // 如果包含 "all" 或为空 → 全部会话
    if (targetIds.includes('all') || targetIds.length === 0) {
      allConvs.forEach(c => {
        targets.push({ chatId: c.chatId, chatType: c.chatType, name: c.name });
      });
    } else {
      const idSet = new Set(targetIds.map(String));
      allConvs.forEach(c => {
        if (idSet.has(String(c.chatId))) {
          targets.push({ chatId: c.chatId, chatType: c.chatType, name: c.name });
        }
      });
    }
    let ok = 0, fail = 0;
    for (const t of targets) {
      try {
        await window.YHApi.sendMessage({
          chatId: t.chatId, chatType: t.chatType, contentType: 1, text: cfg.content
        });
        ok++;
      } catch (e) { fail++; console.error('[cron] 发送失败', t.chatId, e); }
    }
    snack('定时消息已发送（成功' + ok + (fail ? ' 失败' + fail : '') + '）');
  }

  // ============ 防撤回 ============
  // 配置存储在 localStorage（yh_anti_recall），结构：
  //   { enabled, targets: ['all' | chatId...], interval }
  // 缓存 S._antiRecallCache: Map<msg_id, { content, content_type, sender, send_time, msg_seq, recalled: false }>
  function loadAntiRecallConfig() {
    try { return JSON.parse(localStorage.getItem('yh_anti_recall') || '{}'); }
    catch (e) { return {}; }
  }
  function saveAntiRecallConfig(cfg) {
    localStorage.setItem('yh_anti_recall', JSON.stringify(cfg));
  }

  // 把消息写入防撤回缓存（仅在已启用且目标匹配时）
  function cacheMsgForAntiRecall(msg) {
    if (!msg || !msg.msg_id) return;
    const cfg = loadAntiRecallConfig();
    if (!cfg.enabled) return;
    // 检查是否为目标会话
    const targets = cfg.targets || ['all'];
    const isTarget = targets.includes('all') || targets.includes(String(msg.chat_id));
    if (!isTarget) return;
    // 如果已缓存且已标记撤回，不覆盖原始内容
    if (S._antiRecallCache.has(String(msg.msg_id))) {
      const existing = S._antiRecallCache.get(String(msg.msg_id));
      if (existing.recalled) return; // 已撤回的保留原始内容
    }
    // 深拷贝 content 以防引用变化
    S._antiRecallCache.set(String(msg.msg_id), {
      content: JSON.parse(JSON.stringify(msg.content || {})),
      content_type: msg.content_type,
      sender: msg.sender ? { chat_id: msg.sender.chat_id, name: msg.sender.name, avatar_url: msg.sender.avatar_url } : null,
      send_time: msg.send_time,
      msg_seq: msg.msg_seq,
      chat_id: msg.chat_id,
      chat_type: msg.chat_type,
      recalled: false
    });
    // 限制缓存大小
    if (S._antiRecallCache.size > 5000) {
      const firstKey = S._antiRecallCache.keys().next().value;
      S._antiRecallCache.delete(firstKey);
    }
  }

  // 检测消息是否被撤回：对比缓存内容与新拉取的内容
  function detectRecalledMsgs(msgs) {
    const recalled = [];
    for (const msg of (msgs || [])) {
      const id = String(msg.msg_id);
      if (!id) continue;
      const cached = S._antiRecallCache.get(id);
      if (!cached || cached.recalled) continue;
      // 撤回检测逻辑：
      // 1) content_type 变为系统消息类型（如 RECALL 相关）
      // 2) content.text 变为撤回提示文案（"xxx撤回了一条消息"等）
      // 3) content.text 与缓存的不同（且新内容看起来是撤回提示）
      const newText = (msg.content && msg.content.text) || '';
      const oldText = (cached.content && cached.content.text) || '';
      const isRecallNotice = /撤回|recall|已撤销/i.test(newText) && newText !== oldText;
      const contentTypeChanged = msg.content_type !== cached.content_type;
      // 内容变了且新内容是撤回提示，或者 content_type 变了且内容变了
      if (isRecallNotice || (contentTypeChanged && newText !== oldText)) {
        cached.recalled = true;
        recalled.push({ msg_id: id, original: cached, newMsg: msg });
      }
    }
    return recalled;
  }

  // 定期轮询目标会话的消息，检测撤回
  function startAntiRecallPoller() {
    if (S._antiRecallTimer) { clearInterval(S._antiRecallTimer); S._antiRecallTimer = 0; }
    const cfg = loadAntiRecallConfig();
    if (!cfg.enabled) return;
    const interval = (cfg.interval || 30) * 1000;
    S._antiRecallTimer = setInterval(async () => {
      const cfgNow = loadAntiRecallConfig();
      if (!cfgNow.enabled) return;
      const targets = cfgNow.targets || ['all'];
      let targetChats = [];
      if (targets.includes('all')) {
        targetChats = (S.conversations || []).map(c => ({ chatId: c.chatId, chatType: c.chatType }));
      } else {
        (S.conversations || []).forEach(c => {
          if (targets.includes(String(c.chatId))) targetChats.push({ chatId: c.chatId, chatType: c.chatType });
        });
      }
      let totalRecalled = 0;
      for (const t of targetChats) {
        try {
          const msgs = await window.YHApi.getMessages(t.chatId, t.chatType, 30);
          // 先把新消息缓存（如果还没缓存的话）
          (msgs || []).forEach(m => cacheMsgForAntiRecall(window.YHWs ? normalizeRest(m) : m));
          // 检测撤回
          const recalled = detectRecalledMsgs(msgs);
          if (recalled.length) {
            totalRecalled += recalled.length;
            // 如果当前正在查看这个会话，刷新显示
            if (S.active && String(S.active.chatId) === String(t.chatId)) {
              // 更新 UI 中被撤回的消息
              recalled.forEach(r => {
                const el = document.querySelector(`.yh-msg[data-msg-id="${r.msg_id}"]`);
                if (el) {
                  // 在气泡上方加"已撤回"标记，但保留原始内容
                  if (!el.querySelector('.yh-recalled-tag')) {
                    const tag = document.createElement('div');
                    tag.className = 'yh-recalled-tag';
                    tag.textContent = '已撤回';
                    el.querySelector('.yh-bubble')?.insertBefore(tag, el.querySelector('.yh-bubble').firstChild);
                  }
                }
              });
            }
          }
        } catch (e) { /* 静默失败 */ }
      }
      if (totalRecalled) snack('检测到 ' + totalRecalled + ' 条撤回消息');
    }, interval);
  }

  // 启动时按需加载 Eruda
  if (localStorage.getItem('yh_eruda') === '1') loadEruda();

  // go
  window.YH = { afterLogin, switchView, openChat, loadConversations, renderConversations, renderMessages, S, snack };

  // 显式加载 Material Icons 字体（mdui 2.x shadow DOM 里的图标实际 font-family 为 'Material Icons'）。
  // 用 FontFace API 比 @font-face 更可靠，能保证 shadow DOM 里的图标渲染为字形。
  (function loadIconFont() {
    try {
      const ff = new FontFace('Material Icons', 'url(./vendor/material-icons.woff2)');
      ff.load().then(loaded => {
        document.fonts.add(loaded);
        document.documentElement.dataset.yhIconFont = 'ready';
      }).catch(e => console.warn('[yhchat] 图标字体加载失败', e));
    } catch (e) { console.warn(e); }
  })();

  // 等待 mdui ESM 注册完成（模块脚本早于 DOMContentLoaded 执行并派发该事件），
  // 等待 mdui ESM 注册完成（模块脚本早于 DOMContentLoaded 执行并派发该事件），
  // 且 DOM 解析完毕后再启动。
  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  }
  if (window.mdui) start();
  else window.addEventListener('mdui-ready', start, { once: true });
})();
