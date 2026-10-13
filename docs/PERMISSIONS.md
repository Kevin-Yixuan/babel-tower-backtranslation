# 权限说明

| 权限 | 类型 | 用途 |
| --- | --- | --- |
| `storage` | 必需 | 在本机保存设置、API Key、草稿、收藏与学习记录，不做跨设备同步。 |
| `https://api.openai.com/*` `https://api.deepseek.com/*` `https://open.bigmodel.cn/*` | 主机 | 你选择对应服务商后，发送翻译、生成、检查和讲解请求。 |
| `https://api.dictionaryapi.dev/*` | 主机 | 本地词典没有命中时，把**单个单词**发去查询释义。 |
| `https://api.mymemory.translated.net/*` | 主机 | 你选择在线翻译兜底时，发送待译文本。 |
| `https://api.typesafe.ai/*` | 主机 | 仅在你启用 Jev 折叠或兴趣高亮时，发送附近帖文和你写的规则。默认关闭。 |
| `https://*/*` | 可选 | 填写自定义模型地址时，才申请对应主机的权限。 |
| `http://127.0.0.1/*` `http://localhost/*` | 可选 | 连接本机 Pi 桥接服务（只接受 4097 端口）。 |

内容脚本只注入 `https://x.com/*` 和 `https://twitter.com/*`。

## 扩展不会做的事

- 不收集数据：没有开发者服务器，不含统计、广告或追踪组件。
- 不自动发布或修改你的帖子：插入草稿必须由你确认，扩展从不点击发布。
- 不读取浏览历史，不共享或出售任何数据。

卸载扩展会清除它的本地存储和 IndexedDB；设置页也提供导出和清除。完整说明见 [privacy.md](../privacy.md)。
