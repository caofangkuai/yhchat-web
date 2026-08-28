// Auto-generated: embedded protobuf schema for Yhchat web client.
window.YH_PROTO_TEXT = `syntax = "proto3";

// ============================================================
// WebSocket messages  (package yh_ws_go)
// ============================================================
package yh_ws_go;

message INFO {
    string seq = 1;
    string cmd = 2;
}

message WsTag {
    int64 id = 1;
    string text = 3;
    string color = 4;
}

message WsMsg {
    string msg_id = 1;
    WsSender sender = 2;
    string recv_id = 3;
    string chat_id = 4;
    int32 chat_type = 5;
    WsContent content = 6;
    int32 content_type = 7;
    int64 timestamp = 8;
    WsCmd cmd = 9;
    int64 delete_time = 10;
    string quote_msg_id = 11;
    int64 msg_seq = 12;
    int64 edit_time = 14;

    message WsCmd {
        int64 id = 1;
        string name = 2;
    }
    message WsSender {
        string chat_id = 1;
        int32 chat_type = 2;
        string name = 3;
        string avatar_url = 4;
        repeated string tag_old = 6;
        repeated WsTag tag = 7;
    }
    message WsContent {
        string text = 1;
        string buttons = 2;
        string image_url = 3;
        string file_name = 4;
        string file_url = 5;
        string form = 7;
        string quote_msg_text = 8;
        string sticker_url = 9;
        string post_id = 10;
        string post_title = 11;
        string post_content = 12;
        string post_content_type = 13;
        string expression_id = 15;
        int64 file_size = 18;
        string video_url = 19;
        string audio_url = 21;
        int64 audio_time = 22;
        int64 sticker_item_id = 25;
        int64 sticker_pack_id = 26;
        string call_text = 29;
        string call_status_text = 32;
        int64 width = 33;
        int64 height = 34;
    }
}

message heartbeat_ack {
    INFO info = 1;
}

message push_message {
    INFO info = 1;
    PushData data = 2;
    message PushData {
        string any = 1;
        WsMsg msg = 2;
    }
}

message edit_message {
    INFO info = 1;
    EditData data = 2;
    message EditData {
        string any = 1;
        WsMsg msg = 2;
    }
}

message file_send_message {
    INFO info = 1;
    FileSendData data = 2;
    message FileSendData {
        string any = 1;
        FileSender sender = 2;
        message FileSender {
            string send_user_id = 1;
            string user_id = 2;
            uint64 temp_code = 3;
            string send_type = 4;
            string data = 5;
            string send_deviceId = 6;
        }
    }
}

message draft_input {
    INFO info = 1;
    DraftData data = 2;
    message DraftData {
        string any = 1;
        Draft draft = 2;
        message Draft {
            string chat_id = 1;
            string input = 2;
        }
    }
}

message bot_board_message {
    INFO info = 1;
    BoardData data = 2;
    message BoardData {
        string any = 1;
        BoardContent board = 2;
        message BoardContent {
            string bot_id = 1;
            string chat_id = 2;
            int32 chat_type = 3;
            string content = 4;
            int32 content_type = 5;
            int64 last_update_time = 6;
            string bot_name = 7;
        }
    }
}

message stream_message {
    INFO info = 1;
    Data data = 2;
    message Data {
        string any = 1;
        StreamMsg msg = 2;
        message StreamMsg {
            string msg_id = 1;
            string recv_id = 2;
            string chat_id = 3;
            string content = 4;
        }
    }
}

// ============================================================
// Messages  (package yh_msg)
// ============================================================
package yh_msg;

message Status {
    int64 number = 1;
    int32 code = 2;
    string msg = 3;
}

message Tag {
    int64 id = 1;
    string text = 3;
    string color = 4;
}

message Msg {
    string msg_id = 1;
    Sender sender = 2;
    string direction = 3;
    int32 content_type = 4;
    Content content = 5;
    int64 send_time = 6;
    Cmd cmd = 7;
    int64 msg_delete_time = 8;
    string quote_msg_id = 9;
    int64 msg_seq = 10;
    int64 edit_time = 12;

    message Cmd {
        string name = 2;
        int32 type = 4;
    }
    message Content {
        string text = 1;
        string buttons = 2;
        string image_url = 3;
        string file_name = 4;
        string file_url = 5;
        string form = 7;
        string quote_msg_text = 8;
        string sticker_url = 9;
        string post_id = 10;
        string post_title = 11;
        string post_content = 12;
        string post_content_type = 13;
        string expression_id = 15;
        string quote_image_url = 16;
        string quote_image_name = 17;
        int64 file_size = 18;
        string video_url = 19;
        string audio_url = 21;
        int64 audio_time = 22;
        string quote_video_url = 23;
        int64 quote_video_time = 24;
        int64 sticker_item_id = 25;
        int64 sticker_pack_id = 26;
        string call_text = 29;
        string call_status_text = 32;
        int64 width = 33;
        int64 height = 34;
        string tip = 37;
    }
    message Sender {
        string chat_id = 1;
        int32 chat_type = 2;
        string name = 3;
        string avatar_url = 4;
        repeated string tag_old = 6;
        repeated Tag tag = 7;
    }
}

message list_message_by_seq_send {
    int64 msg_seq = 3;
    int64 chat_type = 4;
    string chat_id = 5;
}

message list_message_by_seq {
    Status status = 1;
    repeated Msg msg = 2;
    int32 total = 3;
}

message list_message_send {
    int64 msg_count = 2;
    string msg_id = 3;
    int64 chat_type = 4;
    string chat_id = 5;
}

message list_message {
    Status status = 1;
    repeated Msg msg = 2;
}

message list_message_by_mid_seq_send {
    int64 msg_seq = 3;
    int64 chat_type = 4;
    string chat_id = 5;
    int64 unknown = 6;
    int64 msg_count = 7;
    string msg_id = 8;
}

message list_message_by_mid_seq {
    Status status = 1;
    repeated Msg msg = 2;
    int32 total = 3;
}

message send_message_send {
    string msg_id = 2;
    string chat_id = 3;
    int64 chat_type = 4;
    Content content = 5;
    message Content {
        string text = 1;
        string buttons = 2;
        string file_name = 4;
        string file = 5;
        repeated string mentioned_id = 6;
        string form = 7;
        string quote_msg_text = 8;
        string image = 9;
        string post_id = 10;
        string post_title = 11;
        string post_content = 12;
        string post_type = 13;
        string expression_id = 15;
        string quote_image_url = 16;
        string quote_image_name = 17;
        int64 file_size = 18;
        string video = 19;
        string audio = 21;
        int64 audio_time = 22;
        string quote_video_url = 23;
        uint64 quote_video_time = 24;
        int64 sticker_item_id = 25;
        int64 sticker_pack_id = 26;
        string room_name = 29;
        string bot_llm_params = 36;
    }
    int64 content_type = 6;
    int64 command_id = 7;
    string quote_msg_id = 8;
    Media media = 9;
    message Media {
        string file_key = 1;
        string file_hash = 2;
        string file_type = 3;
        int64 image_height = 5;
        int64 image_width = 6;
        int64 file_size = 7;
        string file_key2 = 8;
        string file_suffix = 9;
    }
}

message send_message {
    Status status = 1;
}

message button_report_send {
    string msg_id = 2;
    int64 chat_type = 3;
    string chat_id = 4;
    string user_id = 5;
    string button_value = 6;
}

message recall_msg_send {
    string msg_id = 2;
    string chat_id = 3;
    int64 chat_type = 4;
}

message recall_msg {
    Status status = 1;
}

message edit_message_send {
    string msg_id = 2;
    string chat_id = 3;
    int32 chat_type = 4;
    Content content = 5;
    message Content {
        string text = 1;
        string buttons = 2;
        string file_name = 4;
        string file = 5;
        repeated string mentioned_id = 6;
        string form = 7;
        string quote_msg_text = 8;
        string image = 9;
        string post_id = 10;
        string post_title = 11;
        string post_content = 12;
        string post_type = 13;
        string expression_id = 15;
        string quote_image_url = 16;
        string quote_image_name = 17;
        int64 file_size = 18;
        string video = 19;
        string audio = 21;
        int64 audio_time = 22;
        string quote_video_url = 23;
        uint64 quote_video_time = 24;
        int64 sticker_item_id = 25;
        int64 sticker_pack_id = 26;
        string room_name = 29;
    }
    int64 content_type = 6;
    string quote_msg_id = 8;
}

message edit_message_resp {
    Status status = 1;
}

// ============================================================
// Conversations  (package yh_conversation)
// ============================================================
package yh_conversation;

message Status {
    int64 number = 1;
    int32 code = 2;
    string msg = 3;
}

message ConversationList {
    Status status = 1;
    repeated ConversationData data = 2;
    int32 total = 3;
    string request_id = 4;
    message ConversationData {
        string chat_id = 1;
        int32 chat_type = 2;
        string name = 3;
        string chat_content = 4;
        int64 timestamp_ms = 5;
        int32 unread_message = 6;
        int32 at = 7;
        int64 avatar_id = 8;
        string avatar_url = 9;
        int32 do_not_disturb = 11;
        int64 timestamp = 12;
        AtData at_data = 14;
        int32 certification_level = 16;
        message AtData {
            int64 unknown = 1;
            string mentioned_id = 2;
            string mentioned_name = 3;
            string mentioned_in = 4;
            string mentioner_id = 6;
            string mentioner_name = 7;
            int64 msg_seq = 8;
        }
    }
}

// ============================================================
// User  (package yh_user)
// ============================================================
package yh_user;

message Status {
    int64 number = 1;
    int32 code = 2;
    string msg = 3;
}

message info {
    Status status = 1;
    Data data = 2;
    message Data {
        string id = 1;
        string name = 2;
        string avatar_url = 4;
        int64 avatar_id = 5;
        string phone = 6;
        string email = 7;
        double coin = 8;
        int32 is_vip = 9;
        int64 vip_expired_time = 10;
        string invitation_code = 12;
    }
}

message get_user_send {
    string id = 2;
}

message get_user {
    Status status = 1;
    Data data = 2;
    message Data {
        string id = 1;
        string name = 2;
        int64 name_id = 3;
        string avatar_url = 4;
        int64 avatar_id = 5;
        repeated Medal_info medal = 6;
        string register_time = 7;
        int64 ban_time = 10;
        int32 online_day = 11;
        int32 continuous_online_day = 12;
        int32 is_vip = 13;
        int64 vip_expired_time = 14;
        RemarkInfo remark_info = 18;
        ProfileInfo profile_info = 19;
        string ipGeo = 20;
    }
}

message Medal_info {
    int64 id = 1;
    string name = 2;
    int64 sort = 5;
}

message edit_nickname_send {
    string name = 3;
}

message edit_nickname {
    Status status = 1;
}

message edit_avatar_send {
    string url = 2;
}

message edit_avatar {
    Status status = 1;
}

message address_book_list_send {
    string number = 2;
}

message address_book_list {
    Status status = 1;
    repeated Data data = 2;
    message Data {
        string list_name = 1;
        repeated Data_list data = 2;
        message Data_list {
            string chat_id = 1;
            string name = 2;
            string avatar_url = 3;
            int32 permisson_level = 4;
            bool noDisturb = 5;
        }
    }
}

message RemarkInfo {
    string remark_name = 1;
    string phone_number = 2;
    string extra_remark = 3;
}

message ProfileInfo {
    string last_active_time = 1;
    string introduction = 2;
    int32 gender = 3;
    uint64 birthday = 4;
    string city = 5;
    string district = 6;
    string address = 7;
}

// ============================================================
// Group  (package yh_group)
// ============================================================
package yh_group;

message Status {
    int64 request_id = 1;
    int32 code = 2;
    string msg = 3;
}

message info_send {
    string group_id = 2;
}

message info {
    Status status = 1;
    Group_data data = 2;
    repeated Bot_data history_bot = 3;
    message Group_data {
        string group_id = 1;
        string name = 2;
        string avatar_url = 3;
        int64 avatar_id = 4;
        string introduction = 5;
        int64 member = 6;
        string create_by = 7;
        int32 direct_join = 8;
        int32 permisson_level = 9;
        int32 history_msg = 10;
        string category_name = 11;
        int64 category_id = 12;
        int32 private = 13;
        int32 do_not_disturb = 14;
        int64 community_id = 15;
        string community_name = 16;
        int64 unban_timestamp = 18;
        int32 top = 19;
        repeated string admin = 20;
        string limited_msg_type = 22;
        string owner = 23;
        int32 recommandation = 24;
        repeated string tag_old = 26;
        repeated Tag tag = 27;
        string my_group_nickname = 28;
        string group_code = 29;
        uint64 hide_group_members = 30;
        int64 auto_delete_message = 32;
        uint64 deny_members_upload_to_group_disk = 33;
        string ban_reason = 34;
        message Tag {
            int64 id = 1;
            string text = 3;
            string color = 4;
        }
    }
}

message Bot_data {
    string bot_id = 1;
    string name = 2;
    int64 name_id = 3;
    string avatar_url = 4;
    int64 avatar_id = 5;
    string introduction = 6;
    string create_by = 7;
    int64 create_time = 8;
    int64 headcount = 9;
    int32 private = 10;
    int32 is_stop = 11;
    string setting = 12;
}

// ============================================================
// Friend  (package yh_friend)
// ============================================================
package yh_friend;

message Status {
    int64 number = 1;
    int32 code = 2;
    string msg = 3;
}

message request_list {
    Status status = 1;
    message Request {
        string receiverName = 1;
        string receiverAvatar = 2;
        string name = 3;
        string avatar = 4;
        string groupName = 5;
        string groupAvatar = 6;
        string inviterId = 7;
        int32 sourceType = 9;
        int32 targetType = 10;
        string targetId = 11;
        string receiverId = 12;
        int32 result = 13;
        int64 processedAt = 14;
        int64 inviteAt = 16;
        string inviteAtStr = 17;
        int32 requestId = 18;
        string botName = 19;
        string botAvatar = 20;
        string processorName = 22;
        string note = 23;
    }
    repeated Request requests = 2;
    int32 total = 3;
    int32 pending = 4;
}

// ============================================================
// Bot  (package yh_bot)
// ============================================================
package yh_bot;

message Status {
    int64 number = 1;
    int32 code = 2;
    string msg = 3;
}

message bot_info_send {
    string bot_id = 2;
}

message bot_info {
    Status status = 1;
    Data data = 2;
    message Data {
        string bot_id = 1;
        string name = 2;
        int64 name_id = 3;
        string avatar_url = 4;
        int64 avatar_id = 5;
        string introduction = 6;
        string create_by = 7;
        int64 create_time = 8;
        int64 headcount = 9;
        int32 private = 10;
        int32 is_stop = 11;
        string setting = 12;
    }
}

// ============================================================
// Community  (JSON API, schemas documented for reference)
// ============================================================
// POST v1/community/posts/post-list      { baId, page, size }        -> { code, data:{ list:[PostItem] } }
// POST v1/community/posts/post-detail    { postId }                  -> { code, data:{ post, comments } }
// POST v1/community/ba/list (etc) are JSON.
// PostItem fields: postId, title, content, contentType, cover, author{...}, createTime, likeCount, commentCount, collectCount, rewardCount, visitCount
`;

// protobuf.js 不支持单文件多 package，且每个片段需带 syntax 声明。
// 这里按 package 切分，为每段补上 syntax，再合并到同一个 root。
window.YHBuildRoot = function () {
  const protobuf = window.protobuf;
  const full = window.YH_PROTO_TEXT;
  const parts = full.split(/^(?=package )/m);
  const root = new protobuf.Root();
  parts.forEach(part => {
    if (!part.trim()) return;
    const src = /^\s*syntax\s*=/.test(part) ? part : ('syntax = "proto3";\n' + part);
    const r = protobuf.parse(src).root;
    Object.values(r.nested || {}).forEach(ns => root.add(ns));
  });
  return root;
};
