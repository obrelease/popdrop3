// アプリに入れる Web ファイルを dist/ にコピーする（Capacitor の webDir）。
// ゲームはビルド不要の素の HTML/CSS/JS なので、必要なものをそのまま集めるだけ。
// sound-test.html などの開発用ファイルはアプリに入れない。
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const ENTRIES = ["index.html", "css", "js", "lib"];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
for (const entry of ENTRIES) {
  fs.cpSync(path.join(root, entry), path.join(dist, entry), { recursive: true });
}
console.log(`dist/ に ${ENTRIES.join(", ")} をコピーしました`);
