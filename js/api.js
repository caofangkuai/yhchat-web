// Yhchat Web - API layer (HTTP + protobuf)
// Mirrors the Kotlin app's network calls against chat-go.jwzhd.com
(function () {
  const BASE = 'https://chat-go.jwzhd.com';
  let root = null;

  const CT = {
    TEXT: 1, IMAGE: 2, MARKDOWN: 3, FILE: 4, FORM: 5, POST: 6,
    EXPRESSION: 7, HTML: 8, VIDEO: 10, AUDIO: 11, A2UI: 14
  };

  const YHApi = {
    BASE,
    CT,
    token: localStorage.getItem('yh_token') || null,
    userId: localStorage.getItem('yh_uid') || null,
    deviceId: localStorage.getItem('yh_did') || (localStorage.setItem('yh_did', crypto.randomUUID()), localStorage.getItem('yh_did')),

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
      return r.data;
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
      const r = await this.rawProto('/v1/group/group-info', 'yh_group.info_send', 'yh_group.info', { group_id: groupId });
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取群聊失败');
      return r.data;
    },

    async getBotInfo(botId) {
      const r = await this.rawProto('/v1/bot/bot-info', 'yh_bot.bot_info_send', 'yh_bot.bot_info', { bot_id: botId });
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取机器人失败');
      return r.data;
    },

    async addressBook() {
      const r = await this.rawProto('/v1/friend/address-book-list', 'yh_user.address_book_list_send', 'yh_user.address_book_list', { number: '0' });
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
    async communityPosts(baId, page = 1, size = 20) {
      const r = await this.rawJson('/v1/community/posts/post-list', { baId, page, size });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取文章失败');
      return r.data;
    },

    async postDetail(postId) {
      const r = await this.rawJson('/v1/community/posts/post-detail', { postId });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取文章详情失败');
      return r.data;
    },

    async communityBaList(page = 1, size = 20, keyword = '') {
      const r = await this.rawJson('/v1/community/ba/list', { page, size, keyword });
      if (!r || r.code !== 1) throw new Error(r.msg || '获取分区失败');
      return r.data;
    }
  };

  window.YHApi = YHApi;
})();
