// Yhchat Web - main UI controller
(function () {
  // 惰性读取 window.mdui —— ESM 模块在 DOMContentLoaded 之后才执行并完成组件注册，
  // 因此 IIFE 解析时 window.mdui 尚未就绪。这里用 Proxy 转发到 window.mdui。
  const mdui = new Proxy({}, { get(_, k) { return window.mdui ? window.mdui[k] : undefined; } });
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const CT = window.YHApi.CT;

  const S = { profile: null, conversations: [], active: null, messages: [], baList: [], posts: [] };

  function snack(msg, opts) { try { mdui.snackbar(Object.assign({ message: msg }, opts || {})); } catch (e) { console.warn(e); } }
  // 头像内部结构：img 加载失败时自动移除，露出下方首字母兜底；URL 走 mediaUrl 代理规避防盗链
  function avatarInner(url, name, size) {
    const sz = size || 40;
    const ch = window.YHRender.escapeHtml((name || '?').slice(0, 1));
    const proxied = url ? window.YHApi.mediaUrl(url) : '';
    const img = proxied ? `<img src="${window.YHRender.escapeHtml(proxied)}" alt="" onerror="this.remove()">` : '';
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

  // ============ 初始化 ============
  function init() {
    try { window.YHApi.init(); } catch (e) { console.error(e); alert('依赖加载失败：' + e.message); return; }
    bindLogin(); bindNav(); bindChat(); bindContacts();
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
  }

  async function loadProfile() {
    try { S.profile = await window.YHApi.getProfile(); }
    catch (e) { snack('获取个人信息失败：' + e.message); }
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
    $('#rail').addEventListener('change', e => go(e.target.value));
    $('#bottom-nav').addEventListener('change', e => go(e.target.value));
  }
  function switchView(v) {
    $('#rail').value = v; $('#bottom-nav').value = v;
    ['messages', 'contacts', 'community', 'profile'].forEach(name => {
      $('#view-' + name).hidden = (name !== v);
    });
    if (v === 'contacts') loadContacts();
    if (v === 'community') loadCommunityBa();
    if (v === 'profile') renderProfile();
  }

  // ============ 会话 / 聊天 ============
  async function loadConversations() {
    try {
      S.conversations = await window.YHApi.listConversations();
      // 排序：置顶优先，再按时间
      S.conversations.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      renderConversations();
    } catch (e) { snack('获取会话失败：' + e.message); }
  }

  function renderConversations() {
    const list = $('#conv-list'); list.innerHTML = '';
    S.conversations.forEach(conv => {
      const el = document.createElement('div');
      el.className = 'yh-conv' + (S.active && S.active.chatId === conv.chatId ? ' active' : '');
      const dnd = conv.doNotDisturb === 1 ? '<span class="yh-dot-dnd"></span>' : '';
      const unread = conv.unreadMessage === 1 ? `<span class="yh-badge">${conv.at === 1 ? '@' : '•'}</span>` : '';
      el.innerHTML = `<div class="yh-conv-avatar">${avatarHtml(conv.avatarUrl, conv.name, 46)}${dnd}</div>
        <div class="yh-conv-main">
          <div class="yh-conv-name"><span class="t">${window.YHRender.escapeHtml(conv.name || '')}</span><span class="yh-conv-time">${window.YHRender.formatTime(conv.timestampMs)}</span></div>
          <div class="yh-conv-last">${unread}${window.YHRender.escapeHtml(conv.chatContent || '')}</div>
        </div>`;
      el.onclick = () => openChat(conv);
      list.appendChild(el);
    });
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
    await loadMessages(conv.chatId, conv.chatType);
  }

  async function loadMessages(chatId, chatType) {
    try {
      const msgs = await window.YHApi.getMessages(chatId, chatType, 30);
      S.messages = msgs.map(m => window.YHWs ? normalizeRest(m) : m);
      renderMessages();
    } catch (e) { snack('获取消息失败：' + e.message); }
  }

  function normalizeRest(m) {
    return {
      msg_id: m.msg_id, sender: m.sender ? { chat_id: m.sender.chat_id, chat_type: m.sender.chat_type, name: m.sender.name, avatar_url: m.sender.avatar_url } : null,
      recv_id: m.recv_id, chat_id: m.chat_id, chat_type: m.chat_type, content_type: m.content_type,
      content: m.content || {}, send_time: m.send_time, msg_seq: m.msg_seq, quote_msg_id: m.quote_msg_id, cmd: m.cmd ? (m.cmd.name || m.cmd) : null
    };
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
    box.scrollTop = box.scrollHeight;
  }

  function appendMessage(msg) {
    if (msg.msg_id && S.messages.some(m => m.msg_id === msg.msg_id)) return; // 去重
    const myId = window.YHApi.userId;
    const showName = msg.sender && msg.sender.chat_id !== myId;
    const box = $('#chat-messages');
    box.appendChild(window.YHRender.renderBubble(msg, { showName }));
    bindMessageEvents(box);
    box.scrollTop = box.scrollHeight;
    S.messages.push(msg);
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
    const input = $('#chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
    input.addEventListener('input', () => { if (S.active) window.YHWs.sendDraft(S.active.chatId, input.value); });
    $('#btn-chat-back').onclick = () => { $('#view-messages').classList.remove('chat-open'); S.active = null; renderConversations(); };
    $('#btn-chat-info').onclick = () => { if (S.active) showDetail(S.active.chatType, S.active.chatId, S.active.name); };
    $('#btn-search').onclick = openSearch;
    $('#btn-new-chat').onclick = openSearch;
    $('#attach-menu').addEventListener('change', (e) => {
      const kind = e.target.value; if (!kind || !S.active) return;
      const map = { img: ['图片链接', CT.IMAGE, 'image'], file: ['文件链接', CT.FILE, 'file'], audio: ['语音链接', CT.AUDIO, 'audio'], video: ['视频链接', CT.VIDEO, 'video'] };
      const [label, ct, field] = map[kind];
      const url = prompt('输入' + label + '（直链 URL）：');
      if (url) sendPayload({ [field]: url, contentType: ct });
    });
  }

  async function sendText() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || !S.active) return;
    await sendPayload({ text, contentType: CT.TEXT });
    input.value = '';
  }

  async function sendPayload(opts) {
    if (!S.active) return;
    const payload = Object.assign({ chatId: S.active.chatId, chatType: S.active.chatType }, opts);
    try {
      await window.YHApi.sendMessage(payload);
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
          (cat.list || []).forEach(it => {
            const el = document.createElement('div'); el.className = 'yh-contact-item';
            el.innerHTML = `${avatarHtml(it.avatarUrl, it.nickname, 40)}<div><div class="yh-contact-name">${window.YHRender.escapeHtml(it.nickname || it.name || '')}</div><div class="yh-contact-sub">${typeName(it.friendType)}</div></div>`;
            el.onclick = () => { d.open = false; openChat({ chatId: it.friendId, chatType: it.friendType, name: it.nickname || it.name, avatarUrl: it.avatarUrl }); };
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
    // 通讯录按 list_name 区分类型：好友/用户=1，我加入的群聊=2，机器人=3
    const cats = [
      { t: 1, label: '好友', items: [] },
      { t: 2, label: '群聊', items: [] },
      { t: 3, label: '机器人', items: [] }
    ];
    (book || []).forEach(group => {
      const ln = group.list_name || '';
      let t = 0;
      if (ln === '好友' || ln === '用户') t = 1;
      else if (ln.indexOf('群聊') >= 0) t = 2;
      else if (ln === '机器人') t = 3;
      if (!t) return;
      const cat = cats.find(c => c.t === t);
      (group.data || []).forEach(it => cat.items.push(it));
    });
    cats.forEach(cat => {
      if (!cat.items.length) return;
      const g = document.createElement('div'); g.className = 'yh-contact-group';
      g.innerHTML = `<div class="yh-cat-head">${window.YHRender.escapeHtml(cat.label)}（${cat.items.length}）</div>`;
      cat.items.forEach(it => {
        const el = document.createElement('div'); el.className = 'yh-contact-item';
        el.innerHTML = `${avatarHtml(it.avatar_url, it.name, 42)}<div><div class="yh-contact-name">${window.YHRender.escapeHtml(it.name || '')}</div><div class="yh-contact-sub">${typeName(cat.t)}</div></div>`;
        el.onclick = () => openChat({ chatId: it.chat_id, chatType: cat.t, name: it.name, avatarUrl: it.avatar_url });
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
  async function loadCommunityBa() {
    try {
      const data = await window.YHApi.communityBaList(1, 30, '');
      S.baList = (data && data.ba) || [];
      renderBa();
    } catch (e) { snack('获取社区分区失败：' + e.message); }
  }
  function renderBa() {
    const box = $('#community-ba'); box.hidden = false; $('#community-posts').hidden = true;
    box.innerHTML = '';
    if (!S.baList.length) { box.innerHTML = '<div class="yh-contact-sub" style="padding:14px">暂无分区</div>'; return; }
    S.baList.forEach(ba => {
      const el = document.createElement('div'); el.className = 'yh-ba-card';
      el.innerHTML = `${avatarHtml(ba.avatar, ba.name, 48)}<div class="yh-ba-meta"><div class="yh-ba-title">${window.YHRender.escapeHtml(ba.name || '')}</div><div class="yh-ba-desc">${ba.memberNum || 0} 成员 · ${ba.postNum || 0} 文章</div></div><mdui-icon-button icon="chevron_right"></mdui-icon-button>`;
      el.onclick = () => loadPosts(ba.id);
      box.appendChild(el);
    });
  }
  async function loadPosts(baId) {
    try {
      const data = await window.YHApi.communityPosts(baId, 1, 20);
      S.posts = (data && data.posts) || [];
      renderPosts();
    } catch (e) { snack('获取文章失败：' + e.message); }
  }
  function renderPosts() {
    const box = $('#community-posts'); box.hidden = false; $('#community-ba').hidden = true;
    box.innerHTML = '';
    const back = document.createElement('mdui-button'); back.icon = 'arrow_back'; back.textContent = '分区'; back.onclick = renderBa; box.appendChild(back);
    if (!S.posts.length) { box.innerHTML += '<div class="yh-contact-sub" style="padding:14px">暂无文章</div>'; return; }
    S.posts.forEach(p => {
      const el = document.createElement('div'); el.className = 'yh-post-card';
      const author = p.senderNickname || '匿名';
      const stats = `${p.likeNum || 0} 赞 · ${p.commentNum || 0} 评 · ${p.collectNum || 0} 藏`;
      let text = p.content || '';
      if (p.contentType === 2) { try { text = window.marked ? window.marked.parse(text) : text; } catch (e) {} text = window.YHRender.sanitizeHtml(text); }
      else text = window.YHRender.escapeHtml(text);
      el.innerHTML = `<div class="yh-post-head">${avatarHtml(p.senderAvatar, author, 32)}<div><div class="yh-post-card-title">${window.YHRender.escapeHtml(p.title || '无标题')}</div><div class="yh-contact-sub">${window.YHRender.escapeHtml(author)} · ${window.YHRender.formatTime(p.createTime)}</div></div></div>
        <div class="yh-post-card-text">${text}</div><div class="yh-post-card-stats">${stats}</div>`;
      el.onclick = () => openPost(p.id);
      box.appendChild(el);
    });
  }

  async function openPost(postId) {
    try {
      const data = await window.YHApi.postDetail(postId);
      const post = (data && data.post) || data || {};
      const author = post.senderNickname || '匿名';
      let text = post.content || '';
      if (post.contentType === 2) { try { text = window.marked ? window.marked.parse(text) : text; } catch (e) {} text = window.YHRender.sanitizeHtml(text); }
      else text = window.YHRender.escapeHtml(text).replace(/\n/g, '<br/>');
      openDialog(`<div style="padding:18px">${avatarHtml(post.senderAvatar, author, 40)}<div style="font-size:20px;font-weight:800;margin:8px 0 6px">${window.YHRender.escapeHtml(post.title || '')}</div>
        <div class="yh-contact-sub" style="margin-bottom:12px">${window.YHRender.escapeHtml(author)}</div>
        <div style="line-height:1.7">${text}</div></div>`, { width: 640 });
    } catch (e) { snack('获取文章详情失败：' + e.message); }
  }

  // ============ 详情（用户/群/机器人） ============
  async function showDetail(type, id, fallbackName) {
    let html = '<div style="padding:18px;text-align:center">加载中…</div>';
    const d = openDialog(html, { width: 480 });
    try {
      let info, name, avatar, sub = '', extra = '';
      if (type === 1) { const u = await window.YHApi.getUser(id); info = u; name = u.name; avatar = u.avatar_url; sub = (u.profile_info && u.profile_info.introduction) || ''; extra = `手机号：${u.phone || '—'}<br/>注册：${u.register_time || '—'}`; }
      else if (type === 2) { const g = await window.YHApi.getGroupInfo(id); info = g; name = g.name; avatar = g.avatar_url; sub = g.introduction || ''; extra = `成员：${g.member || 0}<br/>群口令：${g.group_code || '—'}`; }
      else if (type === 3) { const b = await window.YHApi.getBotInfo(id); info = b; name = b.name; avatar = b.avatar_url; sub = b.introduction || ''; extra = `创建者：${b.create_by || '—'}`; }
      d.innerHTML = `<div style="padding:18px">
        <div style="text-align:center">${avatarHtml(avatar, name, 72)}<div style="font-size:20px;font-weight:800;margin-top:8px">${window.YHRender.escapeHtml(name || fallbackName || '')}</div>
        <div class="yh-contact-sub">${window.YHRender.escapeHtml(sub || '')}</div></div>
        <div style="margin:12px 0;font-size:14px">${extra}</div>
        <div style="display:flex;gap:8px;justify-content:center">
          <mdui-button variant="filled" id="d-msg">发消息</mdui-button>
          ${type === 1 ? '<mdui-button variant="outlined" id="d-add">加好友</mdui-button>' : (type === 2 ? '<mdui-button variant="outlined" id="d-join">加入群聊</mdui-button>' : '')}
        </div></div>`;
      d.querySelector('#d-msg').onclick = () => { d.open = false; openChat({ chatId: id, chatType: type, name: name || fallbackName, avatarUrl: avatar }); };
      const add = d.querySelector('#d-add'); if (add) add.onclick = async () => { try { await window.YHApi.addFriend(id); snack('已发送好友申请'); } catch (e) { snack(e.message); } };
      const join = d.querySelector('#d-join'); if (join) join.onclick = async () => { try { await window.YHApi.joinGroup(id); snack('已申请加入'); } catch (e) { snack(e.message); } };
    } catch (e) { d.innerHTML = `<div style="padding:18px" class="yh-error">${window.YHRender.escapeHtml(e.message)}</div>`; }
  }

  // ============ 我的 ============
  function renderProfile() {
    const p = S.profile; if (!p || !p.data) { $('#profile-body').innerHTML = '<div class="yh-contact-sub">未登录</div>'; return; }
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
        <mdui-list-item id="pf-refresh" icon="refresh">刷新会话</mdui-list-item>
        <mdui-list-item id="pf-theme" icon="dark_mode">切换深色模式</mdui-list-item>
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
    body.querySelector('#pf-refresh').onclick = () => loadConversations();
    body.querySelector('#pf-theme').onclick = () => {
      const cur = document.documentElement.getAttribute('mdui-color-scheme');
      document.documentElement.setAttribute('mdui-color-scheme', cur === 'dark' ? 'light' : 'dark');
    };
    body.querySelector('#pf-logout').onclick = () => confirmDialog('退出登录', '确定要退出当前账号吗？', () => {
      window.YHWs.disconnect(); window.YHApi.clearSession(); location.reload();
    });
  }

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
