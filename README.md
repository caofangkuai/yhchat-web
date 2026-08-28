# 云湖 Web · Yhchat Web

把 [Kauid323/Yhchat_MD3](https://github.com/Kauid323/Yhchat_MD3)（云湖 Android 客户端）转换为的**纯前端 Web 版本**，使用 [mdui](https://www.mdui.org) 实现，**电脑版与手机版自适应**，所有接口逻辑与原项目保持一致。

## 功能

| 模块 | 说明 |
| --- | --- |
| 登录 | 支持 **Token 登录 / 手机号+验证码 / 邮箱+密码** 三种方式 |
| 消息 | 会话列表、实时 WebSocket 推送、草稿多端同步、心跳重连 |
| 消息类型 | 文本、Markdown、HTML、图片、文件、语音、视频、表情、文章、A2UI 按钮、引用、@提醒 |
| 发送 | 文本 / Markdown / HTML / A2UI / 图片·文件·语音·视频链接 / 文章 |
| 搜索 | 用户、群聊、机器人一键搜索并进入会话 |
| 联系人 | 通讯录（用户 / 群聊 / 机器人）、好友请求同意 |
| 详情 | 用户 / 群聊 / 机器人 资料查看，可发消息、加好友、加群 |
| 社区 | 分区列表、文章列表、文章详情（Markdown 解析） |
| 我的 | 个人资料、修改昵称 / 头像、深色模式、退出登录 |

## 技术实现

- **纯前端**：无任何后端，直接用浏览器调用云湖官方接口（`chat-go.jwzhd.com` / WebSocket `chat-ws-go.jwzhd.com`）。
- **协议**：会话列表、消息收发、用户/群/机器人资料等接口使用 **protobuf**（已用 `protobuf.js` 内联编译 `proto/yhchat.proto`）；登录、搜索、社区等使用 JSON。
- **响应式**：≥840px 显示 220px 侧边栏导航 + 会话/聊天双栏 + 社区左右分栏（文章列表 + 详情）；<840px 显示底部导航 + 单栏。
- **依赖本地化**：`mdui`、`protobuf.js`、`marked` 已下载到 `vendor/`，离线 / `file://` 直接打开 `index.html` 即可运行（无需联网加载 CDN）。

## 运行

直接双击 `index.html` 即可，或用一个静态服务器：

```bash
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

也可部署到 GitHub Pages / Vercel / Nginx 等任意静态托管。

## 目录结构

```
index.html          页面骨架（mdui 组件）
css/style.css       样式 + 响应式布局
js/proto.js         内联 protobuf 定义与解析器构建
js/api.js           HTTP / protobuf 接口封装
js/ws.js            WebSocket 实时消息（protobuf 二进制帧、心跳、重连）
js/render.js        消息渲染（各内容类型）
js/ui.js            界面逻辑 / 路由 / 交互
proto/yhchat.proto  云湖接口 protobuf schema（含 WS / 消息 / 会话 / 用户 / 群 / 好友 / 机器人）
vendor/             本地依赖（mdui / protobuf.js / marked）
```

## 说明 / 注意事项

- 调用的是云湖**官方公开接口**，未做任何破解；仅供学习与交流，请在下载后 24 小时内删除。
- 浏览器直接跨域请求 `chat-go.jwzhd.com` 时，若该域名未开启 CORS，部分请求可能被浏览器拦截。若遇到此情况，可将该静态站点部署到已配置 CORS 的环境，或自行添加反向代理（本项目本身不包含后端）。
- **头像/媒体防盗链**：云湖媒体 CDN（`chat-img*.jwznb.com`）校验 `Referer` 必须为 `*.jwzhd.com`（官方 App 用 OkHttp 拦截器加 `Referer: https://myapp.jwznb.com`，浏览器 `<img>` 无法自定义该请求头）。
  - 将本站部署到任意 `*.jwzhd.com` 子域时，浏览器会自动带合规 `Referer`，头像可直接显示；
  - 否则在本地 / GitHub Pages 等非 `jwzhd.com` 域名下访问会出现 `403`，需自行部署一个反向代理（以合规 `Referer` 拉取）并在浏览器控制台执行 `localStorage.setItem('yh_media_proxy','https://your-proxy/?url=')`（末尾按 `encodeURIComponent(url)` 拼接），头像/图片即可经代理正常显示；加载失败会自动降级为首字母占位，不会出现裂图。
- 媒体（图片/文件/语音/视频）发送采用「直链 URL」方式（与原接口 `image/file/audio/video` 字段接受 key/url 一致）；如需上传本地文件，可在此基础上接入七牛上传（项目已预留 `qiniu-token` 接口）。

## License

遵循原项目声明：仅供个人学习测试使用。
