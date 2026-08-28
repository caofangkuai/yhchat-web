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
        let Req;
        try {
          Req = root.lookupType(reqType);
        } catch (e) {
          console.error('[rawProto] lookupType 失败，reqType=', reqType,
            '。请检查 proto.js 中是否定义了该 message，或浏览器是否缓存了旧 proto.js。建议清缓存/强刷。', e);
          throw new Error('proto 消息类型未注册: ' + reqType + '（浏览器可能缓存了旧版 proto.js，请 Ctrl+Shift+R 强刷）');
        }
        // YHBuildRoot 使用 parse(..., { keepCase: true })，字段名按 proto 文本原样
        // （snake_case：group_id / msg_count）保存，和我们在 api.js 中构造 payload 的命名一致。
        // Req.create 直接按字段名赋值即可，不需要再走 fromObject 做转换。
        const payload_err = Req.verify(payload || {});
        if (payload_err) {
          // verify 失败时不中断：字段可能缺失（proto3 都是可选），直接编码默认值。
          // 但把错误打印到控制台，便于调试"为什么请求体字节数为 0"。
          console.warn('[rawProto] verify warn for ' + reqType + ':', payload_err, payload);
        }
        const msg = Req.create(payload || {});
        try {
          body = Req.encode(msg).finish();
        } catch (e) {
          console.error('[rawProto] encode 失败 for', reqType, 'payload=', payload,
            'fields=', Object.keys(Req.fields), 'error=', e);
          throw new Error(`proto encode 失败(${reqType}): ${e && e.message ? e.message : e}`);
        }
        headers['Content-Type'] = 'application/x-protobuf';
        // debug 用：抓包无请求体时可以定位到"编码零字节"
        if (!body || body.length === 0) {
          // 0 字节的请求体对服务端基本等于"没传任何字段"，99% 情况下是 bug。
          // 直接抛异常避免把错误伪装成 success 让用户抓包空请求体。
          console.error('[rawProto] encode produced ZERO-length body for', reqType,
            'payload=', payload, 'msg=', msg, 'fields=', Object.keys(Req.fields));
          throw new Error('proto encode 产出 0 字节请求体: ' + reqType +
            '（通常是字段名与 proto 不匹配，或所有字段都为默认零值）');
        }
      }
      const resp = await fetch(BASE + path, {
        method,
        headers: this._headers(headers),
        body
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const ab = await resp.arrayBuffer();
      const Res = root.lookupType(resType);
      // keepCase=true 时 decode 的字段名就是 proto 中的 snake_case，和 ui 层访问习惯一致。
      // 同时做 int64 → Number/Long 兼容转换（protobuf.js 会根据精度自动回退）。
      const decoded = Res.decode(new Uint8Array(ab));
      // 为了兼容旧代码可能出现的 camelCase 访问（如 r.chatId、r.totalMsgs），
      // 再把 snake_case 字段同步一份 camelCase 版本，两边都能拿到值。
      const camelCase = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      Object.keys(decoded).forEach(k => {
        if (k === camelCase(k)) return;
        const cc = camelCase(k);
        if (!(cc in decoded)) decoded[cc] = decoded[k];
      });
      return decoded;
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
      // 用户要求 /v1/conversation/list 不带请求体（服务端按 token 头识别用户）。
      // POST 不变，reqType = null 让 rawProto 跳过 body / Content-Type，其余接口不受影响。
      const r = await this.rawProto('/v1/conversation/list',
        null,
        'yh_conversation.ConversationList', null);
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取会话失败');
      // 新版 rawProto 会同时吐出 camelCase + snake_case 两套字段；这里仍然做一次显式映射以
      // 保证无论 proto 层策略如何变化，ui 层拿到的都是 camelCase，不会出现字段名混用导致的
      // "抓包 success 但页面不显示消息"。
      // int64 字段（timestamp_ms 等）可能以 Long 对象或 number/string 形式返回，统一转成 number。
      const num = v => {
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') { const n = Number(v); return isNaN(n) ? 0 : n; }
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

      // ⚠️ 服务端对 msgId 格式强校验：接受 32 位小写十六进制字符串（MD5/UUID 去横杠风格）。
      // 大写/带横杠的 UUID（如 A6DC2FBB-FCF1-…）会返回 code=1100「请求参数错误，msgId字段值非法」。
      // 用 crypto.randomUUID() 生成后统一 replace(/-/g,'').toLowerCase()，
      // 在没有 randomUUID 的环境回退到 getRandomValues 拼 32 hex。
      let mid = '';
      try {
        if (crypto && typeof crypto.randomUUID === 'function') {
          mid = crypto.randomUUID().replace(/-/g, '').toLowerCase();
        }
      } catch (_) { mid = ''; }
      if (!mid) {
        const b = (crypto && typeof crypto.getRandomValues === 'function')
          ? crypto.getRandomValues(new Uint8Array(16))
          : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
        mid = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
      }

      const payload = {
        msg_id: mid,
        chat_id: String(opts.chatId == null ? '' : opts.chatId),
        chat_type: Number(opts.chatType) || 0,
        content: content,
        content_type: Number(opts.contentType) || CT.TEXT
      };
      if (opts.quoteMsgId) payload.quote_msg_id = String(opts.quoteMsgId);
      if (opts.commandId) payload.command_id = Number(opts.commandId) || 0;

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
      // BotInfoRequest：API 文档 field 2 = id（不要传 bot_id，field 编号虽然一样、但按文档对齐）
      const r = await this.rawProto('/v1/bot/bot-info', 'yh_bot.bot_info_send', 'yh_bot.bot_info', { id: botId });
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
      // 传 request_list_send.md5 = 空串，请求体不再为空（之前 reqType=null 抓包无请求体）
      const r = await this.rawProto('/v1/friend/request-list',
        'yh_friend.request_list_send', 'yh_friend.request_list', { md5: '' });
      if (r.status.code !== 1) throw new Error(r.status.msg || '获取好友请求失败');
      return r.requests || [];
    },

    async agreeFriend(requestId, targetId, targetType) {
      return this.rawJson('/v1/friend/agree-apply', { requestId, targetId, targetType });
    },

    async addFriend(id, sourceType = 1) {
      return this.rawJson('/v1/friend/apply', { id, sourceType });
    },

    // 申请加入群聊：仅需要目标群 ID（和 /v1/group/invite 的“邀请进群”是两个入口）
    async joinGroup(groupId) {
      // 用户新给的 /v1/group/invite 文档其实是"邀请"接口，需要邀请对象 chatId。
      // 这里继续沿用 joinGroup 作为用户自己点"加入群聊"的封装。如果服务端
      // join 路径改了再替换；当前把 joinGroup 定义成一个独立的动作。
      return this.rawJson('/v1/group/invite', { groupId });
    },

    // 邀请好友/机器人进群（用户给的正式接口）。
    // 请求体结构（camelCase JSON）：
    //   { chatId: "123", chatType: 1|3, groupId: "456" }
    // 其中 chatType=1 是邀请用户，chatType=3 是邀请机器人，邀请前必须已是好友关系。
    async inviteToGroup({ chatId, chatType = 1, groupId }) {
      if (!chatId) throw new Error('chatId 不能为空（邀请成员 ID）');
      if (!groupId) throw new Error('groupId 不能为空（目标群聊）');
      const ct = Number(chatType);
      if (![1, 3].includes(ct)) throw new Error('chatType 必须是 1（用户）或 3（机器人）');
      const r = await this.rawJson('/v1/group/invite', {
        chatId: String(chatId),
        chatType: ct,
        groupId: String(groupId),
      });
      if (!r || r.code !== 1) throw new Error((r && r.msg) || '邀请失败');
      return r.data || true;
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
