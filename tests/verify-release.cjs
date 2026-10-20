// 发布包核验：包名 / 补丁名 / 客户端模块 id / 工厂可执行 / 关键文案（大写 \uXXXX 形态）
// 用法：node verify-release.cjs
//       DSH_TODO_RELEASE_DIR=<发布包目录> node verify-release.cjs
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// 解析目标包目录：① 环境变量 ② 上一级就是发布包（GitHub 仓库根 = 已发布包） ③ 旧布局 release/dsh-todo-checklist
const resolveDir = () => {
  if (process.env.DSH_TODO_RELEASE_DIR) return process.env.DSH_TODO_RELEASE_DIR;
  const parent = path.resolve(__dirname, '..');
  const pkgFile = path.join(parent, 'package.json');
  if (fs.existsSync(pkgFile)) {
    const name = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).name;
    if (name === 'dsh-todo-checklist') return parent;
  }
  return path.join(parent, 'release', 'dsh-todo-checklist');
};
const dir = resolveDir();
const NAME = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;

let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const U = (c) => '\\u' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
const esc = (s) => s.split('').map(U).join('');

const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
check('package name', pkg.name === NAME, pkg.name);
// 版本号从 package.json 自我派生，不写死字面量。
// 原判据 `pkg.version === '1.5.11'` 读的是同一个字段再比同一个值 —— 恒真，等于没查；
// 每发一版还要手工改这里，漏改就整个套件变红。真正该查的是「版本格式合法」。
check('version 是合法 SemVer', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), pkg.version);
check('files 含 lib 目录项', pkg.files.includes('lib'), JSON.stringify(pkg.files));
check('files 含 locale 与 icon', pkg.files.includes('icon.svg') && pkg.files.some((f) => f.startsWith('locale/')));
check('exports 含 ./icon 与 locale', !!pkg.exports['./icon'] && Object.keys(pkg.exports).some((k) => k.includes('locale')));
check('dshhub 块存在', !!pkg.dshhub && pkg.dshhub.schemaVersion === 1);
check('peerDeps 重写', />=0\.2\.0-rc\.1 <0\.3\.0-0/.test(pkg.peerDependencies['@deepseek-ai/dsh-storage-domain']));
check('无 .bak 残留', !pkg.files.some((f) => f.includes('.bak')));

const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
check('patch name 改写', /name:\s*dsh-todo-checklist/.test(patch), patch.split('\n').filter((l) => l.includes('name:')).join('|').trim());

const client = fs.readFileSync(path.join(dir, 'lib', 'client.js'), 'utf8');
check('client id = 包名', client.includes(`id: "${NAME}"`));
check('client 无旧 id 注册', !client.includes('id: "dsh-todo"'));
check('client 无 U+FFFD', !client.includes('\uFFFD'));
check('client 含侧栏槽位', client.includes('sidebar.footer.action'));
check('client 含设置槽位', client.includes('settings.section'));
// 版本徽标：build-client.mjs 用 define 把 __APP_VERSION__ 替换成 package.json 的 version。
// 原判据写成 `client.split('v1.5.11').length - 1 === 2` —— 名字说 v1.5.8、实际查 v1.5.11、
// 次数 2 也是硬编码，三个数字里没一个从真源派生，每发一版都会误报。
// 真正该查的是：① 占位符已被替换 ② appVersion 拿到的是当前版本号
// ③ 「v<版本>」出现 2 次（导出文件抬头 + 设置页脚标）。
const badge = `v${pkg.version}`;
const badgeHits = client.split(badge).length - 1;
check('client 版本占位符已替换', !client.includes('__APP_VERSION__'));
check('client appVersion 注入正确', client.includes(`appVersion:"${pkg.version}"`), `期望 appVersion:"${pkg.version}"`);
check('client 版本徽标出现 2 次', badgeHits === 2, `${badge} n=${badgeHits}`);
check('client 含导出对话框', client.includes(esc('导出待办记录')));
check('client 含导出下载锚点', client.includes('createObjectURL'));
check('client 含 待办清单设置', client.includes(esc('待办清单设置')));

const host = fs.readFileSync(path.join(dir, 'host', 'index.js'), 'utf8');
check('host 无个人路径', !/C:\/Users|C:\\\\Users/.test(host));
check('host 诊断默认关闭', host.includes('DSH_TODO_DEBUG'));
check('host 跨宿主认领', host.includes('claimImPush'));
check('host inject 三项', /export const inject = \['tools', 'systemPrompt', 'storageDomain'\]/.test(host));
check('host 含 todo_export 工具', host.includes('todo_export'));
check('host 复用 shared/export-core', host.includes("'../shared/export-core.js'") || host.includes('../shared/export-core.js'));

