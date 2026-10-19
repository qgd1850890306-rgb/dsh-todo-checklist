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
check('version', pkg.version === '1.5.9', pkg.version);
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
check('client 含 v1.5.8 徽标', (client.split('v1.5.9').length - 1) === 2, `n=${client.split('v1.5.9').length - 1}`);
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
