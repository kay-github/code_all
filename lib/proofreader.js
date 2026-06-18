const MAX_TEXT_CHARS = Number(process.env.TYPO_MAX_TEXT_CHARS || "5000");
const PROVIDER = "Vercel Serverless Corrector";
const MODEL = "built-in-chinese-typo-rules";

const PHRASE_RULES = [
  ["少先队员因该", "少先队员应该"],
  ["因该为老人让坐", "应该为老人让座"],
  ["今天新情", "今天心情"],
  ["很高心", "很高兴"],
  ["公圆", "公园"],
  ["新情", "心情"],
  ["高心", "高兴"],
  ["因该", "应该"],
  ["让坐", "让座"],
  ["蓝球", "篮球"],
  ["尊守", "遵守"],
  ["交通规律", "交通规则"],
  ["突飞猛近", "突飞猛进"],
  ["建造工业", "建造工业"],
  ["这洋", "这样"],
  ["报应接中迩来", "报应接踵而来"],
  ["带带相传", "代代相传"],
  ["必竞", "毕竟"],
  ["既使", "即使"],
  ["在次", "再次"],
  ["安照", "按照"],
  ["按装", "安装"],
  ["拔打", "拨打"],
  ["以经", "已经"],
  ["尤如", "犹如"],
  ["密秘", "秘密"],
  ["松驰", "松弛"],
  ["渡假", "度假"],
  ["帐号", "账号"],
  ["登陆", "登录"],
  ["坐位", "座位"],
  ["座车", "坐车"],
  ["再接再励", "再接再厉"],
  ["一如继往", "一如既往"],
  ["迫不急待", "迫不及待"],
  ["金榜提名", "金榜题名"],
  ["甘败下风", "甘拜下风"],
  ["世外桃园", "世外桃源"],
  ["悬梁刺骨", "悬梁刺股"],
  ["走头无路", "走投无路"],
  ["饮鸩解渴", "饮鸩止渴"],
  ["一愁莫展", "一筹莫展"],
  ["脍灸人口", "脍炙人口"],
  ["谈笑风声", "谈笑风生"],
  ["默守成规", "墨守成规"],
  ["明查暗访", "明察暗访"],
  ["融汇贯通", "融会贯通"],
  ["山青水秀", "山清水秀"],
  ["不径而走", "不胫而走"],
  ["再所不惜", "在所不惜"],
  ["各行其事", "各行其是"],
  ["食不裹腹", "食不果腹"],
  ["变本加利", "变本加厉"],
  ["英雄倍出", "英雄辈出"],
  ["冒然行动", "贸然行动"],
  ["怨天由人", "怨天尤人"],
  ["鬼鬼崇崇", "鬼鬼祟祟"],
  ["不能自己", "不能自已"],
  ["出奇不意", "出其不意"],
  ["川流不息", "川流不息"],
  ["黄梁美梦", "黄粱美梦"],
  ["美仑美奂", "美轮美奂"],
  ["坐收鱼利", "坐收渔利"]
];

const SORTED_RULES = PHRASE_RULES
  .filter(([source, target]) => source && source !== target)
  .sort((left, right) => right[0].length - left[0].length);

function applyRule(text, source, target, corrections) {
  let result = text;
  let index = result.indexOf(source);

  while (index !== -1) {
    corrections.push({ source, target, index });
    result = result.slice(0, index) + target + result.slice(index + source.length);
    index = result.indexOf(source, index + target.length);
  }

  return result;
}

function normalizePunctuation(text, corrections) {
  return text.replace(/[“”]{2}/g, (match, index) => {
    corrections.push({ source: match, target: "“”", index });
    return "“”";
  });
}

function proofreadText(text) {
  const corrections = [];
  let result = text;

  for (const [source, target] of SORTED_RULES) {
    result = applyRule(result, source, target, corrections);
  }

  result = normalizePunctuation(result, corrections);

  return {
    result,
    corrections
  };
}

module.exports = {
  MAX_TEXT_CHARS,
  PROVIDER,
  MODEL,
  proofreadText
};