// ── README 双语一致性 ────────────────────────────────────────────────
// 官方 dsh-plugin-dev 的 readme-consistency 把语言表写死成
// ["README.md","README-zh.md","README-es.md","README-pt.md","README-hi.md"]
// （dist/dsh-plugin-dev.js:536）。本仓库中文在 README.md、英文在 README-en.md，
// 官方只认得出 1 份，于是 existing.length < 2 → status:"skip"，闸门静默消失。
// 这里自己补上，判据与官方一致：以 README.md 的 `## ` 级标题为基准，
// 另一份必须逐字、同序包含同样的标题。
const headingsOf = (file) => {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  return text.split(/\r?\n/).filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
};
const zhFile = 'README.md';
const enFile = 'README-en.md';
const zhExists = fs.existsSync(path.join(dir, zhFile));
const enExists = fs.existsSync(path.join(dir, enFile));
check('双语 README 两份都在', zhExists && enExists, `zh=${zhExists} en=${enExists}`);
if (zhExists && enExists) {
  const zhH = headingsOf(zhFile);
  const enH = headingsOf(enFile);
  const missing = zhH.filter((h) => !enH.includes(h));
  const extra = enH.filter((h) => !zhH.includes(h));
  check('双语 README 标题集合一致', missing.length === 0 && extra.length === 0,
    missing.length || extra.length ? `en 缺: ${missing.join('|')} / en 多: ${extra.join('|')}` : `${zhH.length} 个`);
  check('双语 README 标题顺序一致',
    zhH.length === enH.length && zhH.every((h, i) => h === enH[i]),
    zhH.length === enH.length ? `逐行比对 ${zhH.length} 项` : `长度 ${zhH.length} vs ${enH.length}`);
  // 反向保护：标题为空说明文件被截断，两份都空会「一致」地通过
  check('双语 README 标题非空', zhH.length >= 5, `zh=${zhH.length} en=${enH.length}`);
}
check('package.json files 收录两份 README',
  pkg.files.includes('README.md') && pkg.files.includes('README-en.md'), JSON.stringify(pkg.files.filter((f) => /README/i.test(f))));

const store = fs.readFileSync(path.join(dir, 'host', 'store.js'), 'utf8');
const storeCode = store.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
check('store 代码中无 .strict()', !/\.strict\(\)/.test(storeCode), `strict(代码) n=${(storeCode.match(/\.strict\(\)/g) || []).length}`);
check('store 容错抢救函数', store.includes('salvageItems') && store.includes('salvageConfig'));

// 工厂探针（mock react），确认发布包产物能注册并执行
const reactMock = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  Component: class Component { constructor(p) { this.props = p ?? {}; this.state = {} } setState(s) { this.state = { ...this.state, ...s } } },
  useState: (i) => [typeof i === 'function' ? i() : i, () => { }],
  useEffect: () => { }, useRef: (i) => ({ current: i }), useCallback: (f) => f, useMemo: (f) => f(),
  createContext: () => ({}), useContext: () => ({}), cloneElement: (e) => e,
  Children: { map: () => [] }, forwardRef: (f) => f, version: '18.3.1',
};
const reactDomMock = { createRoot: () => ({ render: () => { }, unmount: () => { } }), flushSync: (f) => f() };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'react') return reactMock;
  if (request === 'react-dom/client') return reactDomMock;
  return origLoad.call(this, request, parent, isMain);
};
const registered = [];
globalThis.window = {
  __ModuleLoader__: { load: (e) => registered.push(e) },
  localStorage: { getItem: () => null, setItem: () => { }, removeItem: () => { } },
  addEventListener: () => { }, removeEventListener: () => { },
  setTimeout: () => 0, clearTimeout: () => { }, setInterval: () => 0, clearInterval: () => { },
  dispatchEvent: () => true, getSelection: () => null,
};
globalThis.document = {
  addEventListener: () => { }, removeEventListener: () => { },
  createElement: () => ({ style: {}, appendChild: () => { }, setAttribute: () => { }, addEventListener: () => { } }),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: { appendChild: () => { } },
  visibilityState: 'visible',
};
globalThis.__DSH_BOOT__ = { entry: { plugin: NAME } };
try { require(path.join(dir, 'lib', 'client.js')); } catch (error) { console.log('require error:', error && error.message); }
check('注册 id 正确', registered.length === 1 && registered[0].id === NAME, JSON.stringify(registered.map((r) => r.id)));

let factoryError = null; let keys = [];
try {
  const mod = registered[0].factory((n) => {
    if (n === 'react') return reactMock;
    if (n === 'react-dom/client') return reactDomMock;
    throw new Error('unexpected require: ' + n);
  });
  keys = Object.keys(mod);
} catch (error) { factoryError = error && error.message; }
check('工厂可执行', factoryError === null, factoryError || '');
check('导出 TYPERT_REMOTE/apply/inject', ['TYPERT_REMOTE', 'apply', 'inject'].every((k) => keys.includes(k)), JSON.stringify(keys));
Module._load = origLoad;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
