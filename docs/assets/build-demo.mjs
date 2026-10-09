// pob-build-demo.mjs —— 把渲染好的帧合成为 README 演示动图
// 依赖：gifenc、pngjs（仅构建期使用，装在隔离工作区，不进插件运行时）
// 用法：node pob-build-demo.mjs <帧目录> <输出 gif 路径>
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import pkg from "gifenc";

const { GIFEncoder, quantize, applyPalette } = pkg;

const [, , dir, outPath] = process.argv;
if (!dir || !outPath) {
  console.error("用法：node pob-build-demo.mjs <帧目录> <输出 gif 路径>");
  process.exit(1);
}

// 每帧停留时长（毫秒）：草稿 → 悬停 → 优化中 → 结果 → 还原
const DELAYS = [1700, 550, 1250, 2900, 1300];
const FILES = ["frame0.png", "frame1.png", "frame2.png", "frame3.png", "frame4.png"];

const frames = FILES.map((name) => {
  const png = PNG.sync.read(readFileSync(`${dir}/${name}`));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
});

const { width, height } = frames[0];
for (const f of frames) {
  if (f.width !== width || f.height !== height) throw new Error("所有帧尺寸必须一致");
}

// 全局调色板：一次量化所有帧的像素，避免逐帧换色板导致的体积膨胀与闪烁
const total = new Uint8Array(width * height * 4 * frames.length);
frames.forEach((f, i) => total.set(f.data, i * width * height * 4));
const palette = quantize(total, 256);

const gif = GIFEncoder();
frames.forEach((f, i) => {
  const index = applyPalette(f.data, palette);
  gif.writeFrame(index, width, height, { palette: i === 0 ? palette : undefined, delay: DELAYS[i] });
});
gif.finish();

const bytes = gif.bytes();
writeFileSync(outPath, bytes);
console.log(`  尺寸   : ${width} × ${height}`);
console.log(`  帧数   : ${frames.length}`);
console.log(`  输出   : ${outPath}`);
console.log(`  大小   : ${(bytes.length / 1024).toFixed(1)} KB`);
