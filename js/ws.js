// Yhchat Web - WebSocket realtime layer (protobuf binary frames)
(function () {
  const WS_URL = 'wss://chat-ws-go.jwzhd.com/ws';
  let root = null;
  let ws = null;
  let shouldReconnect = false;
  let reconnectAttempts = 0;
  let heartbeatTimer = null;
  let userId = null, token = null, deviceId = null;
  let listeners = {};

  function on(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); }
  function emit(evt, data) { (listeners[evt] || []).forEach(cb => { try { cb(data); } catch (e) { console.error(e); } }); }

  function uuid() {
    // crypto.randomUUID 需要 secure context，http://<IP> 下不可用，提供回退实现。
    let u;
    try { if (crypto && typeof crypto.randomUUID === 'function') u = crypto.randomUUID(); } catch (e) {}
    if (!u) {
      const b = crypto && typeof crypto.getRandomValues === 'function'
        ? crypto.getRandomValues(new Uint8Array(16))
        : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
      u = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
    }
    return u.replace(/-/g, '');
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendLogin() {
    send({
      seq: uuid(), cmd: 'login',
      data: { userId, token, platform: 'windows', deviceId }
    });
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      send({ seq: uuid(), cmd: 'heartbeat', data: {} });
    }, 30000);
  }
  function stopHeartbeat() { if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = null; }

  function parseEnvelope(bytes) {
    // 1) read cmd via heartbeat_ack (only has info)
    let info = null, cmd = null, seq = null;
    try {
      const env = root.lookupType('yh_ws_go.heartbeat_ack').decode(bytes);
      info = env.info; cmd = info && info.cmd; seq = info && info.seq;
    } catch (e) { /* not an envelope */ }
    if (!cmd) return null;

    switch (cmd) {
      case 'login_ack':
      case 'heartbeat_ack':
        return { type: cmd };
      case 'push_message': {
        const m = root.lookupType('yh_ws_go.push_message').decode(bytes);
        return { type: 'push', msg: m.data && m.data.msg };
      }
      case 'edit_message': {
        const m = root.lookupType('yh_ws_go.edit_message').decode(bytes);
        return { type: 'edit', msg: m.data && m.data.msg };
      }
      case 'stream_message': {
        const m = root.lookupType('yh_ws_go.stream_message').decode(bytes);
        return { type: 'stream', msg: m.data && m.data.msg };
      }
      case 'draft_input': {
        const m = root.lookupType('yh_ws_go.draft_input').decode(bytes);
        const d = m.data && m.data.draft;
        return { type: 'draft', chatId: d && d.chat_id, input: d && d.input };
      }
      case 'bot_board_message': {
        const m = root.lookupType('yh_ws_go.bot_board_message').decode(bytes);
        const b = m.data && m.data.board;
        return { type: 'board', botId: b && b.bot_id, chatId: b && b.chat_id, content: b && b.content, contentType: b && b.content_type };
      }
      default:
        return { type: cmd };
    }
  }

  function normalize(raw) {
    if (!raw) return null;
    return {
      msg_id: raw.msg_id,
      sender: raw.sender ? {
        chat_id: raw.sender.chat_id, chat_type: raw.sender.chat_type,
        name: raw.sender.name, avatar_url: raw.sender.avatar_url
      } : null,
      recv_id: raw.recv_id,
      chat_id: raw.chat_id,
      chat_type: raw.chat_type,
      content_type: raw.content_type,
      content: raw.content || {},
      send_time: raw.timestamp != null ? raw.timestamp : raw.send_time,
      msg_seq: raw.msg_seq,
      quote_msg_id: raw.quote_msg_id,
      cmd: raw.cmd ? (raw.cmd.name || raw.cmd) : null
    };
  }

  function connect(uid, tk) {
    if (!window.protobuf) return;
    root = window.YHBuildRoot();
    userId = uid; token = tk;
    deviceId = window.YHApi.deviceId;
    shouldReconnect = true;
    reconnectAttempts = 0;
    open();
  }

  function open() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    emit('status', 'connecting');
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      reconnectAttempts = 0;
      sendLogin();
      startHeartbeat();
      emit('status', 'connected');
      emit('open');
    };
    ws.onmessage = (ev) => {
      try {
        const bytes = new Uint8Array(ev.data);
        const env = parseEnvelope(bytes);
        if (!env) return;
        if (env.type === 'push') {
          const msg = normalize(env.msg);
          if (msg) emit('message', msg);
        } else if (env.type === 'edit') {
          const msg = normalize(env.msg);
          if (msg) emit('edit', msg);
        } else if (env.type === 'stream') {
          emit('stream', { msgId: env.msg.msg_id, chatId: env.msg.chat_id, content: env.msg.content });
        } else if (env.type === 'draft') {
          emit('draft', { chatId: env.chatId, input: env.input || '' });
        } else if (env.type === 'board') {
          emit('board', env);
        } else if (env.type === 'login_ack') {
          emit('login_ack');
        }
      } catch (e) { console.warn('ws message parse error', e); }
    };
    ws.onclose = () => {
      stopHeartbeat();
      emit('status', 'disconnected');
      if (shouldReconnect) scheduleReconnect();
    };
    ws.onerror = () => { emit('status', 'error'); };
  }

  function scheduleReconnect() {
    const attempt = ++reconnectAttempts;
    const delay = Math.min(2000 * Math.pow(2, Math.min(attempt - 1, 4)), 30000) + Math.floor(Math.random() * 600);
    setTimeout(() => { if (shouldReconnect) open(); }, delay);
  }

  function disconnect() {
    shouldReconnect = false;
    stopHeartbeat();
    if (ws) { try { ws.close(1000, 'logout'); } catch (e) {} ws = null; }
  }

  function sendDraft(chatId, input) {
    send({ seq: uuid(), cmd: 'inputInfo', data: { chatId, input, deviceId } });
  }

  window.YHWs = { connect, disconnect, sendDraft, on, emit, get connected() { return ws && ws.readyState === WebSocket.OPEN; } };
})();
