# dsh-todo / dsh-todo-checklist 验证工具

发布前必跑的四类验证，全部只读或临时件自清理，不改动包内容。默认目标 = 源码包
`../dsh-todo`（可用环境变量 `DSH_TODO_PLUGIN_DIR=<包目录>` 换到发布包或任意安装目录）。

## 1. 宿主端到端（源码形态，37 项）

```powershell
node host-e2e.mjs
```

把 `host/index.js`、`host/store.js` 复制成临时 `.mjs` 并打桩（`defineDomain`/`defineTool` 恒等），
用 mock ctx 跑真实插件：A 正常链路（服务/工具/提示词/监听器 + CRUD 往返）、B 精简环境降级
（无 agents / llm / dshIm）、C 存储打不开时 fail-soft（apply 不抛、工具仍注册、读写给人话错误）、
D 跨宿主重复推送去重、E 诊断落盘默认关闭。期望 `37/37 PASS`（F 段 5 项只在打包产物形态跑，见下）。

## 2. 宿主端到端（打包产物形态，42 项）

```powershell
node mk-bundle-e2e.mjs            # 由 host-e2e.mjs 生成 host-e2e-bundle.mjs
node host-e2e-bundle.mjs          # 默认校验源码包
$env:DSH_TODO_PLUGIN_DIR='..\release\dsh-todo-checklist'; node host-e2e-bundle.mjs
```

这一版直接导入**要发布的产物** `lib/host.js`、`lib/typert.js`（复制到临时目录 + 桩 node_modules），
额外校验 F 段：typert 产物导出 `TYPERT`、`manifest.package` 等于包名（typert-loader 强校验）、
`face=host`、产物无裸 `zod` 导入、`dependencies` 为空。期望两边都 `42/42 PASS`（A–E 37 项 + F 5 项）。

## 3. 存储容错（14 项）

```powershell
node schema-tolerance.mjs
```

用**磁盘真实数据** `<DSH_HOME>/storages/dsh_todo_sidecar_items.json` 加人工注入的坏数据
（未知键、缺标题、单条彻底损坏、config 坏字段、items 变成 null/对象/JSON 字符串…）跑
`todoDomainSpec.global.schema`，确认「单条坏只丢一条、字段坏只丢字段」。期望 `14/14 PASS`。

## 4. 存储域生命周期（11 项）

```powershell
node domain-reload.mjs
```

复刻 0.2.x `DomainFacility` 的 `reserved` 语义（按 name 记名，只有 `close()` 才释放），验证
v1.5.1 修的那个真实故障：插件重载后 `open()` 抛 `already-open` → 待办列表整体不可读。覆盖
apply→dispose→再 apply、上一实例遗留未关闭的域被沿用（不抢不关）、并发 open 未落地时轮询后
沿用、句柄被设施 `closeAll` 后自动重开自愈、以及诊断留痕。期望 `11/11 PASS`。

## 5. 发布包核验（29 项）

```powershell
node verify-release.cjs
```

对发布副本做静态核验：包名 / 版本 / `files` / `dshhub` / `peerDependencies` / 无 `.bak` /
`cordis.patch.yml` 的 `name:` 已改写 / 客户端产物注册 id 等于包名且无旧 id / 无乱码 U+FFFD /
关键文案在位 / 宿主无个人绝对路径 / 诊断默认关闭 / 跨宿主认领函数在 / `inject` 三项 /
存储 schema 无 `.strict()` 且抢救函数在 / 客户端工厂可执行且导出 `TYPERT_REMOTE,apply,inject`。
期望 `29 PASS / 0 FAIL`。

## 6. 乱码残留扫描（E-33 中毒后遗症）

```powershell
node scan-fffd.cjs                                # 默认扫 ../dsh-todo/client-src/index.js
node scan-fffd.cjs ..\release\dsh-todo-checklist\client-src\index.js
```

统计 U+FFFD（�）所在行，并挑出「注释后面还跟着像代码的片段」的行——那种才是真损伤
（注释把下一行代码吞了，esbuild 不会报错，只会在运行时表现为功能静默失效）。
**发布门槛：可疑行数 = 0**（注释里的 � 本身无害，可保留）。

## 发布前例行顺序

```powershell
cd ..\dsh-todo
node scripts/build-host.mjs; node scripts/build-client.mjs   # 重建宿主/客户端产物
node scripts/release-pack.mjs                                # 换名打包 + 自检
cd ..\tests
node mk-bundle-e2e.mjs; node host-e2e-bundle.mjs
$env:DSH_TODO_PLUGIN_DIR='..\release\dsh-todo-checklist'; node host-e2e-bundle.mjs; Remove-Item Env:\DSH_TODO_PLUGIN_DIR
node schema-tolerance.mjs
node domain-reload.mjs
node verify-release.cjs
node scan-fffd.cjs
```

真机验证（可选，另开一份 DSH_HOME，不影响用户日常环境）：

```powershell
$env:DSH_HOME='..\testhome'
dsh plugin --profile t1 add (Resolve-Path ..\release\dsh-todo-checklist)
dsh --profile t1 --port 20123 --no-open --host 127.0.0.1
```

启动日志若出现 `1 entry did not activate` / `failed to import`，说明插件激活失败（注意：`dsh --profile t1 web …`
会报 `too many arguments`，参数直接跟在 `--profile` 后面）。
