// test-bat.mjs —— 用真实 cmd.exe 跑「一键启动.bat / 一键卸载.bat」，
// 验证它们不会被「编码 + 换行」问题破坏（症状：行首字符被吞，出现 'ompt' 这类幽灵命令）。
//
// 背景（已实测确认）：
//   cmd 用 OEM 代码页（简中 = GBK）读取 .bat 正文。若 .bat 以 UTF-8 存中文，
//   多字节错位会让 cmd 的行起点逐行漂移，吞掉后续行开头的字符。
//   组合实测：LF+ASCII ✅ / CRLF+ASCII ✅ / CRLF+中文 ✅ / LF+中文 ❌ 漂移损坏。
//   因此本项目 .bat 一律「纯 ASCII + CRLF」，中文提示全部交给 node 输出。
//
// 流程：setup → uninstall → setup（末次恢复为「已安装」状态）
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP_BAT = "一键启动.bat";
const UNINSTALL_BAT = "一键卸载.bat";

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) { pass++; console.log("   ✅ " + label + (extra !== undefined ? "  " + extra : "")); }
  else { fail++; console.log("   ❌ " + label + (extra !== undefined ? "  " + extra : "")); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 用真实 cmd 执行 bat；cmd 参数走 UTF-16，中文文件名可正确解析。
// pause 需要一行输入，这里补一个回车后关闭 stdin。
//
// ⚠️ 同一个管道里混了两种编码，不能只按一种解：
//   · cmd 自身输出（如 pause 的「请按任意键继续」）走 OEM 代码页 → GBK
//   · node 输出（我们的中文提示）写到管道时是 UTF-8
//   所以断言在「两种解码的并集」上做匹配，日志按 UTF-8 打印（node 的中文才是主要内容）。
function runBat(name) {
  return new Promise((resolve) => {
    const child = spawn("cmd.exe", ["/d", "/c", name], { cwd: HERE, windowsHide: true });
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (d) => (buf = Buffer.concat([buf, d])));
    child.stderr.on("data", (d) => (buf = Buffer.concat([buf, d])));
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      const utf8 = buf.toString("utf8");
      const gbk = decodeGbk(buf);
      resolve({ code, buf, utf8, gbk, text: utf8 + "\n" + gbk });
    };
    child.on("close", finish);
    child.on("error", () => finish(-1));
    setTimeout(() => { try { child.stdin.write("\r\n"); child.stdin.end(); } catch {} }, 3500);
  });
}

function decodeGbk(buf) {
  try { return new TextDecoder("gbk").decode(buf); } catch { return buf.toString("latin1"); }
}

// 「行首字符被吞」的典型症状：某行以 ' 开头、到 ' 结束，被 cmd 当成命令去执行
const DRIFT_LINE = /^\s*'[^'\r\n]*'/m;
const NOT_CMD = /不是内部或外部命令|也不是可运行的程序|is not recognized as an internal or external command/i;

function assertClean(label, text) {
  check(label + "：无「字符被吞」幽灵命令", !DRIFT_LINE.test(text),
    DRIFT_LINE.test(text) ? "命中 " + JSON.stringify((DRIFT_LINE.exec(text) || [])[0]) : "");
  check(label + "：无「不是内部或外部命令」", !NOT_CMD.test(text));
}

console.log("=============== .bat 解析回归 ===============");
console.log("\n[1/3] 运行 " + SETUP_BAT);
const s1 = await runBat(SETUP_BAT);
console.log(s1.utf8.trimEnd());
console.log("  退出码 =", s1.code);
assertClean("setup", s1.text);
check("setup：走到步骤 [1/4]", /\[1\/4\]/.test(s1.text));
check("setup：走到步骤 [4/4]", /\[4\/4\]/.test(s1.text));
check("setup：打印了完成横幅", /设置完成/.test(s1.text));
// 按 UTF-8 解码仍能读到中文，说明 node 的中文提示是按 UTF-8 原样写出的（没被 GBK 转码破坏）
check("setup：中文由 node 原样输出（UTF-8）", /一键启动/.test(s1.utf8) && /设置完成/.test(s1.utf8));
check("setup：提示了卸载入口", /一键卸载/.test(s1.text));

console.log("\n[2/3] 运行 " + UNINSTALL_BAT);
const s2 = await runBat(UNINSTALL_BAT);
console.log(s2.utf8.trimEnd());
console.log("  退出码 =", s2.code);
assertClean("uninstall", s2.text);
check("uninstall：打印了卸载完成", /卸载完成/.test(s2.text));
check("uninstall：提到停止代理", /代理/.test(s2.text));
check("uninstall：中文由 node 原样输出（UTF-8）", /卸载完成/.test(s2.utf8));

console.log("\n[3/3] 再次运行 " + SETUP_BAT + "（恢复为已安装状态）");
const s3 = await runBat(SETUP_BAT);
console.log(s3.utf8.trimEnd());
console.log("  退出码 =", s3.code);
assertClean("setup(恢复)", s3.text);
check("setup(恢复)：打印了完成横幅", /设置完成/.test(s3.text));

// 静态约束：源文件必须保持纯 ASCII + CRLF
console.log("\n[static] .bat 文件字节约束");
for (const name of [SETUP_BAT, UNINSTALL_BAT]) {
  const b = await readFile(join(HERE, name));
  const lf = b.toString("latin1").split("\n").length - 1;
  const crlf = b.toString("latin1").split("\r\n").length - 1;
  check(name + " 纯 ASCII", b.every((c) => c < 128));
  check(name + " 全 CRLF（无裸 LF）", lf > 0 && lf === crlf, "LF=" + lf + " CRLF=" + crlf);
  check(name + " 无 BOM", !(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf));
}

await sleep(500);
console.log("\n==============================================");
console.log(fail === 0 ? "✅ .bat 解析回归全部通过（" + pass + " 项）" : "❌ 有 " + fail + " 项未通过（通过 " + pass + " 项）");
process.exitCode = fail === 0 ? 0 : 1;
