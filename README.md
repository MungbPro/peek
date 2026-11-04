# Peek

桌面上的轻量 AI 助手：读取当前屏幕、最近的语音和本地 Obsidian 文章，给出简短回答。macOS 优先，支持 Apple Silicon 和 Intel 构建。Electron 30 + TypeScript + Vite，界面为原生 TypeScript/CSS，默认中文，可切换英文。[MIT 开源许可](LICENSE)。

[下载 macOS 预览版 / Downloads](https://github.com/MungbPro/peek/releases) · [English](#english-quick-guide)

**屏幕共享时不保证隐藏。** 上台前请用实际投屏、录屏或会议软件检查观众端画面。已知限制见 [HONESTY.md](HONESTY.md)。

## 60 秒开始

需要 Node.js 22.12+、npm 和一个可用的 OpenAI API key。安装下载、首次系统授权可能超过一分钟。

```sh
git clone https://github.com/MungbPro/peek.git
cd peek
npm install
cp .env.example .env
```

编辑项目根目录的 `.env`，填入自己的 key：

```dotenv
OPENAI_API_KEY=your_api_key_here
```

```sh
npm run dev
```

从 [OpenAI API Platform](https://platform.openai.com/api-keys) 创建 key。Peek 使用 API key 和 API 组织额度，不使用 ChatGPT 登录。ChatGPT 订阅本身不会配置 Peek；符合条件的 Pro/Business 用户可按官方说明领取并关联 [API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)。

首次运行允许麦克风和屏幕录制。配置了转写 key 后，Peek 会启动音频采集；点击音频按钮可暂停。未配置 key 时仍可打开界面、选择和查看本地资料库。

## 操作

窗口为 420 × 520，默认显示在主屏右上角，置顶、透明且鼠标穿透。没有 Dock 图标，通过菜单栏托盘退出或打开配置。

| 操作 | macOS 默认快捷键 |
| --- | --- |
| 新问题：截图 + 最近语音 + 本地相关段落 | `⌘ ⇧ Space` |
| 隐藏 / 显示 | `⌘ ⇧ H` |
| 在当前对话追问 | `⌘ ⇧ Enter` |
| 临时允许鼠标点击 | 按住 `⌘ ⌥` |
| 退出输入焦点 | `Escape` |

输入问题时，按住 `⌘ ⌥` 点击输入框，然后松开修饰键正常打字。松开后恢复鼠标穿透，键盘焦点保留到按 `Escape` 或切换应用。隐藏窗口不会暂停音频。Windows 默认用 `Ctrl` 替代 `⌘`，交互修饰键为 `Ctrl + Alt`。

## Obsidian：主文章 + 相关资料

1. 打开资料库区域，选择 Obsidian vault 文件夹。直接读取 `.md`、`.markdown`、`.txt`，不复制或修改原文。
2. 选择当前主讲文章，保留“全部资料库”范围。Peek 优先选取主文章段落，同时寻找其他文章中的相关证据。
3. 需要缩小范围时选一个章节。章节对应 vault 的第一层文件夹；章节过滤会限制检索范围。
4. 提问后展开来源，查看文件路径、原文行号和摘录；点击来源可在默认应用打开文章。Obsidian 改完文件后点击重新载入。

回答先围绕主文章，再关联资料库证据。模型也可补充一般文学背景，提示词要求把这部分标为“常识 / Background”；它并不等于资料库中的已核实结论。

这是本地词汇检索，不会每次把百万字全文发送给模型。默认每次最多提供 6 个段落、12,000 字符。索引仅在内存中，退出后重建。英文词汇和中文相邻字词均可检索，但不会自动把跨语言同义词对应起来。建议在笔记中加入双语关键词，例如 `叙事视角 / narrative perspective`。

可读取 100 篇长文；当前上限为单文件 10 MB、总计 100 MB、2,000 篇或 60,000 个段落。隐藏文件夹、`.obsidian`、`node_modules` 和符号链接会跳过。PDF、扫描件、图片附件、Obsidian 插件生成的动态内容需要先导出为文本。

## macOS 权限与音频

在 **系统设置 → 隐私与安全性** 中，为正在运行的 `Electron`（开发时）或 `Peek`（打包后）允许：

- **麦克风**：读取所选输入设备。
- **屏幕录制 / 屏幕与系统音频录制**：获取截图；系统名称随 macOS 版本不同。

授权后退出并重启 Peek。开发版和打包版可能需要分别授权。如果修饰键检测不可用，先检查启动提示及系统的输入监控权限。Peek 只读取修饰键状态，不记录全局打字内容。

采集其他人的电脑播放声音，需要把该声音路由到一个输入设备。BlackHole 的常用配置：

1. 安装 [BlackHole](https://github.com/ExistentialAudio/BlackHole)，打开“音频 MIDI 设置”。
2. 新建“多输出设备”，选择耳机/扬声器和 `BlackHole 2ch`；按设备需要统一采样率并启用漂移校正。
3. 把系统或通话软件输出设为这个多输出设备。
4. Peek 获取麦克风权限后，在音频设备详情中找到 BlackHole 的设备 ID，写入配置的 `inputDeviceId`，重启 Peek。

参见 [BlackHole 多输出设备说明](https://github.com/ExistentialAudio/BlackHole/wiki/Getting-Started%3A-Creating-a-Multi-Output-Device)。多输出设备负责分发播放声音，不会自动把你的麦克风混进来。要同时采集双方，另行配置能输出混合声音的设备或混音软件；仅创建聚合设备不等于所有通道已混合到 Peek 读取的通道。现场观众声音也必须进入所选麦克风。

## 配置

托盘菜单打开 `config.json`，编辑后重启。macOS 默认位置：

```text
~/Library/Application Support/Peek/config.json
```

Windows 使用 Electron 的 `app.getPath('userData')`（通常位于 `%APPDATA%/Peek`）；通过托盘打开文件可避免猜测路径。配置中只放设置，key 放 `.env`。

安装版通过 Finder 启动时，把 `.env` 放在 `config.json` 同一目录，填入 key 后重启。例如 macOS 为 `~/Library/Application Support/Peek/.env`。开发版先读取项目根目录的 `.env`，再读取用户目录中的 `.env` 作为补充；已由外部环境设置的变量优先。`.env` 不会打包到安装包。

```json
{
  "language": "zh",
  "model": "gpt-4.1-mini",
  "inputDeviceId": "",
  "transcriptWindowSeconds": 30,
  "hotkeys": {
    "ask": "CommandOrControl+Shift+Space",
    "toggle": "CommandOrControl+Shift+H",
    "followUp": "CommandOrControl+Shift+Enter"
  },
  "interactionModifiers": ["Command", "Alt"],
  "chat": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "tokenLimitParameter": "max_completion_tokens"
  },
  "transcription": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "whisper-1"
  },
  "libraryPath": ""
}
```

顶部 `中 / EN` 可切换本次运行的界面和回答语言；`language` 设为 `zh` 或 `en` 可更改启动默认值。空的 `inputDeviceId` 使用系统默认输入。内存转写缓冲保留最近 60 秒，`transcriptWindowSeconds` 决定每次提问取其中多长时间（5–60 秒）。默认使用 `whisper-1`；OpenAI 已公布其 **2027 年 2 月 26 日停用**，届时需要更换并验证转写模型，见 [官方停用公告](https://developers.openai.com/api/docs/deprecations)。

### 中国大陆可选模型

OpenAI 不是唯一支持图片的 API。阿里云百炼的 Qwen-VL 提供 OpenAI 兼容多模态接口。可在 `.env` 加入 `DASHSCOPE_API_KEY`，并只更改以下聊天配置：

```json
{
  "model": "qwen3-vl-plus",
  "chat": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKeyEnv": "DASHSCOPE_API_KEY",
    "tokenLimitParameter": "max_tokens"
  }
}
```

以上是北京地域的兼容地址示例；不同地域、工作空间的 key 和地址可能不同，请以自己控制台及 [Qwen-VL 官方文档](https://www.alibabacloud.com/help/zh/model-studio/qwen-vl-compatible-with-openai) 为准。官方也推荐工作空间专用地址 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。Qwen3-VL 示例使用 `max_tokens`；OpenAI 默认使用 `max_completion_tokens`，由 `chat.tokenLimitParameter` 选择，参见[百炼参数说明](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)。

这只切换截图问答，不会让 Qwen-VL 自动提供 Whisper 转写。转写有独立配置，需另行验证提供方的接口兼容性；也可暂停音频，只用屏幕、手动问题和资料库。尚未用中国大陆网络或真实百炼 key 做端到端验证。**API 在网络上可访问，不代表模型会搜索互联网；Peek 当前没有网页搜索功能。**

## 开发、检查与打包

```sh
npm run dev                # Vite + Electron 开发模式
npm run build              # 类型检查 + renderer/main/preload 构建
npm start                  # 运行构建结果
npm test                   # 本地逻辑与模拟 API 检查
npm run test:smoke         # Electron 界面冒烟检查
npm run package:mac:arm64  # Apple Silicon
npm run package:mac:x64    # Intel
```

macOS 安装包未签名、未公证；首次打开可能需要在系统设置中允许。分别生成两个架构的构建，不表示已在两种真实机器上完成麦克风、屏幕共享和音频路由测试。原生平台代码集中在 `src/main/platform.ts`。

API key 仅在主进程加载，renderer 通过受限 IPC 请求转写和聊天。截图、语音片段和选中的文章摘录会发送给配置的 API；文章索引、对话和滚动转写仅在内存中，应用不主动把音频写入磁盘。无登录、遥测、数据库、同步或自动更新。请勿提交 `.env` 或私人 vault。

已验证：20 项本地测试、实际 Electron 启动与隔离、中文/英文界面、模拟截图至回答及追问的完整 IPC 流程、Chromium 生成独立 WebM 音频文件。Apple Silicon 安装版与 Rosetta 下的 Intel 安装版均通过启动检查；GitHub CI 的两个原生架构构建及原生模块加载也已通过。真实 API、实体麦克风、屏幕录制授权和观众端隐藏仍需实测。

## English quick guide

Peek is a local desktop overlay for screen context, recent speech, and an Obsidian Markdown library. The UI defaults to Chinese; click `中 / EN` for this session, or set `language` to `en` in the tray-opened config for an English default. It uses OpenAI API keys, not ChatGPT sign-in.

With Node.js 22.12+: run `npm install`, copy `.env.example` to `.env`, set `OPENAI_API_KEY`, and run `npm run dev`. Grant Microphone and Screen Recording permissions to Electron/Peek, then restart. Audio starts when a transcription key is configured; use the audio button to pause.

For an installed app, put `.env` beside the tray-opened `config.json` in the user-data directory, then restart. On macOS this is `~/Library/Application Support/Peek/.env`. Keys are not included in builds.

Hold **Cmd+Option** to click the overlay. Click the intent field, release the modifiers, and type. **Escape** returns focus. **Cmd+Shift+Space** asks a new question, **Cmd+Shift+Enter** follows up, and **Cmd+Shift+H** toggles visibility. Hiding does not pause audio.

Choose your local vault, focus the article being presented, and leave the scope on the whole library to include supporting sources. A section filter narrows retrieval. Sources include paths and line numbers. Reload after editing notes. Retrieval is lexical: bilingual aliases help, but cross-language synonyms are not automatically translated.

For other-party playback audio, route output through a BlackHole multi-output device plus headphones, then select BlackHole’s input ID in config. Microphone mixing requires separate routing. Chat can use a compatible Qwen-VL endpoint; transcription is configured independently. No web search is implemented.

Use the build, test, and architecture-specific packaging commands above. Builds are unsigned. Screen-share exclusion is best effort and must be checked on the actual audience output. See [HONESTY.md](HONESTY.md) for limits and verification gaps.
