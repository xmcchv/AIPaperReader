# PaperLens · 翻译 + 精读 + 知识图谱

同一个本地网页承载三个视图：**对照翻译**（PDF 分块 + 逐段中英）、**AI 精读**（原文 / 精读 / 交互图解）、**知识图谱**（概念与前置关系）。顶栏一键切换，论文只入库一次，三个视图读的是同一条记录。**可配置任意 OpenAI 兼容模型 API**（Kimi / DeepSeek / OpenAI / 智谱 / Ollama / 自建端点），翻译引擎另有十几家可选，免费引擎零配置。

![布局](https://img.shields.io/badge/layout-翻译%20%7C%20精读%20%7C%20图谱-4da3ff) ![deps](https://img.shields.io/badge/dependencies-0-3ddc97) ![node](https://img.shields.io/badge/node-%3E%3D22.5-339933) ![storage](https://img.shields.io/badge/storage-SQLite%20(WAL)-4da3ff)

## 快速开始

```bash
node server/index.mjs
# 打开 http://127.0.0.1:5173
```

（`server/index.js` 是等价别名。端口被占用时换一个：PowerShell 写 `$env:PORT=5175; node server/index.mjs`，bash 写 `PORT=5175 node server/index.mjs`。）

需要 **Node ≥ 22.5**（论文库与知识图谱使用 Node 内置的 `node:sqlite`，仍然零依赖）。没有安装步骤，也没有 `npm install`：服务端只用 Node 内置模块，前端是原生 HTML/CSS/ESM；pdf.js 与 KaTeX 已内置在 `public/vendor/`，离线也能解析 PDF 与渲染公式（本地文件缺失时才回退 CDN）。

## 三个视图，一份论文库

顶栏最左边是历史论文侧栏的开关，紧跟着 `翻译 | 精读 | 知识图谱` 三个按钮。地址始终是同一个 `/`，用 `?view=translate|paper|kg` 记录，刷新后停在原视图；`?paper=<id>` 之类的深链会直接落到对应视图。左侧侧栏在翻译与精读之间共用（图谱页有自己的概念栏），点一条就在当前视图打开同一篇。

| 视图 | 看什么 | 适合 |
| --- | --- | --- |
| 翻译 | 左 PDF 分块，右逐段英文 + 中文 | 快速过全文，或对照某一段 |
| 精读 | 原文（PDF / 文本）· AI 精读 · 交互图解 | 吃透方法与创新点 |
| 知识图谱 | 概念、前置关系、原文出处 | 把多篇论文织成一张网 |

三个视图共享同一条论文记录，所以：

- 翻译页打开 PDF 会**立刻入库**（按文件指纹去重，同一份 PDF 不会出现两条），侧栏马上能看到
- **分块只算一次**：翻译页抽出的块存进论文库，精读页的 PDF 热区直接用同一份，于是「翻译卡片里那段」和「精读里点开的那块」是同一个矩形
- **译文也只存一份**：精读页点段落时，卡片里直接给出中文对照

第一次启动时**未配置 API Key，会进入 demo 模式**——点「示例论文」→「开始精读」就能看到完整交互；图谱侧点「看看示例图谱」也能直接体验。翻译视图用「免费自动」引擎时不需要任何 Key，开箱就能翻。

接着点右上角「模型设置」，填三项：

| 字段 | 说明 | 例子 |
| --- | --- | --- |
| Base URL | OpenAI 兼容端点，一般以 `/v1` 结尾 | `https://api.deepseek.com/v1` |
| API Key | 只写不读回，存本机 `~/.paperlens/config.json`（可用 `PAPERLENS_CONFIG` 指定） | `sk-...` |
| 模型名 | 该端点支持的模型（有候选下拉） | `deepseek-v4-flash` |

点「测试连接」会真发一个 `ping` 请求验证三件套，成功后再「保存」。之后「开始精读」就是真实模型在跑。

内置预设：**DeepSeek（默认）** / Kimi / OpenAI / 智谱 GLM / Ollama 本地 / 自定义。点预设会同时回填地址、模型名、`max_tokens`、`temperature`，不会只换一半。

### DeepSeek / 思考型模型的两个坑

1. **输出长度交给模型。** 默认请求里**不带 `max_tokens`**，由服务商按模型能力决定上限——你不需要猜一个数字。设置页的「输出上限」留空即可；只有确实要压成本时才填一个值（填了就会严格截断，界面会在被截断时提示）。历史配置里的 4096 / 8192 会在首次读取时自动清空并写回。
2. **会先想 10 秒左右再动笔。** 模型的思维链走 `reasoning_content` 字段，这里单独接出来，**不混进精读正文**，只在状态栏显示「推理中… N 字」。所以前十几秒空白是正常的，不是卡死。

想让它更快（牺牲一点推理质量）可以在设置页展开「高级：额外请求参数」填：

```json
{"thinking": {"type": "disabled"}}
```

这段会原样合并进请求体，留空表示不发送。写错 JSON 会保存失败并给出原因。

模型名说明：`deepseek-v4-flash` 是 DeepSeek Flash 线路的兼容名，官方新名 `deepseek-flash` 指向同一模型，两个都能直接用（下拉里都有）。

也可以用环境变量（适合不落盘 Key）：

```bash
# bash
PAPERLENS_API_KEY=sk-xxx node server/index.mjs
```

```powershell
# PowerShell
$env:PAPERLENS_API_KEY='sk-xxx'; node server/index.mjs
```

可选：`PAPERLENS_BASE_URL`、`PAPERLENS_MODEL`、`PAPERLENS_PROVIDER`、`PAPERLENS_MAX_TOKENS`、`PAPERLENS_TEMPERATURE`。没设时用 DeepSeek 预设的地址与模型。配置文件默认在 `~/.paperlens/config.json`，可用 `PAPERLENS_CONFIG` 指定文件、`PAPERLENS_DATA_DIR` 指定目录；旧版本的 `data/config.json` 会在首次启动时自动迁移过去。

### API Key 存在哪里、如何加密

- **默认位置**：`~/.paperlens/config.json`（Windows：`C:\Users\<用户名>\.paperlens\config.json`），第一次保存配置时自动创建。
- **加密存储**：首次保存 API Key 时需要设置主密码（至少 6 位）。配置文件里只保存 `api_key_enc`（scrypt 派生密钥 + AES-256-GCM 密文），**不保存明文 Key**；主密码本身也不会落盘。
- **重启后解密**：服务重启后内存里没有明文。点顶栏的「🔒 已加密（待解锁）」徽标会弹出解密框，或在「模型设置」主密码旁点「解密」；也可以启动时设置 `PAPERLENS_PASSPHRASE=...`（不落盘，适合自动化）。
- **忘记主密码**：只能「清除已保存的 Key」后重新设置，密文无法恢复。
- 旧版本仓库内的 `data/config.json` 会在启动时自动迁移到新位置；如果里面还是明文 Key，打开设置、填写主密码后点「保存」即可转成密文。
- **想换位置**：`PAPERLENS_CONFIG=/path/to/config.json` 指定配置文件；`PAPERLENS_DATA_DIR=/path/to/dir` 指定目录。
- **不想落盘**：用 `PAPERLENS_API_KEY=sk-xxx`（配合 `PAPERLENS_BASE_URL` / `PAPERLENS_MODEL`）从环境变量注入。
- 「模型设置」底部会显示当前实际读取的路径；仓库只保留不含 Key 的 `data/config.example.json`，`.gitignore` 已忽略真实配置文件。
- **翻译引擎的 Key 也走同一套加密**：`config.json` 的 `translate.providers.<服务商>.api_key_enc`，与精读用的是**同一个主密码**，一次解锁两边都能用。免费引擎（微软 / 腾讯 / 火山 / Yandex / 谷歌）不需要 Key。
- 旧版本把翻译 Key 明文存在数据库里：打开翻译页「设置」→ 选服务商 → 填主密码 → 保存即可自动加密迁移；也可以一次性批量迁：`npm run encrypt:translate-keys -- --passphrase 你的主密码`（加 `--dry` 只列出待迁移项）。

#### 加密的边界（能防什么、防不住什么）

本地加密使用 `scrypt(N=16384, r=8, p=1)` 派生密钥 + `AES-256-GCM`，每次加密使用随机 salt 和 IV，主密码不落盘。

**能防住**

- 配置文件被复制、备份、云同步、扫盘，或误提交到 Git：对方只能拿到密文。
- 不知道主密码时无法解密；密码错误或密文被篡改会认证失败，不会返回半截明文。

**防不住（任何本地加密都一样）**

- 服务运行后，调用模型必须把 Key 解密到内存；能读进程内存或调试的同用户程序可以拿到明文。
- 同用户权限的恶意软件可以记录主密码、读取 `PAPERLENS_PASSPHRASE` 环境变量，或直接替换服务端代码。
- 主密码从浏览器提交到本机 `127.0.0.1` 走的是明文 HTTP；本机抓包工具或浏览器扩展能看到。
- 已知的本地密文不会自动变安全：如果 Key 曾经泄露（例如提交到 Git 历史），**轮换 Key 才是唯一可靠的补救**。

**使用建议**

- 主密码建议至少 12 位，用一句只有你知道的长短语，不要复用其他网站的密码。
- 不要在脚本或环境变量文件里长期保存 `PAPERLENS_PASSPHRASE`，它只适合受控的自动化场景。
- 限制配置文件权限（Windows 仅当前用户可读；Linux/macOS `chmod 600`）。

## 它做了什么

**载入论文**（三种方式，入口都在原文栏右上角的小按钮里）
- 「＋PDF」：直接上传本地 PDF
- 「arXiv」：按编号或链接抓取，抓标题、摘要，并尽量抓 arXiv HTML 全文（去掉了许可声明、参考文献等噪音）
- 「粘贴」：直接贴正文
- 也支持拖拽 `.txt` / `.md` / `.pdf` 到「打开论文」对话框；PDF 在浏览器本地用 pdf.js 解析，文件不上传服务器，也不会和精读结果抢版面

**原文双视图**
- **PDF 原版**（上传 PDF 后默认）：pdf.js 渲染真实页面，原版排版、图、公式都在；上面叠加解析出的**章节/段落热区**——鼠标划过整段高亮，章节标题带紫色底并浮出标题名，图注单独标色；点击任意段落弹出该段原文（可复制、可「针对这段问 AI」），顶部可缩放/适应宽度
- **文本**：把段落摊平成可读长文，适合连续阅读与复制

PDF 与文本这两种原文形态由原文栏右上角的 `[PDF | 文本]` 切换。PDF 原始字节存在本机论文库（浏览器 IndexedDB 只当离线缓存），**刷新、换浏览器后仍能回到原版视图**。

这些段落框就是**翻译页的分块**：抽取用的是同一份 `public/blocks.js`，结果存在论文记录的 `blocks_json` 里（翻译页打开过就用它的，没打开过则精读页自己算一次并落库）。所以不是两套各算各的，两个视图的框必然重合。抽取本身也不是按行切的，更不会横跨整页：

1. 先按**基线**把文本项聚成行（同一行的上下标、公式才归得进一行）
2. 行内按 x 间隙切「片段」——**双栏论文的左右两栏就在这里分开**
3. 判断是否双栏：看多少行在中线两侧都有文本、且两侧之间是否有稳定空隙（不依赖整页空白投影，跨栏大图挡不住）
4. 每栏内按**行距 + 首行缩进 + 上一行是否排满**三重信号断段，标题和图注强制独立成段
5. 旋转文字（页边 arXiv 印章、竖排图注）先过滤掉，不参与段落聚合
6. 被栏边界/页边界截断的同一段会接回来（一段话从上一栏底部接到下一栏顶部时不会被切成两段），这时一个段落会对应两个热区
7. 图/表/公式区域：连续短行（图内标签、表格行、公式碎片）合并成一个块，按特征标成图内文字 / 表格 / 公式；页眉页脚、脚注、参考文献和首页作者信息单独归类

文本视图与 AI 精读只保留正文、章节标题、图注、公式和表格块；图内文字、脚注、参考文献、页眉页脚不会混进正文。PDF 视图里这些块用不同淡色标出。

在三篇真实论文上验证过（单栏 Attention / 双栏 ResNet / 双栏 BERT）：

| 论文 | 栏检测 | 段落框宽度 / 页宽 | 误判标题 |
|---|---|---|---|
| Attention（单栏） | 15 页全为单栏 | p50 65% | 0 |
| ResNet（双栏） | 12/12 页 | p50 39%、p90 39%（= 栏宽） | 0 |
| BERT（双栏） | 16/16 页 | p50 37%、p90 37%（= 栏宽） | 0 |

**对照翻译**（翻译视图）
- 左栏 PDF、右栏逐段卡片：上方英文原文、下方中文；点左侧色块在右栏定位，滚动 PDF 时右栏自动跟随
- 分块与精读页共用同一套算法、同一份结果（`public/blocks.js`）：双栏、图表标注、跨栏续段、页眉页脚在抽取阶段就处理掉
- 分块可以手动改：按段 / 按行 / 框选区域 / 依次点击指定阅读顺序，改动只影响这一篇，随时撤销
- 翻译引擎十几家可选：免费自动（微软 → 腾讯 → 火山 → Yandex → 谷歌 依次回退）、微软 / 谷歌 / Yandex / 腾讯 / 火山、DeepL 官方、百度、DeepLX 自建，以及 DeepSeek / Gemini / Claude / Kimi / 硅基流动 / Ollama / 任意 OpenAI 兼容端点
- 译文按**原文文本**缓存并跨论文复用：改分段、换顺序都不会让旧译文失效
- 可导出 Markdown，或导出工程文件（`.papertrans.json`，不含 PDF 与 Key），换机器导入即可接着译

**AI 精读**（流式）
固定 7 个小节，边生成边渲染成卡片：一句话结论 / 要解决的问题 / 核心方法 / 关键创新 / 实验与结论 / 局限与可延伸 / 精读要点。生成中可随时点「停止」。渲染是增量式的：每个小节一张卡片，流式时只重画内容变化的那一张，不会整块闪动。公式用 KaTeX 渲染（`$...$` 行内、`$$...$$` 独立，本地库加载，加载失败时保留 LaTeX 原文）；模型写出的缺参数上下标（如 `Q^=`）会自动补空组，多行公式逐段渲染，个别坏公式只保留局部原文，不会拖垮整块。思考型模型（DeepSeek 等）的思维链走 `reasoning_content`，单独接出来只在状态栏显示进度，不会混进正文。

**结构化抽取**（第二次调用）
精读结束后自动再请求一次，让模型输出严格 JSON：`tags` / `concepts` / `claims` / `diagram`。服务端会做容错归一化（丢悬空边、补默认 kind、限制节点数），坏 JSON 会自动重试一次。

**导出报告**（PDF / HTML）
精读面板右上角「导出报告」把整份精读整理成 A4 报告：

- 结构：封面（标题/来源/模型/标签/一句话结论）→ 执行摘要 → 精读正文（7 节）→ 核心概念与关键论断 → 方法链路图（浅色矢量 SVG）→ 追问要点 + 完整问答 → 可选原文节选
- 可勾选包含内容，追问可选「全部 / 最近 5 条 / 不含」
- 「打印 / 保存为 PDF」：在隐藏 iframe 里渲染报告后调起浏览器打印（不依赖弹窗权限），打印对话框里选「另存为 PDF」即可
- 「下载 HTML」：下载同款报告，CSS 已内联；公式字体使用本地 KaTeX，离线也能正常显示
- 导出前调用一次 `/api/export/summary` 生成「执行摘要 + 追问要点」；demo 模式或调用失败会退回**本地归纳**（每节首句 + 每条回答首句），不会挡住导出

**交互图解**（自研 SVG 渲染器，无 Mermaid 依赖）
- 按有向边做最长路径分层，自动生成「输入 → 处理 → 输出」链路
- 横向/纵向布局按容器宽高比自动切换（右侧窄栏用纵向，放大后切回横向）
- 滚轮缩放、拖背景平移、拖节点重排、点节点看 detail 并高亮上下游、一键重排/适应窗口/导出 SVG

**追问**
在原文里选中任意片段 → 浮出「问 AI」→ 带着该片段和已有精读笔记追问，流式回答。点「核心概念」卡片会在原文里定位并高亮该术语：优先用模型给出的英文原文检索词（`terms`，如 `state space layer` / `SSM`），找不到才退回中文名；空格与连字符视为可选分隔，`state space` 与 `state-space` 都能命中。

## 目录结构

```
server/
  index.mjs          唯一入口：路由、SSE、静态文件（单端口 5173）
  shared/
    config.mjs       统一模型配置（文本 + 视觉），API Key 加密存储
    secret.mjs       scrypt + AES-256-GCM
    llm.mjs          OpenAI 兼容客户端：流式 SSE、JSON 抽取、视觉输入
    http.mjs         JSON / SSE / 静态文件工具
  paper/
    routes.mjs       论文库 API（/api/paper/*，含 open / blocks / translate）
    library.mjs      papers.db：正文 / PDF / 分块 / 译文 / 精读 / 结构化 / 追问
    db.mjs           单库连接与建表（papers / tr_cache / seg_cache / prefs）
    store-adapter.mjs 翻译页的旧接口 /api/store/* → 论文库
  translate/
    routes.mjs       /api/translate/*（批量翻译 / 测试连接 / AI 分段 / 服务目录 / 凭据保存）
    translate.mjs    十几家翻译服务的协议适配、缓存、回退链
    segment.mjs      AI 分段（只返回行号区间，原文由前端拼）
    providers.mjs    翻译服务目录（前后端共用同一份定义）
    cache.mjs        译文 / 分段缓存（落在 papers.db）
  kg/
    routes.mjs       /api/kg/* 路由、导入编排、PaperLens 适配
    store.mjs        多图谱 SQLite 存储、检索、快照
    extract.mjs      概念 / 前置关系 / 原文出处抽取
    web.mjs          网页与 arXiv 正文抓取
    demo.mjs         内置示例图谱
public/
  index.html         单页外壳：翻译 / 精读 / 图谱三个视图 + 共享侧栏
  app.js             精读状态机、论文库持久化、一键推送
  shell.js           三视图切换（?view=translate|paper|kg）+ 侧栏开合
  shell.css          外壳布局：侧栏从顶栏下方展开、内容让位
  sidebar.css        历史论文侧栏样式（由 scope-css 生成）
  theme.css          统一配色（暖白 / 中性深）
  blocks.js          PDF 分块抽取（翻译页与精读页共用）+ 整篇提取
  text.js            原文分段、精读 markdown 解析（纯函数）
  pdfview.js         PDF 原版渲染 + 段落热区 + 点段落看中文对照
  diagram.js         交互式 SVG 图解渲染器
  math.js            KaTeX 公式渲染（本地优先，CDN 回退）
  report.js          导出报告：HTML 模板、iframe 打印
  translate/
    app.js                         翻译页状态机、分块编辑、翻译调度
    styles.raw.css                 翻译页原始样式（作用域化的输入）
    styles.css                     作用域化到 #view-translate 的样式（生成物）
  kg/
    app.js graph.js starfield.js   知识图谱前端
    styles.css                     图谱原始样式
    styles.scoped.css              作用域化后的样式（单页外壳使用）
  vendor/
    katex/                         本地 KaTeX（katex.mjs / CSS / 字体）
    pdfjs/                         本地 pdf.js（pdf.min.mjs / worker / cmaps / 标准字体）
scripts/
  check.mjs                        跨平台语法检查（node --check）
  smoke.mjs                        临时数据目录启动 + 关键接口冒烟
  scope-css.mjs                    把翻译页样式作用域化（npm run css:scope）
  migrate-papertrans.mjs           旧 .cache/papertrans.sqlite → papers.db
  encrypt-translate-keys.mjs       把旧明文翻译 Key 加密进 config.json
  test-translate-config.mjs        凭据加密的回归测试
  browser-check.mjs / shot.mjs     无头 Chrome 冒烟与截图（开发用）
.github/workflows/ci.yml           Ubuntu / macOS / Windows 矩阵
tools/restore-from-reports.mjs     从精读报告还原图谱
docs/开发纪要.md                   图谱设计决策与运维记录
docs/合并设计方案.md               合并架构与分阶段方案
data/config.example.json           配置模板（实际配置在 ~/.paperlens/config.json）
~/.paperlens/data/                 图谱库、论文库、PDF、每日快照（不进仓库）
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 当前配置（key 打码）+ 预设（含各服务商模型候选） |
| POST | `/api/config` | 保存配置：`base_url` / `model` / `api_key` / `max_tokens` / `temperature` / `extra_body` / `vision_*`；`{"clear_key":true}` 清除 Key |
| POST | `/api/config/test` | 连通性测试，返回延迟与模型回复 |
| POST | `/api/config/unlock` | 用主密码解锁文本与视觉模型 Key |
| POST | `/api/analyze` | 精读，SSE 流（`meta` / `thinking` / `delta` / `notice` / `done` / `error`） |
| POST | `/api/structure` | 结构化 JSON（含图解数据），失败自动重试一次 |
| POST | `/api/ask` | 追问，SSE 流 |
| POST | `/api/export/summary` | 导出报告前的执行摘要 + 追问要点；demo/失败时返回本地归纳 |
| POST | `/api/paper/fetch` | 按 arXiv 编号/链接抓取论文 |
| GET | `/api/sample` | 内置示例论文 |
| GET | `/api/paper/library` | 论文库列表（标题 / 页数 / 字数 / 分块数 / 译文数 / 是否有精读 / 是否有 PDF） |
| GET | `/api/paper/stats` | 论文库用量（篇数 / PDF 数 / 译文缓存条数） |
| POST | `/api/paper/open` | 打开 PDF：原始字节 + `?hash=&name=`，按指纹去重，命中返回 `{reused:true}` |
| POST | `/api/paper/blocks` | 写入分块（`{id, hash, blocks, overrides}`），精读页消费同一份 |
| POST | `/api/paper/translate` | 增量写译文（`[{text, zh}]`，按原文文本为 key） |
| POST | `/api/paper/save` | 新建或更新论文（正文 / 精读 / 结构化 / 追问） |
| GET | `/api/paper/get?id=` | 读取一篇论文的完整记录 |
| POST | `/api/paper/delete` | 从论文库删除 |
| POST/GET | `/api/paper/pdf` | 保存 / 读取论文 PDF 原件 |
| GET | `/api/translate/providers` | 翻译服务目录（不含任何密钥） |
| GET | `/api/translate/config` | 当前翻译引擎与各服务商是否已存 Key（只回 `has_key`） |
| POST | `/api/translate/config` | 保存翻译引擎配置；Key 用主密码加密后写入 `config.json` |
| POST | `/api/translate/batch` | 批量翻译（单次 ≤40 段），返回 `{translations, stats}` |
| POST | `/api/translate/test` | 测试翻译引擎连通性，回样本译文与耗时 |
| POST | `/api/translate/segment` | AI 分段：只返回行号区间，原文由前端拼装 |
| GET | `/api/kg/state` | 图谱整库 + 模型配置 + 存储信息（打开页面时一次请求） |
| GET | `/api/kg/graphs` | 图谱（工作区）列表 |
| POST | `/api/kg/graphs/{create,rename,delete,activate}` | 新建 / 改名 / 删除 / 切换图谱 |
| POST | `/api/kg/import` | 导入文本 / 网页 / 图片 / 论文 |
| POST | `/api/kg/import/paper` | 精读页一键推送：`{paper, paperId, reading, structure}` |
| POST | `/api/kg/sources/{text,delete,reextract}` | 读资料全文 / 删资料 / 重新抽取 |
| POST | `/api/kg/concepts`、`/api/kg/concepts/enrich`、`/api/kg/concepts/delete` | 手工建点 / AI 补全 / 删除 |
| POST | `/api/kg/edges`、`/api/kg/edges/delete` | 手工加 / 删关系 |
| GET | `/api/kg/search?q=` | 概念与资料正文检索 |
| GET | `/api/health` | 存活探测（同一进程同时报告精读与图谱） |
| 兼容 | `/api/store/*` | 翻译页旧接口，内部全部映射到论文库（`project id === paperId`） |

`/api/analyze` 的 SSE 帧格式：

```
data: {"type":"delta","text":"## 一句话结论\n"}
data: {"type":"done","mode":"live"}
```

## 说明与边界

- 服务只监听 `127.0.0.1`。模型配置在 `~/.paperlens/config.json`（API Key 与翻译 Key 都加密，不含明文）；论文库、图谱、PDF、每日快照都在 `~/.paperlens/data/`，可用 `PAPERLENS_DATA_DIR` 换位置。部署场景建议用 `PAPERLENS_API_KEY` 环境变量，不要落盘。
- **数据层是一个 SQLite**：`~/.paperlens/data/papers.db` 里放着 `papers`（正文 / PDF 路径 / 分块 / 译文 / 精读 / 结构化 / 追问）、`tr_cache`（译文缓存）、`seg_cache`（AI 分段缓存）、`prefs`（界面偏好）。PDF 原件落在 `data/papers/<id>.pdf`。备份时把整个 `~/.paperlens/data/` 拷走即可。
- 知识图谱仍然**一图一库**（`data/graphs/<id>.db`）：单图可独立导出/分享，单图损坏也不会拖累其它图。
- 需要 **Node ≥ 22.5**（`node:sqlite` 的版本门槛）。Node 22.5–23.3 要加 `--experimental-sqlite`。
- 仓库不跟踪任何含 Key 或本地数据的文件：`.gitignore` 已忽略 `data/config.json`、`data/graphs/`、`data/backups/`、`data/papers/`、`data/*.db`、`.env*`。如果不小心提交过 Key：仅删除文件不够，请立即轮换 Key 并清理 Git 历史（`git filter-repo`）。
- 精读正文会按长度截断（默认保留头 70% + 尾 30%，约 26000 字符），超长论文建议分章精读。
- pdf.js 与 KaTeX 已内置在 `public/vendor/`，离线可解析 PDF、渲染公式；只有本地文件缺失时才回退 CDN。解析后的 PDF 会存入本机论文库，换浏览器也能回到原版视图。
- 翻译页的免费引擎走的是各家网页接口，它们随时可能改协议或限流：失败会自动换下一家，全失败时给出明确报错，不会静默产出空译文。正式批量翻译建议配一个大模型或 DeepL。
- arXiv 全文依赖 `arxiv.org/html/<id>` 是否存在，老论文可能只有摘要，此时会提示直接粘贴正文。
- 图解质量取决于模型是否按约定结构输出；结构不合规时会被归一化兜底，缺失部分在图上表现为节点无 detail。
- 图谱侧：纯前端渲染 / 需要登录的网页抓不到正文；图片必须配视觉模型才能抽概念；概念按名称 + 别名归一化合并；一个图谱适合几百个节点，上千节点时 SVG 渲染会变慢。
- 旧的图谱地址 `/kg/` 会 302 到 `/?view=kg`；`/kg/app.js` 等资源仍保留。

## 桌面启动器（不想用命令行时）

首次安装 Electron（仅开发 / 打包需要）：

```bash
npm install
npm run desktop
```

双击启动器后会自动：

- 检测 5173 是否已有 PaperLens 在运行，有就直接打开；
- 没有就拉起服务（使用 Electron 自带的 Node，**不需要系统预装 Node**）；
- 启动成功后自动打开默认浏览器；
- 窗口里显示运行状态、端口、数据目录和日志；
- 点「停止」或关闭窗口，会停止由启动器启动的服务。

打包：

```bash
npm run desktop:build   # 生成未打包目录 release/win-unpacked（当前平台）
npm run desktop:dist    # 生成安装包：Windows NSIS/portable、macOS dmg、Linux AppImage
```

三平台需要分别在对应系统上构建，产物在 `release/`（已 gitignore）。Windows 会生成 `PaperLens Setup 2.1.0.exe`（安装包）与 `PaperLens 2.1.0.exe`（免安装便携版）。Electron 只是 `devDependencies`，普通命令行 `node server/index.mjs` 仍然可用，服务端依旧零运行时依赖。

构建脚本默认使用 npmmirror 镜像并让 Node 使用系统根证书，用来绕过部分网络环境下访问 GitHub 时的 `unable to verify the first certificate`。如果仍然失败：

```bash
# 换一个可用的镜像
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run desktop:dist

# 仅在受信任网络下临时跳过证书校验
PAPERLENS_INSECURE_TLS=1 npm run desktop:dist
```

## 自动发版

推送 `v*` tag 会自动构建 Windows / macOS / Linux 三平台安装包，并发布到 GitHub Releases：

```bash
git tag v2.1.0
git push origin v2.1.0
```

- 构建前会校验 tag 与 `package.json` 的 `version` 一致
- Windows：`PaperLens Setup 2.1.0.exe` + `PaperLens 2.1.0.exe`
- macOS：`PaperLens-2.1.0*.dmg`（未签名，首次打开需右键「打开」）
- Linux：`PaperLens-2.1.0*.AppImage`
- 手动触发 `Desktop build` 只上传 artifacts，不创建 Release

## 持续集成

`.github/workflows/ci.yml` 在 Ubuntu / macOS / Windows 三个平台跑同一套检查：

```bash
npm run check   # 所有 js/mjs 的 node --check
npm run smoke   # 临时数据目录启动服务，检查页面、配置、论文库、图谱与本地 vendor
```

## 快捷键

- `Ctrl/Cmd + B`：展开 / 收起历史论文侧栏（翻译与精读页通用）
- `Ctrl/Cmd + O`：在翻译视图中打开 PDF
- `Ctrl/Cmd + K`：图谱视图聚焦搜索框
- `Ctrl/Cmd + Enter`：开始 / 停止精读
- 追问框 `Enter` 发送，`Shift + Enter` 换行
