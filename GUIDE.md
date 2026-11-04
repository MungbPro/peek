# Peek

对话中的轻量 AI 助手：听取最近的语音，结合当前屏幕和本地 Obsidian 文章，按一次快捷键给出简短回答。macOS 优先，支持 Apple Silicon 和 Intel 构建。Electron 30 + TypeScript + Vite，界面为原生 TypeScript/CSS，默认中文，可切换英文。[MIT 开源许可](LICENSE)。

[下载 macOS 预览版 / Downloads](https://github.com/MungbPro/peek/releases) · [English](#english-quick-guide)

**屏幕共享时不保证隐藏。** 上台前请用实际投屏、录屏或会议软件检查观众端画面。已知限制见 [HONESTY.md](HONESTY.md)。

## 60 秒开始

1. [下载 Peek](https://github.com/MungbPro/peek/releases)：M 系列 Mac 选 `arm64`，Intel Mac 选 `x64`，解压或安装后打开。
2. 首次启动会打开密钥设置窗口。点击“获取 OpenAI 密钥”进入官方平台，创建自己的 API key，然后粘贴到输入框。
3. 点击“验证并保存”，成功后点击“完成”。也可选择“仅保存”，稍后再验证。保存立即生效，不用重启。

设置窗口可以直接点击，不用按住修饰键。密钥默认隐藏，提交后清空输入框；之后只显示连接状态，不会回显已保存的密钥。随时可从托盘的“API 密钥”菜单更换或删除。**不需要创建或编辑 `.env`。** 安装下载和首次系统授权可能超过一分钟。

“验证并保存”只检查 API 连接与认证，不保证余额、模型调用或语音权限；验证请求不包含截图、录音或文章。仅保存时不会发起验证请求。

Peek 使用你自己的 OpenAI API key 和 API 组织额度。ChatGPT 订阅本身不会配置 Peek；符合条件的 Pro/Business 用户可按官方说明领取并关联 [API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)。密钥可从 [OpenAI API Platform](https://platform.openai.com/api-keys) 创建。

首次使用时允许麦克风和屏幕录制。密钥管理会暂停正在进行的回答和音频。保存后先开启收音，听完问题再按一次 `Option + Space` 获取回答；对话中不用输入文字。未配置 key 时仍可查看本地资料库。

开发者从源码启动需要 Node.js 22.12+ 和 npm，同样可以在窗口中输入 key：

```sh
git clone https://github.com/MungbPro/peek.git
cd peek
npm install
npm run dev
```

## 对话时怎么用

开始前，在“准备”中选择文库和主讲文章，并确认正在收音。对方说完问题后，按 **`Option + Space`**，或按住 `Option` 点击大的回答按钮。Peek 会结合最近语音、截图和相关资料作答。

接着交流，再按同一个快捷键即可追问，不用区分“提问”和“追问”。换一个话题时点击“新话题”，清除此前的问答线程。对话界面没有问题输入框。

| 操作 | macOS 默认按键 |
| --- | --- |
| 根据当前对话回答；再次按下继续追问 | `Option + Space` |
| 隐藏 / 显示 | `Option + H` |
| 临时允许鼠标点击 | 按住 `Option` |
| 清除之前的问答 | 点击“新话题” |

收音不会随启动自动开始；如果尚未收音，第一次按主按钮只开启收音；说完问题后再按一次，才会请求回答。Peek 不会仅因为检测到语音就自动生成回答。按下回答会提交尚未结束的音频片段，最多等 7 秒取得转写；未完成时会提示稍后再按，本次不会请求模型回答。

窗口为 420 × 520，默认在主屏右上角置顶并鼠标穿透。松开 `Option` 后恢复穿透。隐藏窗口不会暂停音频。托盘可管理密钥、打开配置或退出。Windows 对应使用 `Alt`；Windows 实机行为尚未完整验证。

高级用户仍可在配置中保留单独的追问快捷键，默认 `Alt+Enter`；常用界面不需要它。升级时会迁移旧版本完全匹配的默认按键，自定义按键保持不变。

## Obsidian：主文章 + 相关资料

1. 演讲或对话开始前展开“准备”，选择 Obsidian vault 文件夹。直接读取 `.md`、`.markdown`、`.txt`，不复制或修改原文。
2. 在下拉列表选当前主讲文章，不用打字搜索。保留“全部资料库”范围，Peek 会优先选取主文章段落，同时寻找其他文章中的相关证据。
3. 需要缩小范围时选一个章节。章节对应 vault 的第一层文件夹；章节过滤会限制检索范围。准备好后收起面板。
4. 回答后展开来源，查看文件路径、原文行号和摘录；点击来源可打开文章。Obsidian 改完文件后点击重新载入。

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

Windows 使用 Electron 的 `app.getPath('userData')`（通常位于 `%APPDATA%/Peek`）；通过托盘打开文件可避免猜测路径。`config.json` 只放模型、设备和快捷键等设置，密钥通过应用内窗口管理。

### 密钥保存

密钥通过 Electron `safeStorage` 加密后保存在用户目录的 `credentials.enc`。Mac 的加密密钥由系统钥匙串保护，Windows 使用 DPAPI。系统加密不可用时，Peek 会拒绝保存，不会退回明文文件。未签名应用更新后，macOS 可能再次询问钥匙串访问权限；详见 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。

若无法读取已保存密钥，先解锁系统钥匙串并退出、重启 Peek；应用会保留原加密文件，不会自动覆盖。

每条已保存密钥绑定对应的 API 地址与凭据名称。更改 API 地址后，需要为新地址重新设置密钥。聊天与转写使用同一配置时，只需输入一次；使用不同服务时，设置窗口会分别显示目标地址。

在 Peek 中删除密钥后，旧 `.env` 或环境变量中的对应密钥不会自动重新启用。删除只影响 Peek，不会撤销供应商平台上的 key，也不会修改你的 `.env` 文件；需要撤销时请到官方平台操作。

### 可选：环境变量

已有 `.env` 的高级用户仍可继续使用。应用内保存的密钥优先。开发版先读取项目根目录的 `.env`，再读取用户目录中的 `.env`；外部进程环境优先于这两个文件。安装版可读取 `config.json` 同目录的 `.env`。这些文件中的 key 是明文，请自行保护；它们不会打包到安装包。

```json
{
  "language": "zh",
  "model": "gpt-4.1-mini",
  "inputDeviceId": "",
  "transcriptWindowSeconds": 30,
  "hotkeys": {
    "ask": "Alt+Space",
    "toggle": "Alt+H",
    "followUp": "Alt+Enter"
  },
  "interactionModifiers": ["Alt"],
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

OpenAI 不是唯一支持图片的 API。阿里云百炼的 Qwen-VL 提供 OpenAI 兼容多模态接口。更改以下聊天配置并重启后，在“API 密钥”窗口为该聊天地址填写百炼 key：

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

这只切换问答模型，不会让 Qwen-VL 自动提供 Whisper 转写。语音转写有独立配置，需另行验证提供方的接口兼容性。尚未用中国大陆网络或真实百炼 key 做端到端验证。**API 在网络上可访问，不代表模型会搜索互联网；Peek 当前没有网页搜索功能。**

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

输入的 API key 会短暂存在于独立、沙盒化的设置窗口，通过受限 IPC 交给主进程后清空。已保存的密钥不会回传到界面；解密与 API 请求均在主进程完成。截图、语音片段和选中的文章摘录会发送给配置的 API；文章索引、对话和滚动转写仅在内存中，应用不主动把音频写入磁盘。无登录、遥测、数据库、同步或自动更新。请勿提交密钥文件或私人 vault。

验证需覆盖本地逻辑、实际 Electron 启动与隔离、中文/英文界面、模拟问答与追问、音频分块，以及密钥保存、删除和不可用状态。测试使用模拟服务与合成数据；真实 API、实体麦克风、屏幕录制授权和观众端隐藏仍需实测。各版本的具体结果见发布说明。

## English quick guide

Peek is a local desktop overlay for screen context, recent speech, and an Obsidian Markdown library. The UI defaults to Chinese; click `中 / EN` for this session, or set `language` to `en` in the tray-opened config for an English default. It uses OpenAI API keys, not ChatGPT sign-in.

Download the `arm64` build for an M-series Mac or `x64` for Intel. The first-run key window is directly clickable: paste your key, choose **Verify and save**, then **Done**. **Save only** skips the network check. No `.env` editing or restart is required. The tray’s API key item lets you replace or remove it later. Verification checks connection/authentication only, not billing, model calls, or speech permissions.

Saved credentials are encrypted with Electron `safeStorage` in `credentials.enc`. macOS protects the encryption key in Keychain; Windows uses DPAPI. Peek refuses plaintext fallback. Input briefly exists in the isolated setup renderer and is cleared after submission; stored keys are never returned to the renderer. Removing a key also disables its old environment fallback in Peek, but does not revoke it at the provider or edit an existing `.env`.

For source development, use Node.js 22.12+, run `npm install` and `npm run dev`, then use the same key window. Existing `.env` setups remain optional; saved app credentials take precedence. Grant Microphone and Screen Recording permissions when requested. Opening key management pauses active answers and audio. Recording starts only after an explicit audio or answer action, including after a normal launch; the audio button pauses it.

Before the conversation, choose a vault and article from the **Prepare** dropdowns and start listening. After a spoken question, press **Option+Space** for an answer. Press the same shortcut for subsequent follow-ups; **New topic** clears the previous Q&A thread. There is no question textbox. If audio is off, the first press starts listening; press again after the question to request an answer. Speech alone never triggers an answer. Pressing Answer flushes the current clip and waits up to seven seconds for transcription. If it is not ready, Peek asks you to press again later and does not call the model for that press.

Hold **Option** to click the overlay, including its large answer button. **Option+H** toggles visibility; hiding does not pause audio. Windows uses **Alt**, with hardware behavior still unverified. The optional explicit follow-up shortcut remains **Alt+Enter** in config. Upgrades migrate the old exact defaults while preserving customized shortcuts.

Choose the article before presenting and leave the scope on the whole library to include supporting sources. A section filter narrows retrieval. Sources include paths and line numbers. Reload after editing notes. Retrieval is lexical: bilingual aliases help, but cross-language synonyms are not automatically translated.

For other-party playback audio, route output through a BlackHole multi-output device plus headphones, then select BlackHole’s input ID in config. Microphone mixing requires separate routing. Chat can use a compatible Qwen-VL endpoint; transcription is configured independently. No web search is implemented.

Use the build, test, and architecture-specific packaging commands above. Builds are unsigned. Screen-share exclusion is best effort and must be checked on the actual audience output. See [HONESTY.md](HONESTY.md) for limits and verification gaps.
