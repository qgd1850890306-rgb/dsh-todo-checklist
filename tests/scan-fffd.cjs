// 只读扫描：定位注释残留里「吞掉下一行代码」的可疑点（E-33 中毒后遗症）。
// 判定口径：// 之后的文字里出现「代码语句特征」（关键字开头，或 标识符( 这种调用形态）才算可疑——
// 纯散文里的 = > { } 属误报，不计入。发布前应做到「可疑行数 = 0」。
// 用法：node scan-fffd.cjs <要扫描的文件>（默认扫 client-src/index.js）
const fs = require('node:fs')
const path = require('node:path')
// 目标包目录：① 显式参数 ② 环境变量 ③ 上一级本身就是插件包（仓库布局） ④ 旧布局 ..\dsh-todo
const resolveDefault = () => {
  const parent = path.resolve(__dirname, '..')
  if (fs.existsSync(path.join(parent, 'client-src', 'index.js'))) return path.join(parent, 'client-src', 'index.js')
  return path.join(parent, 'dsh-todo', 'client-src', 'index.js')
}
const file = process.argv[2]
  || (process.env.DSH_TODO_PLUGIN_DIR && path.join(process.env.DSH_TODO_PLUGIN_DIR, 'client-src', 'index.js'))
  || resolveDefault()
const text = fs.readFileSync(file, 'utf8')
const lines = text.split(/\r?\n/)
// 代码语句特征：关键字后面必须跟「像代码的下一段」（字母/数字/括号/引号），
// 借此前置负向断言把「静默 return 导致…」这类纯中文散文排除掉；另一半是 ASCII 调用形态 标识符(
const CODEISH = /(?<![\u4e00-\u9fff\uFFFD])\b(const|let|var|return|await|throw|import|export|function|if|else|for|while|typeof|new)\s+[A-Za-z_$([{"'`\d]|[A-Za-z_$][\w$.]*\s*\(/
let fffd = 0
let suspect = 0
lines.forEach((line, i) => {
  if (!line.includes('\uFFFD')) return
  fffd += 1
  const commentAt = line.indexOf('//')
  if (commentAt < 0) return
  const before = line.slice(0, commentAt)
  // 字符串里的 // 会误判，这里只看 // 之后是否出现代码特征
  const after = line.slice(commentAt + 2)
  if (CODEISH.test(after)) {
    suspect += 1
    console.log(`L${i + 1}  ${after.slice(0, 90)}`)
  }
})
console.log(`\n含 U+FFFD 行数: ${fffd}；可疑（注释后仍像代码）行数: ${suspect}`)
