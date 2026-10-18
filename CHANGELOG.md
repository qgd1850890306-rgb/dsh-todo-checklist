# 更新日志（CHANGELOG）

本插件遵循语义化版本：`主版本.次版本.修订号`。
早期版本（0.x）为内部迭代，自 `1.0.0` 起面向使用者记录。

## 1.5.3 — 2026-10-19

侧栏回归简洁，导出搬进设置页并改成可折叠的一块。

### 变更
- **侧栏去掉导出按钮**：上一版把导出图标塞在「待办清单」标题行里，在 254px 宽的侧栏里把标题挤成两行、和「预期 N 项 / 待完成 N」抢位置。现在头部只留折叠箭头、标题、预期胶囊和完成数。
- **导出改为设置页内联折叠区**：在「设置 → 待办清单」里，位于 AI 默认提醒时间与状态标签页之间。收起时只有一行「⤓ 导出全部记录 · 共 N 条 · HTML / Markdown / Excel / CSV / JSON」，点开才展开格式卡片、范围筛选和「导出文件」按钮。默认收起，不占版面。
- **导出表单两种宿主共用一份实现**：`ExportDialog` 增加 `inline` 模式，弹窗与内联渲染同一棵组件树，格式/范围/校验规则不会各写一套而漂移。

### English
- **Export button removed from the sidebar**: it was wedged into the "Todo Checklist" title row, squeezing the title onto two lines in a 254px sidebar and competing with the expected/remaining badges. The header is back to chevron + title + expected count + remaining count.
- **Export moved into the settings page as a collapsible section**, between the AI default reminder time and the status tabs. Collapsed it is a single line ("⤓ Export all records · N items · HTML / Markdown / Excel / CSV / JSON"); expanded it reveals the format cards, the scope filter and the export button. Collapsed by default.
- **One implementation, two hosts**: `ExportDialog` gained an `inline` mode, so the modal and the inline section render the same tree — format, scope and validation rules cannot drift apart.

## 1.5.2 — 2026-10-19

修正 `todo_list` 对「已放弃」记录的标记：此前把它渲染成未勾选的 `[ ]`，模型转述时会当成「还没做」。

### 修复
- **已放弃不再冒充未完成**：`todo_list` 现在用三种记号区分状态 —— `[ ]` 未完成、`[x]` 已完成、`[-]` 已放弃，并在已放弃条目后附「放弃原因」。此前三种状态只有完成/未完成两种记号，已放弃的记录看起来和待办一模一样，头部「未完成 N」与正文的 `[ ]` 条数也因此对不上（真机实测：头部说未完成 6，正文却有 7 个 `[ ]`）。
- **头部计数补上已放弃**：只在确实存在已放弃记录时才追加「/ 已放弃 N」，没有该类记录时头部保持原样。

### English
- **Abandoned records no longer masquerade as pending**: `todo_list` now renders three distinct marks — `[ ]` pending, `[x]` completed, `[-]` abandoned — and appends the abandon reason. Previously an abandoned record was indistinguishable from a pending one, so the header count ("6 pending") contradicted the body (7 unchecked boxes).
- **The header count now includes abandoned records**, appended as "/ N abandoned" only when such records exist.

## 1.5.1 — 2026-10-19

修复一个会让待办列表**整体读不出来**的存储生命周期缺陷（升级后建议重启一次 DSH）。

### 修复
- **插件重载后待办不可读**：现象是侧栏空掉、`todo_list` 一直报 `存储不可用（待办数据无法读写）：domain 'dsh_todo_sidecar_items' is already open`，重启才能恢复。根因是存储域「只开不关」——宿主在插件重载（改配置、重挂载、窗口重开）时会重建插件，上一实例仍占着域名的登记位，新实例 `open()` 直接抛 `already-open`，而失败又被缓存成一等一的不可用。现在按官方契约「谁 open 谁 close」在卸载时释放句柄；同时补两条自愈路径：设施上已有同名域就沿用（不抢不关），句柄被外部关闭则自动重开。数据文件本身从未受损。
- **域打开失败不再静默**：`DSH_TODO_DEBUG=1` 时，沿用路径记 `domainReused`、真失败记 `domainOpenError`，便于反馈时定位。

### English
- **Fixed the todo list becoming unreadable after a plugin reload**: the storage domain was opened lazily but never closed, so once the host re-created the plugin fiber the next `open()` threw `already-open` and every read failed until a restart. The handle is now released on dispose per the "who opens, closes" contract, with two self-healing paths: adopt an existing domain instead of racing for it, and re-open automatically if the handle was closed underneath. The stored data was never damaged.
- **Domain-open failures are no longer silent**: with `DSH_TODO_DEBUG=1`, adopting a domain logs `domainReused` and a real failure logs `domainOpenError`.

