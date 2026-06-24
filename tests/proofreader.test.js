const assert = require("assert");
const { buildDiffCorrections, proofreadText } = require("../lib/proofreader");

function assertProofread(input, expected, expectedSources) {
  const output = proofreadText(input);
  assert.strictEqual(output.result, expected);

  for (const source of expectedSources) {
    const correction = output.corrections.find((item) => item.source === source);
    assert.ok(correction, `Expected correction for ${source}`);
    assert.strictEqual(input.slice(correction.start, correction.end), source);
  }

  return output;
}

assertProofread(
  "反映物业不足为，要求物业旅行指责",
  "反映物业不作为，要求物业履行职责",
  ["反映物业不足为", "旅行指责"]
);

assertProofread(
  "今天新情很好，我想去公圆玩。少先队员因该为老人让坐。你找到你最喜欢的工作，我也很高心。",
  "今天心情很好，我想去公园玩。少先队员应该为老人让座。你找到你最喜欢的工作，我也很高兴。",
  ["今天新情", "公圆", "因该为老人让坐", "很高心"]
);

assertProofread(
  "我以经完成了这个按装流程，请在次确认帐号是否登陆成功。",
  "我已经完成了这个安装流程，请再次确认账号是否登录成功。",
  ["以经", "按装", "在次", "帐号", "登陆"]
);

assertProofread(
  "这个问题让我不知所错，他还是一幅漫不经心的样子。",
  "这个问题让我不知所措，他还是一副漫不经心的样子。",
  ["不知所错", "一幅漫不经心"]
);

assertProofread(
  "他说：”我喜欢打蓝球“。这个成语脍灸人口。",
  "他说：“我喜欢打篮球”。这个成语脍炙人口。",
  ["”", "蓝球", "“", "脍灸人口"]
);

const unchanged = proofreadText("今天天气很好，适合出门散步。");
assert.strictEqual(unchanged.result, "今天天气很好，适合出门散步。");
assert.deepStrictEqual(unchanged.corrections, []);

const semanticSource = "反映物业不足为，要求物业旅行指责";
const semanticTarget = "反映物业不作为，要求物业履行职责";
const semanticCorrections = buildDiffCorrections(semanticSource, semanticTarget);
assert.deepStrictEqual(
  semanticCorrections.map((item) => [item.source, item.target, item.start, item.end]),
  [["足", "作", 5, 6], ["旅", "履", 12, 13], ["指", "职", 14, 15]]
);

console.log("proofreader tests passed");
