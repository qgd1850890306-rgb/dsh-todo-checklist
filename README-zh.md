<div align="center">

# ✅ dsh-todo-checklist ·「待办清单」

**待办从对话里长出来 —— 不是又一个需要你记得打开的 App。**

*划词加待办 · 对话自动捕获 · 左侧栏面板 · 到期提醒 · 一键导出*

[![version](https://img.shields.io/github/v/tag/qgd1850890306-rgb/dsh-todo-checklist?label=version&color=f59e0b)](https://github.com/qgd1850890306-rgb/dsh-todo-checklist/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](#)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.1-f59e0b)](#)

**简体中文** · [English](./README.md)

</div>

---

## 🎯 What it does · 它能做什么

大多数待办工具的失败原因是同一个：**念头出现在干活的时候，而不是出现在待办 App 里。** 你跟模型聊到一半，它说「另外记得核对一下 RoHS 报告有效期」，你点点头 —— 然后就没了。

这个插件把这个缺口补上。它长在 DeepSeek Harness 里，在**那句话出现的瞬间**把待办接住，四种接法：

| 你做的事 | 待办怎么进来 |
|---|---|
| 在回复里选中任意一句话 → 点 **＋ 待办** | 弹出卡片，AI 帮你填标题 / 内容 / 提醒时间，也可以自己手打 |
| 在对话里说「**记一下……**」/「**提醒我周五前**」 | 模型调用内置工具 `todo_add` 直接写入 |
| 一段对话聊完 | 对话里没落实的意图被自动捕获成待办 |
| 问「**我现在有哪些待办？**」 | 模型调用 `todo_list`，用你看的同一份数据回答 |

所有东西都落到**左侧那一个面板**里 —— 每个会话都在同一个位置，回顾成本是「瞟一眼」，不是「切个 App」。

---

## 📸 Screenshots · 界面截图

**面板：一直在那，收起时只占一行**

![侧栏面板](https://raw.githubusercontent.com/qgd1850890306-rgb/dsh-todo-checklist/main/docs/screenshots/sidebar.png)

**选中文字 → 冒出一个小气泡 → AI 把这句话变成结构化待办**

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/qgd1850890306-rgb/dsh-todo-checklist/main/docs/screenshots/bubble.png" alt="划词气泡"><br><sub><b>① 选中任意一句话</b> —— <code>＋ 待办</code> 气泡跟着选区出现</sub></td>
<td width="50%"><img src="https://raw.githubusercontent.com/qgd1850890306-rgb/dsh-todo-checklist/main/docs/screenshots/capture.png" alt="AI 记录待办"><br><sub><b>② 记录卡片</b> —— AI 预填标题、内容、提醒时间，每个字段都还能改</sub></td>
</tr>
</table>

**导出：8 条记录进去，一个自包含文件出来 —— 按「谁读」选格式**

![导出对话框](https://raw.githubusercontent.com/qgd1850890306-rgb/dsh-todo-checklist/main/docs/screenshots/export.png)

**设置页：模型、提醒渠道、侧栏开关，以及带四个分组的完整记录列表**

![设置页](https://raw.githubusercontent.com/qgd1850890306-rgb/dsh-todo-checklist/main/docs/screenshots/settings.png)

**整个窗口的样子**

![全窗口](https://raw.githubusercontent.com/qgd1850890306-rgb/dsh-todo-checklist/main/docs/screenshots/overview.png)

---

## 🚀 Quick start · 快速上手

1. **安装** —— 打开 DSH → 左侧栏 → **插件** → **添加插件** → 填 `dsh-todo-checklist` → **完全退出并重启 DSH**。
2. **加一条** —— 在任意对话里选中一句话 → 点 **＋ 待办** → 让 AI 填，或自己打 → **保存待办**。
3. **看与处理** —— 点左侧图标列底部的「**待办清单**」。勾掉它、双击跳回原句、或者等到点提醒自己弹出来。

整个闭环就这三步。不用注册，不用另起服务。

---

## ✨ Features · 功能一览

| 功能 | 实际做了什么 |
|---|---|
| **划词加待办** | 在任意回复里选中文字 → `＋ 待办` 气泡 → 弹窗里可**交给 AI 记录**（模型把这段话重写成标题 / 内容 / 提醒时间），也可手动填写 |
| **对话自动捕获** | 说「记一下……」，模型调用 `todo_add`（`source: "model"`）写入；`todo_list` 用同一个库回答「我有哪些待办」 |
| **左侧栏面板** | 挂在官方左侧图标列底部。收起时显示 `待办清单 · 预期 N 项 · 待完成 N 项`；展开是完整列表，含搜索、提醒筛选、四个分组（未完成 / 已完成 / 已放弃 / 逾期） |
| **到期提醒** | 每 30 秒扫描。弹**应用内提醒**（知道了 / 查看 / 完成 —— 「查看」跳回原会话并高亮原句），或经 **DSH-IM 机器人推送**（全局默认，单条待办可覆盖） |
| **导出** | HTML · Markdown · Excel(.xlsx) · CSV · JSON，每种都能导全部或筛选后的范围 —— 见[下方](#-export--导出) |
| **编辑与延期** | 改标题、内容、提醒时间（**年 / 月 / 日 / 时 / 分五段式输入** —— 点哪段，± 就只动哪段；分 ±30、其余 ±1，自动进位）；延期三档：+1 天、下周一 09:00、自定义 |
| **AI 重新整理** | 把已有待办交回模型重写成结构化内容，就地替换原条目 |
| **转定时任务** | 把待办转成周期性任务（需 `dsh-tasks`；未装时回退官方内置调度，都没有会给明确提示） |
| **新建会话** | 双击标题或点 ↗ 新建会话，待办内容预填进输入框，**沿用划词时那个会话的工作区与模型**；发送后该待办自动完成 |
| **持久保存** | 个人存储域 `dsh_todo_sidecar_items`，重启不丢。单条数据损坏会被独立抢救或丢弃 —— 不会让整个插件不可用 |

---

## 📤 Export · 导出

1.5.0 新增导出。设计目标很朴素：**同一批记录，人要能读，AI 也要能读，而且不该需要你手动转换。**

点**导出**（侧栏头部或设置页都有），选格式和范围即可。

**五种格式**：

| 格式 | 适合谁 | 说明 |
|---|---|---|
| **HTML** | 给人看 | 单个自包含 `.html`，双击就开、可直接打印成 PDF、不需要联网。所有内容都做了转义（防 XSS），跟随深色模式，带打印样式表 |
| **Markdown** | 人 / AI 都能看 | 带标题和勾选框的纯文本，粘进任何笔记软件都行，也可以整段喂给 AI |
| **Excel (.xlsx)** | 给人看 | 真正的 `.xlsx`（OOXML，14 列，首行冻结），Excel / WPS / Numbers 都能开，支持筛选和排序。**没有引第三方库** —— ZIP 容器是手写的，插件因此仍保持零运行时依赖 |
| **CSV** | 给 AI 看 | 通用纯文本。UTF-8 **带 BOM**，所以 Excel 打开中文不乱码；逗号、引号、换行按 RFC 风格加引号转义 |
| **JSON** | 给 AI 看 | 完整字段的结构化数据，字段最全，最适合程序或 AI 精确解析 |

**范围**：全部记录（默认）· 仅未完成 · 仅已完成 · 仅已放弃 · 仅逾期。

**两点值得知道：**

- 导出内容**只有清单本身** —— 标题、内容、时间、状态、AI 总结、来源会话。**不含对话原文**，也不会上传到任何地方。
- 格式化逻辑只有一份，放在 `shared/export-core.js`，**界面和宿主工具共用**。所以你下载到的文件，和 AI 通过 `todo_export` 拿到的文本，是同一份代码产出的 —— 两边不会漂移。

**给 AI 用的宿主工具**：

```
todo_export({ format: "md" | "csv" | "json" | "html", scope: "all" | "pending" | "done" | "abandoned" | "overdue" })
```

跟模型说「把我所有待办导出成 Markdown」，它会直接在对话里返回文本。（`.xlsx` 是二进制，所以工具会返回一句提示让你走界面按钮 —— 这是有意划的边界，不是缺功能。）

---

## 🧩 Requirements · 环境要求

- **DSH** `>= 0.2.0-rc.1`，已测 `0.2.0-rc.1`、`0.2.0-rc.2`、**`0.2.1-rc.2`**。
- **Node.js** `^22.19.0 || >=24.0.0`（`engines` 里声明；桌面端运行时自带 Node 24）。
- 桌面端或 Web 端均可 —— 客户端面声明 `platform: web`。
- **零运行时依赖**：宿主面已预打包成自包含文件（`lib/host.js`、`lib/typert.js`，zod 已内联）。安装时不需要下载任何东西，所以 `link:`、离线、tarball 三种装法表现完全一致。

---

## 📦 Install · 安装

> **这个包没有发布到 npm。** 它只通过 GitHub 分发，所以直接 `dsh plugin add dsh-todo-checklist`
> （只写包名）会报 `404 Not Found`。请用下面两条命令之一。

**方式一 —— 从 GitHub 装（推荐，一行命令）**

```bash
dsh plugin --profile desktop add https://github.com/qgd1850890306-rgb/dsh-todo-checklist.git
```

构建好的 `lib/` 已在仓库里，安装时不需要编译 —— 不会弹 `allowBuilds` 授权，也不需要本地工具链。

**方式二 —— 本地目录或 tarball**（离线 / 内网）

```bash
dsh plugin --profile desktop add <本地目录或 .tgz 的绝对路径>
```

**在界面上装**：**插件** → **添加插件** → 粘贴上面那条 GitHub URL（和方式一同一串）。

**升级** —— 用同一个 GitHub URL 再装一次，会拉最新的 `main`：

```bash
dsh plugin --profile desktop add https://github.com/qgd1850890306-rgb/dsh-todo-checklist.git
```

**卸载**：

```bash
dsh plugin --profile desktop remove dsh-todo-checklist
```

> 客户端界面部分的改动需要**重启 DSH** 才会生效。
> **装成功的标志**：左侧图标列多出一个「**待办清单**」。

---

## 🕹 Usage · 使用

- **加待办** —— 选中文字 → `＋ 待办` → 选 **AI 记录待办**，或手动填标题 / 内容 / 提醒时间。
- **设提醒时间** —— 单次模式下，**先点你要调的那一段（年 / 月 / 日 / 时 / 分），再按 − / ＋**：只有那一段会动（分 ±30，其余 ±1）。键盘 ↑ / ↓ 步进，← / → 换段。也可以用预设：1 小时后 / 明天 09:00 / 明天 17:00 / 工作日 09:00 / 下周一 09:00。
- **重复** —— 切到**每天**或**每周**，再选星期几和时间。
- **看与改** —— 点「待办清单」展开；勾选完成；行内 ✎ 编辑、✦ 转 AI 总结、✕ 删除；`⋯` 菜单里是编辑 / 删除。
- **跳回去** —— 双击标题（或点 ↗）新建会话；新会话沿用原工作区与模型，发送后该待办自动完成。
- **导出** —— 点面板头部或设置页的**导出**。
- **通知渠道** —— 默认应用内弹窗；要在设置页勾上 **DSH-IM 推送** 才会同时推到机器人（需先装 `dsh-im` 并配好机器人）。

---

## 🔒 Data, privacy & permissions · 数据、隐私与权限

- **数据在哪** —— `<DSH_HOME>/storages/dsh_todo_sidecar_items.json`（`<DSH_HOME>` 默认 `~/.dsh`）。卸载插件**不会**删除该文件，要清空请手动删。
- **网络** —— 插件自身**不发起任何外部网络请求**。只有你启用 DSH-IM 推送时，才会把提醒交给本机 DSH-IM 服务、发给你自己配置的机器人。
- **日志** —— 默认不写任何日志。排障时设 `DSH_TODO_DEBUG=1`，日志写入 `<DSH_HOME>/dsh-todo/diag.jsonl`（目录可用 `DSH_TODO_STATE_DIR` 改）。
- **用到的能力** —— 读会话事件（用于提醒与自动完成）、按需创建会话（AI 记录 / 新建会话）、读工作区列表、调模型（AI 记录与 AI 总结）、经 DSH-IM 发消息。
- **导出** —— 文件在浏览器里生成、走正常下载路径落盘，不上传任何内容。

---

## ⚠️ Known limitations · 已知限制

- **提醒依赖 DSH 正在运行** —— 没有后台常驻进程，DSH 关闭期间到点的提醒会在下次启动后补发。
- **机器人推送依赖 `dsh-im`** —— 未安装或未配机器人时推送不可用；应用内弹窗不受影响。
- **转定时任务依赖 `dsh-tasks`**，没有时回退官方内置调度。
- **AI 记录与 AI 整理各产生一次模型调用**（按你配置的模型计费）。
- 多个 DSH 实例同时运行时，同一条待办的机器人推送只会发一次（跨进程原子认领）。
- **尚未进入插件市场索引** —— 按上面的包名、GitHub 地址或插件管理器安装。

---

## 🩺 Troubleshooting · 故障排查

打开 **F12 → Console**：

- `__DSH_TODO_FOLLOWUP_TRACE__` —— 最近一次「新建会话」链路的逐步打点（工作区解析、RPC、打开会话）。
- `__DSH_TODO_ENTRY_ERROR__` —— 槽位渲染异常记录。

常见提示：

| 提示 | 含义 |
|---|---|
| 「存储不可用」 | 待办数据文件无法解析 —— 检查 `<DSH_HOME>/storages/dsh_todo_sidecar_items.json` 是否为合法 JSON |
| 「插件刚更新过：请重启 DSH 桌面端后重试」 | 宿主与界面的方法清单不一致 —— 重启 DSH 即可 |
| 侧栏开关没反应 | 「在左侧边栏显示待办清单」这个开关需要重启 DSH 生效 |

---

## 🛠 Development · 开发

```
dsh-todo-checklist/
├── package.json           # dsh.bundle / dsh.client / dshhub 元数据 / compatibility
├── cordis.patch.yml       # profile 配置层：插入 todo-sidecar 宿主插件
├── icon.svg               # 插件图标（同时作为 ./icon 导出）
├── locale/                # 展示元数据：en.json、zh.json（meta.title / meta.description）
├── typert.js              # 宿主面 Typert 清单源码（strict codec，loader 自动发现）
├── host/
│   ├── index.js           # todos 服务、AI 记录、提醒引擎、todo_add / todo_list / todo_export
│   └── store.js           # 存储域 + 容错解析与抢救
├── shared/
│   └── export-core.js     # 客户端与宿主共用的格式化逻辑（markdown/html/csv/json/xlsx）
├── client-src/
│   ├── index.js           # 客户端可读源码（手写 h()，无 JSX）
│   ├── export.js          # 客户端薄壳：再导出 core + 浏览器下载
│   └── segment-due-input.js
├── scripts/
│   ├── build-client.mjs   # esbuild → lib/client.js 工厂包
│   ├── build-host.mjs     # esbuild → lib/host.js、lib/typert.js（内联 zod，零依赖）
│   └── release-pack.mjs   # 打发布包：换名 + 重建产物 + 自检
└── lib/
    ├── client.js          # window.__ModuleLoader__.load({ id, factory }) 产物
    ├── host.js            # 宿主面入口（package.json 的 "main"）
    └── typert.js          # Typert 清单产物（exports["./typert"]）
```

- 构建全部产物：`node scripts/build-host.mjs && node scripts/build-client.mjs`（或 `npm run build`）。模块 id 恒等于包名，与官方插件一致。
- **宿主面改动必须跑 `build-host.mjs`** —— 运行时读的是 `lib/host.js`，不是 `host/index.js`。
- `dependencies` 故意留空（zod 只在构建期需要，放在 `devDependencies`），这样 `link:` 安装和离线安装不会因为缺依赖而激活失败。
- 打发布包（换名 + 重建产物 + 自检）：`node scripts/release-pack.mjs --name <npm 包名>`。
- 官方检查：`dsh-plugin-dev check`（静态 16 条规则）与 `dsh-plugin-dev verify`（打包 → 装进干净 profile → 冒烟 → 卸载）。

---

## 📝 Changelog · 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。近期：**1.5.2** 修正 `todo_list` 把已放弃记录渲染成未勾选项的问题；**1.5.1** 修复插件重载后待办不可读（存储域 already-open）；**1.5.0** 新增导出（HTML / Markdown / Excel / CSV / JSON）与 `todo_export` 工具。

---

## 📄 License · 许可

MIT