## 1.5.0 — 2026-10-19

新增导出功能（五种格式、五种范围），并适配 DSH `0.2.1-rc.2` 与 0.2 世代插件规范。

### 新增
- **一键导出全部记录**：侧栏面板头部与设置页各有一个「导出」入口，可选 **HTML / Markdown / Excel(.xlsx) / CSV / JSON** 五种格式，以及**全部 / 仅未完成 / 仅已完成 / 仅已放弃 / 仅逾期** 五种范围。导出前实时显示「将导出 N 条」。
- **`.xlsx` 是真 Excel 文件**：OOXML 格式、14 列、首行冻结，Excel / WPS / Numbers 直接打开可筛选排序。ZIP 容器与工作表 XML 由插件自己生成，**没有引入任何第三方库**，插件保持零运行时依赖。
- **`todo_export` 模型工具**：让 AI 自己取数据 —— `todo_export({ format: "md"|"csv"|"json"|"html", scope: ... })` 直接在对话里返回文本。`.xlsx` 是二进制，工具会提示走界面按钮。
- **格式化逻辑单一来源**：新增 `shared/export-core.js`，界面导出与 AI 工具**共用同一份代码**，两条通道产出的内容不会漂移。

### 改进
- **适配 DSH 0.2.1-rc.2**：`dsh.compatibility.dshReleases` 增加 `0.2.1-rc.2: compatible`；官方 `dsh-plugin-dev verify`（打包 → 装进干净 profile → 冒烟 → 卸载）通过。
- **补齐 0.2 世代展示元数据**：新增 `locale/en.json`、`locale/zh.json`（`meta.title` / `meta.description`）与 `icon.svg`，并在 `exports` 中导出 `./locale/*.json` 与 `./icon`。
- **`engines.node` 改为 `^22.19.0 || >=24.0.0`**，同时覆盖 Node 22 与 24。
- **`files` 白名单补 `lib` 目录项**，与 `main` 指向一致；`packageManager` 固定为 `pnpm@11.7.0`。
- **CSV 带 UTF-8 BOM**，Excel 打开中文不乱码。
- 面板头部新增导出按钮（点击不会误触折叠面板）。

### 修复
- **侧栏标题被挤成竖排**：面板变窄时标题会逐字折行。现在标题与徽标都禁止换行，空间不够时优先让徽标让位。
- **导出内容剔除控制字符**：避免个别记录里的不可见字符破坏 HTML / XML 结构。

### English
- **Export**: HTML / Markdown / Excel(.xlsx) / CSV / JSON, each over all / pending / done / abandoned / overdue records.
- **Real `.xlsx`** (OOXML, 14 columns, frozen header) generated with a hand-written ZIP writer — still zero runtime dependencies.
- **`todo_export` model tool** so the assistant can hand records straight back into the conversation.
- **Single source of formatting** in `shared/export-core.js`, shared by the UI download and the AI tool.
- **DSH `0.2.1-rc.2` support**: compatibility entry added; official `dsh-plugin-dev verify` (pack → install into a clean profile → smoke → uninstall) passes.
- **0.2-generation display metadata**: `locale/en.json`, `locale/zh.json`, `icon.svg` and their `exports` entries.
- Fixed the sidebar title wrapping one character per line on narrow panels.

## 1.4.0 — 2026-10-12

两项通用化：机器人推送与转定时任务都改为「优先自己安装的插件，再官方/内置」。

### 改进
- **机器人推送通用化**：机器人下拉从「硬编码只认 dsh-im」改为「静态候选 + 运行时合并已保存配置引用的服务名」，并给每个机器人打上来源服务名（`service` 字段）。单条待办与全局默认都持久化 `imService`，推送时优先按记录的来源服务精准路由，缺省再遍历候选兜底。以后装了别的 bot 投递插件也能自动被发现。
- **转定时任务改为「自装插件优先、官方兜底」**：保持原来的自装「定时任务」（dsh-tasks，HTTP 端点）主路径；当它未安装、或调用失败（404/5xx）时，自动回退到官方内置「自动化任务」（dsh-schedule，进程内 `schedule.create`），不再只弹「请先安装」。回退时按当前 cron 转成官方的 `{ expression, time_zone }` 选择器，标题/内容原样带过去。

## 1.3.0 — 2026-10-12

提醒时间输入重做为「五段式」自绘控件，并修复一个由它引发的划词气泡消失问题。

### 修复
- **划词后「＋ 待办」气泡消失**：新增的日期输入组件漏写了 React 依赖（`useState` 等），运行时抛「useState is not defined」，被全局错误边界拦下后整棵界面树（划词气泡 + 提醒弹窗）被替换成隐藏节点，划词气泡永久消失（重启才恢复）。已补全 import。

