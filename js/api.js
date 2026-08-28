// Yhchat Web - API layer (HTTP + protobuf)
// Mirrors the Kotlin app's network calls against chat-go.jwzhd.com
(function () {
  const BASE = 'https://chat-go.jwzhd.com';
  let root = null;

  const CT = {
    TEXT: 1, IMAGE: 2, MARKDOWN: 3, FILE: 4, FORM: 5, POST: 6,
    EXPRESSION: 7, HTML: 8, VIDEO: 10, AUDIO: 11, A2UI: 14
  };

  // 生成 UUID：优先用 crypto.randomUUID（需 secure context），不可用时回退到
  // getRandomValues + 手动拼接。这样在 http://<IP> 等非安全上下文也能正常初始化。
  function uuid() {
    try { if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch (e) {}
    const b = crypto && typeof crypto.getRandomValues === 'function'
      ? crypto.getRandomValues(new Uint8Array(16))
      : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0'));
    return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10,16).join('')}`;
  }

  const YHApi = {
    BASE,
    CT,
    token: localStorage.getItem('yh_token') || null,
    userId: localStorage.getItem('yh_uid') || null,
    deviceId: localStorage.getItem('yh_did') || (localStorage.setItem('yh_did', uuid()), localStorage.getItem('yh_did')),

    // 图片/视频等媒体防盗链代理。chat-img*.jwznb.com 的 CDN 校验 Referer 必须为
    // *.jwzhd.com（官方 App 用 OkHttp 拦截器加 Referer，浏览器 <img> 无法自定义该头）。
    // - 部署在 *.jwzhd.com 子域时浏览器会自动带合规 Referer，留空即可正常显示；
    // - 否则需自行部署反向代理（带合规 Referer 拉取），并把本值设为该代理前缀，
    //   例如 "https://your-proxy/?url="（会以 encodeURIComponent(url) 拼接）。
    // 默认使用 api.cfknb.vip 公共代理；可在"我的→设置"中修改。
    MEDIA_PROXY: (function () {
      let v = localStorage.getItem('yh_media_proxy');
      if (v === null) { v = 'https://api.cfknb.vip/yhchat/img_proxy'; }
      if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
      return v;
    })(),

    init() {
      if (!window.protobuf) throw new Error('protobuf.js 未加载');
      root = window.YHBuildRoot();
      return this;
    },

    isLoggedIn() { return !!this.token; },

    setSession(token, userId) {
      this.token = token;
      if (userId) this.userId = userId;
      localStorage.setItem('yh_token', token);
      if (userId) localStorage.setItem('yh_uid', userId);
    },

    clearSession() {
      this.token = null; this.userId = null;
      localStorage.removeItem('yh_token'); localStorage.removeItem('yh_uid');
    },

    // 将媒体 URL 经反向代理转发（用于规避 jwznb CDN 的 Referer 校验）。
    mediaUrl(url) {
      if (!url) return url;
      if (typeof url !== 'string') return url;
      const proxy = this.MEDIA_PROXY;
      if (!proxy) return url;
      return proxy + encodeURIComponent(url);
    },

    _headers(extra) {
      const h = { 'Accept': '*/*' };
      if (this.token) h['token'] = this.token;
      return Object.assign(h, extra || {});
    },

    async rawJson(path, body, method = 'POST') {
      const resp = await fetch(BASE + path, {
        method,
        headers: this._headers({ 'Content-Type': 'application/json' }),
        body: body != null ? JSON.stringify(body) : undefined
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return data;
    },

    async rawProto(path, reqType, resType, payload, method = 'POST') {
      // reqType 为 null 表示该接口无请求体（如 /v1/user/info 为 GET，仅靠 token 头鉴权）
      let body;
      const headers = {};
      if (reqType) {
        const Req = root.lookupType(reqType);
        const msg = Req.create(payload || {});
        body = Req.encode(msg).finish();
        headers['Content-Type'] = 'application/x-protobuf';
      }
      const resp = await fetch(BASE + path, {
        method,
        headers: this._headers(headers),
        body
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const ab = await resp.arrayBuffer();
      const Res = root.lookupType(resType);
      return Res.decode(new Uint8Array(ab));
    },

    // ---------- Auth ----------
    async loginByToken(token) {
      this.setSession(token, null);
      const profile = await this.getProfile();
      if (profile && profile.data && profile.data.id) this.setSession(token, String(profile.data.id));
      return profile;
    },

    async loginPhone(mobile, captcha) {
      const r = await this.rawJson('/v1/user/verification-login', {
        mobile, captcha, deviceId: this.deviceId, platform: 'yhchat web'
      });
      if (!r || r.code !== 1 || !r.data || !r.data.token) throw new Error(r && r.msg ? r.msg : '登录失败');
      return this.loginByToken(r.data.token);
    },

    async loginEmail(email, password) {
      const r = await this.rawJson('/v1/user/email-login', {
        email, password, deviceId: this.deviceId, platform: 'yhchat web'
      });
      if (!r || r.code !== 1 || !r.data || !r.data.token) throw new Error(r && r.msg ? r.msg : '登录失败');
      return this.loginByToken(r.data.token);
    },

    async getCaptcha() {
      // returns { code, msg, data:{ b64s, id } }
      return this.rawJson('/v1/user/captcha', {});
    },

    async getSmsCaptcha(mobile, captchaCode, captchaId) {
      // 注意：服务端字段名为 id（与官方客户端 SmsCaptchaRequest 一致），不是 captchaId
      return this.rawJson('/v1/verification/get-verification-code', {
        mobile, code: captchaCode, id: captchaId
      });
    },

    // ---------- Profile ----------
    async getProfile() {
      // /v1/user/info 仅支持 GET（POST 会 404），无请求体，靠 token 头鉴权
      const r = await this.rawProto('/v1/user/info', null, 'yh_user.info', {}, 'GET');
      return r;
    },

    async editNickname(name) {
      const r = await this.rawProto('/v1/user/edit-nickname', 'yh_user.edit_nickname_send', 'yh_user.edit_nickname', { name });
      if (r.status.code !== 1) throw new Error(r.status.msg || '修改失败');
      return true;
    },

    async editAvatar(url) {
      const r = await this.rawProto('/v1/user/edit-avatar', 'yh_user.edit_avatar_send', 'yh_user.edit_avatar', { url });
      if (r.status.code !== 1) throw new Error(r.status.msg || '修改失败');
      return true;
    },

    // ---------- Conversations ----------
    async listConversations() {
      const r = await this.rawProto('/v1/conversation/list', null, 'yh_conversation.ConversationList', {});
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取会话失败');
      // protobuf.js 解码出的字段是 snake_case，而 ui 全程用 camelCase 访问
      // （conv.chatId / conv.chatType / conv.timestampMs …）。若直接返回 r.data，
      // 所有属性都是 undefined → openChat 时传 chatId=undefined → list-message 找不到会话返回空。
      // int64 字段（timestamp_ms 等）可能以 Long 对象或 number/string 形式返回，统一转成 number。
      const num = v => {
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
        const n = Number(v);
        return isNaN(n) ? 0 : n;
      };
      return (r.data || []).map(d => ({
        chatId: d.chat_id,
        chatType: d.chat_type,
        name: d.name,
        chatContent: d.chat_content,
        timestampMs: num(d.timestamp_ms),
        unreadMessage: d.unread_message,
        at: d.at,
        avatarId: num(d.avatar_id),
        avatarUrl: d.avatar_url,
        doNotDisturb: d.do_not_disturb,
        sendTimestamp: num(d.timestamp),
        atData: d.at_data,
        certificationLevel: d.certification_level,
        _raw: d,
      }));
    },

    async dismissNotification(chatId) {
      return this.rawJson('/v1/conversation/dismiss-notification', { chatId });
    },

    async removeConversation(chatId) {
      return this.rawJson('/v1/conversation/remove', { chatId });
    },

    // ---------- Messages ----------
    async getMessages(chatId, chatType, count = 30, msgId = null) {
      const payload = { chat_id: chatId, chat_type: chatType, msg_count: count };
      if (msgId) payload.msg_id = msgId;
      const r = await this.rawProto('/v1/msg/list-message', 'yh_msg.list_message_send', 'yh_msg.list_message', payload);
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取消息失败');
      return r.msg;
    },

    async sendMessage(opts) {
      // opts: { chatId, chatType, contentType, text, buttons, image, file, fileName,
      //          fileSize, video, audio, audioTime, postId, postTitle, postContent, postType,
      //          expressionId, quoteMsgId, quoteMsgText, mentionedIds }
      const content = {};
      if (opts.text != null) content.text = opts.text;
      if (opts.buttons != null) content.buttons = opts.buttons;
      if (opts.image != null) content.image = opts.image;
      if (opts.file != null) { content.file = opts.file; if (opts.fileName) content.file_name = opts.fileName; }
      if (opts.fileSize != null) content.file_size = opts.fileSize;
      if (opts.video != null) content.video = opts.video;
      if (opts.audio != null) { content.audio = opts.audio; if (opts.audioTime) content.audio_time = opts.audioTime; }
      if (opts.postId != null) {
        content.post_id = opts.postId;
        content.post_title = opts.postTitle || '';
        content.post_content = opts.postContent || '';
        content.post_type = opts.postType || '1';
      }
      if (opts.expressionId != null) content.expression_id = opts.expressionId;
      if (opts.quoteMsgText != null) content.quote_msg_text = opts.quoteMsgText;
      if (opts.quoteImageUrl != null) content.quote_image_url = opts.quoteImageUrl;
      if (opts.quoteImageName != null) content.quote_image_name = opts.quoteImageName;
      if (opts.quoteVideoUrl != null) content.quote_video_url = opts.quoteVideoUrl;
      if (opts.quoteVideoTime != null) content.quote_video_time = opts.quoteVideoTime;
      if (opts.mentionedIds && opts.mentionedIds.length) content.mentioned_id = opts.mentionedIds;

      const payload = {
        msg_id: crypto.randomUUID().toUpperCase(),
        chat_id: opts.chatId,
        chat_type: opts.chatType,
        content: content,
        content_type: opts.contentType || CT.TEXT
      };
      if (opts.quoteMsgId) payload.quote_msg_id = opts.quoteMsgId;
      if (opts.commandId) payload.command_id = opts.commandId;

      const r = await this.rawProto('/v1/msg/send-message', 'yh_msg.send_message_send', 'yh_msg.send_message', payload);
      if (r.status.code !== 1) throw new Error(r.status.msg || '发送失败');
      return true;
    },

    async recallMessage(msgId, chatId, chatType) {
      const r = await this.rawProto('/v1/msg/recall-msg', 'yh_msg.recall_msg_send', 'yh_msg.recall_msg',
        { msg_id: msgId, chat_id: chatId, chat_type: chatType });
      if (r.status.code !== 1) throw new Error(r.status.msg || '撤回失败');
      return true;
    },

    async buttonReport(msgId, chatType, chatId, buttonValue) {
      const r = await this.rawProto('/v1/msg/button-report', 'yh_msg.button_report_send', 'yh_msg.send_message',
        { msg_id: msgId, chat_type: chatType, chat_id: chatId, user_id: this.userId, button_value: buttonValue });
      return r;
    },

    // ---------- Search ----------
    async search(word) {
      const r = await this.rawJson('/v1/search/home-search', { word });
      if (!r || r.code !== 1) throw new Error(r && r.msg ? r.msg : '搜索失败');
      return r.data;
    },

    // ---------- User / Group / Bot ----------
    async getUser(id) {
      const r = await this.rawProto('/v1/user/get-user', 'yh_user.get_user_send', 'yh_user.get_user', { id });
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取用户失败');
      return r.data;
    },

    async getGroupInfo(groupId) {
      // 官方 protobuf 接口路径为 /v1/group/info（/v1/group/group-info 是 JSON 接口，会 404）
      const r = await this.rawProto('/v1/group/info', 'yh_group.info_send', 'yh_group.info', { group_id: groupId });
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取群聊失败');
      return r.data;
    },

    async getBotInfo(botId) {
      const r = await this.rawProto('/v1/bot/bot-info', 'yh_bot.bot_info_send', 'yh_bot.bot_info', { bot_id: botId });
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取机器人失败');
      return r.data;
    },

    async addressBook() {
      // 请求字段为 md5（与 API 文档 AddressBookListRequest.md5 一致），传空字符串表示首次拉取
      const r = await this.rawProto('/v1/friend/address-book-list', 'yh_user.address_book_list_send', 'yh_user.address_book_list', { md5: '' });
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取通讯录失败');
      return r.data;
    },

    async friendRequests() {
      const r = await this.rawProto('/v1/friend/request-list', null, 'yh_friend.request_list', {});
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取好友请求失败');
      return r.requests || [];
    },

    async agreeFriend(requestId, targetId, targetType) {
      return this.rawJson('/v1/friend/agree-apply', { requestId, targetId, targetType });
    },

    async addFriend(id, sourceType = 1) {
      return this.rawJson('/v1/friend/apply', { id, sourceType });
    },

    async joinGroup(groupId) {
      return this.rawJson('/v1/group/invite', { groupId });
    },

    // ---------- Community (JSON) ----------
    // typ: 1-文本 2-markdown（post-list 的 typ）
    async communityPosts(baId, page = 1, size = 20, typ = 1) {
      const r = await this.rawJson('/v1/community/posts/post-list', { typ, baId, page, size });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取文章失败');
      return r.data;
    },

    async postDetail(postId) {
      // 官方接口参数名为 id（不是 postId），否则 HTTP 400
      const r = await this.rawJson('/v1/community/posts/post-detail', { id: postId });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取文章详情失败');
      return r.data;
    },

    async communityBaList(page = 1, size = 20, typ = 2) {
      // typ: 1-关注 2-热门 3-我的 4-全部
      const r = await this.rawJson('/v1/community/ba/following-ba-list', { typ, page, size });
      if (!r || r.code !== 1) throw new Error((r && r.msg) || '获取分区失败');
      return r.data;
    },

    async postListRecommend(page = 1, size = 20) {
      const r = await this.rawJson('/v1/community/posts/post-list-recommend', { page, size });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取推荐文章失败');
      return r.data;
    },

    async myPostList(page = 1, size = 20) {
      const r = await this.rawJson('/v1/community/posts/my-post-list', { page, size });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取我的文章失败');
      return r.data;
    },

    async postLike(id) {
      const r = await this.rawJson('/v1/community/posts/post-like', { id });
      if (!r || r.code !== 1) throw new Error(r.msg || '操作失败');
      return true;
    },

    async postCollect(id) {
      const r = await this.rawJson('/v1/community/posts/post-collect', { id });
      if (!r || r.code !== 1) throw new Error(r.msg || '操作失败');
      return true;
    },

    async commentList(postId, page = 1, size = 20) {
      const r = await this.rawJson('/v1/community/comment/comment-list', { postId, page, size });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取评论失败');
      return r.data;
    },

    async createComment(postId, content, commentId = 0) {
      const r = await this.rawJson('/v1/community/comment/comment', { postId, commentId, content });
      if (!r || r.code !== 1) throw new Error(r.msg || '评论失败');
      return true;
    },

    async createPost(baId, title, content, contentType = 1, groupId = '', draftId = 0) {
      const r = await this.rawJson('/v1/community/posts/create', { baId, groupId, title, content, contentType, draftId });
      if (!r || r.code !== 1) throw new Error(r.msg || '发布失败');
      return r.data;
    },

    async deletePost(postId) {
      const r = await this.rawJson('/v1/community/posts/delete', { postId });
      if (!r || r.code !== 1) throw new Error(r.msg || '删除失败');
      return true;
    },

    async editPost(postId, title, content, contentType = 1) {
      const r = await this.rawJson('/v1/community/posts/edit', { postId, title, content, contentType });
      if (!r || r.code !== 1) throw new Error(r.msg || '编辑失败');
      return true;
    },

    async searchCommunity(keyword, page = 1, size = 20, typ = 3) {
      const r = await this.rawJson('/v1/community/search', { typ, keyword, page, size });
      if (!r || r.code !== 1) throw new Error(r.msg || '搜索失败');
      return r.data;
    },

    async baInfo(id) {
      const r = await this.rawJson('/v1/community/ba/info', { id });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取分区失败');
      return r.data;
    },

    async baGroupList(baId, page = 1, size = 20) {
      const r = await this.rawJson('/v1/community/ba/group-list', { baId, page, size });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取群聊失败');
      return r.data;
    },

    async followBa(baId, followSource = 2) {
      const r = await this.rawJson('/v1/community/ba/user-follow-ba', { baId, followSource });
      if (!r || r.code !== 1) throw new Error(r.msg || '关注失败');
      return true;
    },

    async unfollowBa(baId) {
      const r = await this.rawJson('/v1/community/ba/user-unfollow-ba', { baId });
      if (!r || r.code !== 1) throw new Error(r.msg || '取关失败');
      return true;
    },

    // ---------- Sticky (会话置顶) ----------
    async stickyList() {
      const r = await this.rawJson('/v1/sticky/list', {});
      if (!r || r.code !== 1) throw new Error(r.msg || '获取置顶失败');
      return r.data;
    },

    async stickyAdd(chatId, chatType) {
      const r = await this.rawJson('/v1/sticky/add', { chatId, chatType });
      if (!r || r.code !== 1) throw new Error(r.msg || '置顶失败');
      return true;
    },

    async stickyDelete(chatId, chatType) {
      const r = await this.rawJson('/v1/sticky/delete', { chatId, chatType });
      if (!r || r.code !== 1) throw new Error(r.msg || '取消置顶失败');
      return true;
    },

    // ---------- User profile ----------
    async saveUserData(data) {
      const r = await this.rawJson('/v1/user/save-user-data', data);
      if (!r || r.code !== 1) throw new Error(r.msg || '修改失败');
      return true;
    },

    async bindEmail(email, captcha) {
      const r = await this.rawJson('/v1/user/bing-email', { email, captcha });
      if (!r || r.code !== 1) throw new Error(r.msg || '绑定失败');
      return true;
    },

    async changePassword(email, captcha, password) {
      const r = await this.rawJson('/v1/user/forget-password', { email, captcha, password });
      if (!r || r.code !== 1) throw new Error(r.msg || '修改密码失败');
      return true;
    },

    async logout() {
      return this.rawJson('/v1/user/logout', { 'device-id': this.deviceId });
    }
  };

  window.YHApi = YHApi;
})();
