import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// HTML 存在独立的 ui.html，运行时以 UTF-8 直接读取原始字节。
// 不用 String.raw 内联模板：Bun 转译器默认 charset=ascii 会把非 ASCII 字符
// 转成 \uXXXX 写进模板 raw 数组，而 String.raw 不解码，导致页面出现字面 \uXXXX 乱码。
// 从文件读取绕开转译器，既保证真汉字/符号，又保留内嵌 JS 里 onclick 的 \' 转义。
const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui.html"), "utf8");

export function renderHtml(): string {
  return HTML;
}