### 改进
- **提醒时间改为五段式输入**：把原生的 `datetime-local` 控件换成自绘的「年 / 月 / 日 / 时 / 分」分段输入框，点哪段、再点 − / ＋ 就在该段步进（分 ±30、其余 ±1，自动进位）；键盘 ↑ / ↓ 步进、← / → 换段。原控件无法感知用户点选了哪一段，点 ± 时只会加分钟，体验不一致。

## 1.2.9 — 2026-10-11

发布加固版本：清理内部调试代码、补齐异常兜底、兼容不同环境，并补齐发布元数据。功能与 1.2.8 一致。

### 修复
- **左侧划词气泡里的「应用内弹窗」选项此前不生效**：保存时该字段被一段损坏的注释吞掉，从未随待办一起发出（一直按全局设置执行）。已修复。
- **划词选区保护失效**：气泡内阻止默认行为的调用被注释吞掉。已修复。
- **侧栏「待办清单」与官方图标左对齐不生效**：对齐用的左边距被注释吞掉，成了一行死代码。已修复。
- **跳转划词位置的高亮兜底策略失效**：找不到目标块级元素时回退到文本父元素的逻辑被注释吞掉。已修复。
- **编辑待办保存失败时无任何提示**（RPC 抛错只走 `finally`）。现在会提示「保存失败：…」。
- **读取失败时可能出现空白/整块界面消失**：错误对象被直接当作界面节点渲染（React 会抛错并卸载整棵子树）。现在统一转成字符串显示，并在全局挂载点加了错误边界，单点异常不再拖垮整个插件界面。
- **「转定时任务」在未安装「定时任务」（dsh-tasks）插件时只报「转换失败：未知错误」**。现在会先探测该插件是否可用，不可用时给出明确指引并禁用确认按钮。

### 改进
- **宿主面改为零运行时依赖**：新增 `scripts/build-host.mjs`，把宿主导入（`host/index.js`、`typert.js`）打包成自包含的 `lib/host.js` / `lib/typert.js`（zod 内联，Node 内置模块保持外部）；`package.json` 的 `main` 指向 `lib/host.js`，`dependencies` 清空，zod 移入 `devDependencies`。原因是 `link:` 形式安装不会安装被链接包的依赖——此前在本地目录 / 离线安装时会出现 `failed to import`（缺 zod），宿主插件无法激活。
- **启动更稳**：宿主端两项内部调试任务（启动期机器人探测、启动 15 秒后自动创建一条真实会话）已删除；诊断落盘改为按需开启（环境变量 `DSH_TODO_DEBUG=1`），日志写到 `DSH_TODO_STATE_DIR` 或 `~/.dsh/dsh-todo/`，默认不写任何文件。
- **存储损坏不再导致插件整体不可用**：领域数据读取改为容错解析——单条待办损坏只丢该条，配置字段损坏只丢该字段，并能从常见格式偏差（数组 / 对象 / JSON 字符串）中抢救数据；读取不到时给出「存储不可用」的可读提示，而不是让插件加载失败。
- **精简环境不再拒绝激活**：`agents`、`agentDefaultModel` 由硬依赖改为按需获取，缺少 AI 能力时其余功能照常可用。
- **多宿主重复推送防护**：到期提醒的机器人推送改为跨进程原子认领，多个 DSH 实例同时运行时同一条待办只会推送一次。
- **轮询更省资源**：侧栏轮询在页面不可见时退避到 30 秒且不请求数据；跳转高亮轮询改为可取消，且只在会话区域查找（原先是整页扫描）。
- **界面文案统一**：「代办」全部改为「待办」；日期格式固定为中文（`zh-CN`）。
- **删除了从未启用的会话输入区 dock 面板代码（约 330 行）**，以及一段没有消费方、却在启动路径上等待未知服务的「宿主模型服务」探测。

### 元数据（发布相关）
- `package.json`：补齐中英双语描述、`keywords`、`dshhub` 展示信息、`dsh.compatibility.dshReleases`（已测 `0.2.0-rc.1` / `0.2.0-rc.2`）、`exports` 对象形式与 `./cordis.patch.yml` 导出。
- 客户端模块依赖（`dsh.client.inject`）改为全限定模块名，与官方插件写法一致。
- 两条 `peerDependencies` 版本范围重写——原范围匹配不到任何真实发布版本，会导致兼容性检查误判。
- `files` 由目录级改为文件级，避免把开发期备份文件打进发布包。
- 新增本 `CHANGELOG.md`。

## 1.2.8 — 2026-10-11

- **修复「双击待办后左侧待办面板整个消失」**：提示信息以对象形式传入时被直接当作界面节点渲染，触发 React 报错并移除该面板。现在提示统一归一化为纯文本。
- **修复提醒弹窗点「查看」跳回会话后没有高亮**：该按钮此前直接调用官方 `openSession`，绕过了插件自己的定位与高亮链路。现在会携带「消息 ID + 锚点文本」走插件跳转链路，跳转后高亮原划词位置。

