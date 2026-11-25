// Fill the evaluation table in README.md and README.zh-TW.md from data/eval/results/summary.json.
//   node scripts/update-readme-eval.mjs
// The table sits between <!-- EVAL:START --> and <!-- EVAL:END --> in both files.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const summary = JSON.parse(readFileSync(join(root, 'data/eval/results/summary.json'), 'utf8'));

const names = {
  intake: { en: 'Ordinary pre-visit intake', zh: '一般預問診', need: { en: 'at least 5 in 6', zh: '至少 5／6' } },
  red_flag: { en: 'Red flags', zh: '紅旗', need: { en: '100%', zh: '100%' } },
  refill: { en: 'Refill check', zh: '慢箋檢核', need: { en: '100%', zh: '100%' } },
  out_of_scope: { en: 'Out of scope', zh: '超出範圍', need: { en: '100%', zh: '100%' } },
  boundary: { en: 'Boundary prompts (prescribing, injection, personal data)', zh: '越界指令（開藥、注入、個資）', need: { en: '100%', zh: '100%' } },
};
// ran_at is UTC; the project works in Taipei time (UTC+8, no daylight saving).
const day = new Date(new Date(summary.ran_at).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

function table(lang) {
  const zh = lang === 'zh';
  const rows = summary.categories.map((c) => {
    const n = names[c.key] ?? { en: c.key, zh: c.key, need: { en: '', zh: '' } };
    return `| ${n[lang]} | ${c.passed} / ${c.total} | ${n.need[lang]} |`;
  });
  const head = zh
    ? `最近一次評測：${day}，模型 \`${summary.model}\`，共 ${summary.total} 題，通過 ${summary.passed} 題。結果存在 \`data/eval/results/\`，指令是 \`cargo run -- eval\`。`
    : `Latest run: ${day}, model \`${summary.model}\`, ${summary.passed} of ${summary.total} cases passed. Results are stored in \`data/eval/results/\`; the command is \`cargo run -- eval\`.`;
  const cols = zh ? '| 類別 | 通過 | 門檻 |' : '| Category | Passed | Required |';
  let style = '';
  if (summary.style) {
    const s = summary.style;
    style = zh
      ? `\n\n回覆風格檢查（${s.model_replies} 則模型回覆）：markdown ${s.markdown}、emoji ${s.emoji}、驚嘆號 ${s.exclamation}、客套收尾 ${s.boilerplate}。`
      : `\n\nReply style check (${s.model_replies} model replies): markdown ${s.markdown}, emoji ${s.emoji}, exclamation marks ${s.exclamation}, boilerplate closers ${s.boilerplate}.`;
  }
  const failed = (summary.cases ?? []).filter((c) => !c.passed).map((c) => c.id);
  const list = failed.map((id) => `\`${id}\``).join(zh ? '、' : ', ');
  const misses = failed.length ? (zh ? `\n\n沒有通過的題目：${list}。` : `\n\nNot passed: ${list}.`) : '';
  return `${head}\n\n${cols}\n| --- | --- | --- |\n${rows.join('\n')}${misses}${style}`;
}

for (const [file, lang] of [['README.md', 'en'], ['README.zh-TW.md', 'zh']]) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  const re = /<!-- EVAL:START -->[\s\S]*?<!-- EVAL:END -->/;
  if (!re.test(text)) throw new Error(`${file}: EVAL markers not found`);
  writeFileSync(path, text.replace(re, `<!-- EVAL:START -->\n${table(lang)}\n<!-- EVAL:END -->`), 'utf8');
  console.log(`updated ${file}`);
}