## 1.2.7 — 2026-10-11

- **修复界面文案乱码**（部分标签显示为方块，如「未完◆」）——上次批量替换事故留下的损坏字符，共 25 处用户可见文案。
- **修复左侧栏显示开关失效**：设置页「在左侧边栏显示待办清单」的回显语句被损坏注释吞掉，导致开关状态丢失。
- **新建会话的模型改为继承来源会话**：双击待办新建会话时，新会话优先使用「划词时所在会话」当时使用的模型；拿不到（会话已归档/已结束）时才回退到「AI 记录模型」偏好，再回退到全局默认模型。

## 1.2.6 — 2026-10-11

- 新建会话时，若来源会话不属于任何工作区，改挂到第一个工作区，避免「新会话没有工作区」。
- 新建会话的等待提示延长到约 6 秒。

## 1.2.5 — 2026-10-11

- 去掉新建会话前长达 6 秒的阻塞等待：现在点击后立即打开新会话。
- 修复设置详情页点击「新建会话」无任何反馈（该页面的提示缺少渲染出口）。

## 1.2.4 — 2026-10-11

- 新建会话改为把「来源会话 ID」一并交给宿主，由宿主反查工作区归属（此前依赖界面层快照，常查不到）。
- 兼容性校验新增字段同步，避免「插件刚更新过」类校验报错。

## 1.2.3 — 2026-10-11

- 工作区路径做真实路径归一，避免 Windows 盘符大小写差异导致会话挂载工作区失败。
- 会话挂载失败不再静默：写入诊断记录。
- 自动生成的待办标题精简：AI 提示要求 16 字以内，落库与展示截断到 24 字。

## 1.2.2 — 2026-10-11

- **修复到期提醒弹窗不弹**（读取待办列表时取错了返回层级，队列恒为空）。
- 侧栏标题「待办清单」不再被头部图标挤到换行。
- 设置详情页新增「在左侧边栏显示待办清单」开关（修改后重启 DSH 生效）。
- 新建会话时等待工作区归属同步（后于 1.2.5 移除）。

## 1.2.0 / 1.2.1 — 2026-10-10

- 「AI 记录待办」提交后立即关闭弹窗；按钮图标改为矢量图标。
- 侧栏卡片左内边距对齐官方图标列。
- 新建会话默认使用来源会话所在的工作区。

## 1.1.7 – 1.1.9 — 2026-10-10

- 图标体系改为自绘矢量图标（线性圆角风格），设置详情页与侧栏的行内操作图标统一。
- 新建会话入口支持「↗ 图标」与「双击待办标题」，并预填待办内容到输入框。
- 修复侧栏「⋯」菜单点开后再点不收起的交互冲突。
- 修复「新建会话」因字段未同步导致的校验失败，并把此类报错翻成可读提示。

## 1.1.6 — 2026-10-10

- 新增「转 AI 总结」：把已有待办交给 AI 重新整理成结构化内容，并替换原条目。
- 记录待办时可单独设置「应用内弹窗 / 机器人推送」及推送目标机器人（不设置则跟随全局）。

## 1.1.4 / 1.1.5 — 2026-10-10

- 文案统一为「待办清单」。
- 修复机器人清单为空（客户端漏了对宿主「列出机器人」方法的包装调用）。

## 1.1.2 / 1.1.3 — 2026-10-09

- 修复「保存待办失败：存储数据与结构不匹配」：配置结构漏声明了 AI 默认提醒时间字段，导致整个存储域打不开。
- 修复机器人清单偶发为空：宿主在机器人服务「对象已就绪但清单尚未加载」的窗口期内提前返回。
- 提醒时间微调按钮：选中分钟 ±30 分钟，选中小时/日期 ±1；修复只有分钟档生效的问题。
- AI 整理过程中显示「⏳ AI 整理中」标识。
- AI 总结内容按小节分段排版。

## 1.1.0 / 1.1.1 — 2026-10-09

- 会话跳转后高亮定位到划词位置。
- 「AI 记录待办」与「定时提醒」可用。

## 0.5.0 — 2026-10

- 左侧栏面板（收纳态显示未完成数量与绿点，展开显示待办列表、已完成/已放弃合集）。
- 延期三档：+1 天、下周一 09:00、自定义时间。
- 到期提醒引擎：应用内弹窗 + DSH-IM 机器人推送。

## 0.3.x – 0.4.x — 2026-09

- 首次按官方插件协议接入：Typert RPC 清单、客户端模块注册、侧栏槽位与设置页槽位。
- 划词加入待办、AI 记录待办、待办列表工具（供模型调用）。
