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
  ["以经", "已经"],
  ["在次", "再次"],
  ["按装", "安装"],
  ["帐号", "账号"],
  ["登陆", "登录"],
  ["尊守", "遵守"],
  ["交通规律", "交通规则"],
  ["突飞猛近", "突飞猛进"],
  ["建造工业", "建造工业"],
  ["这洋", "这样"],
  ["不知所错", "不知所措"],
  ["不记其数", "不计其数"],
  ["不卑不坑", "不卑不亢"],
  ["不可思义", "不可思议"],
  ["不落巢臼", "不落窠臼"],
  ["惨绝人环", "惨绝人寰"],
  ["察颜观色", "察言观色"],
  ["承上起下", "承上启下"],
  ["出类拔粹", "出类拔萃"],
  ["穿流不息", "川流不息"],
  ["大廷广众", "大庭广众"],
  ["顶力相助", "鼎力相助"],
  ["独挡一面", "独当一面"],
  ["发人深醒", "发人深省"],
  ["返朴归真", "返璞归真"],
  ["防碍", "妨碍"],
  ["费寝忘食", "废寝忘食"],
  ["锋芒必露", "锋芒毕露"],
  ["幅射", "辐射"],
  ["鬼计", "诡计"],
  ["汗流夹背", "汗流浃背"],
  ["合盘托出", "和盘托出"],
  ["轰堂大笑", "哄堂大笑"],
  ["记忆尤新", "记忆犹新"],
  ["坚苦奋斗", "艰苦奋斗"],
  ["娇揉造作", "矫揉造作"],
  ["精兵减政", "精兵简政"],
  ["举一返三", "举一反三"],
  ["决窍", "诀窍"],
  ["开天劈地", "开天辟地"],
  ["克不容缓", "刻不容缓"],
  ["烂竽充数", "滥竽充数"],
  ["老俩口", "老两口"],
  ["流览", "浏览"],
  ["慢不经心", "漫不经心"],
  ["毛骨耸然", "毛骨悚然"],
  ["名列前矛", "名列前茅"],
  ["名符其实", "名副其实"],
  ["呕心历血", "呕心沥血"],
  ["旁证博引", "旁征博引"],
  ["披星带月", "披星戴月"],
  ["签定合同", "签订合同"],
  ["趋之若骛", "趋之若鹜"],
  ["人才倍出", "人才辈出"],
  ["人情事故", "人情世故"],
  ["如火如茶", "如火如荼"],
  ["杀一敬百", "杀一儆百"],
  ["声名雀起", "声名鹊起"],
  ["始终不逾", "始终不渝"],
  ["水笼头", "水龙头"],
  ["随声附合", "随声附和"],
  ["题纲", "提纲"],
  ["天翻地复", "天翻地覆"],
  ["挺而走险", "铤而走险"],
  ["歪风斜气", "歪风邪气"],
  ["委屈求全", "委曲求全"],
  ["无可耐何", "无可奈何"],
  ["相形见拙", "相形见绌"],
  ["消声匿迹", "销声匿迹"],
  ["鸦鹊无声", "鸦雀无声"],
  ["言简意骇", "言简意赅"],
  ["一笔勾消", "一笔勾销"],
  ["英雄气慨", "英雄气概"],
  ["有持无恐", "有恃无恐"],
  ["原形必露", "原形毕露"],
  ["仗义直言", "仗义执言"],
  ["震憾", "震撼"],
  ["支离破粹", "支离破碎"],
  ["直接了当", "直截了当"],
  ["自抱自弃", "自暴自弃"],
  ["作月子", "坐月子"],
  ["一幅漫不经心", "一副漫不经心"],
  ["报应接中迩来", "报应接踵而来"],
  ["带带相传", "代代相传"],
  ["必竞", "毕竟"],
  ["既使", "即使"],
  ["安照", "按照"],
  ["拔打", "拨打"],
  ["尤如", "犹如"],
  ["密秘", "秘密"],
  ["松驰", "松弛"],
  ["渡假", "度假"],
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

function isRangeFree(occupied, start, end) {
  for (let index = start; index < end; index += 1) {
    if (occupied[index]) {
      return false;
    }
  }

  return true;
}

function occupyRange(occupied, start, end) {
  for (let index = start; index < end; index += 1) {
    occupied[index] = true;
  }
}

function addCorrection(corrections, occupied, start, source, target, type) {
  const end = start + source.length;
  if (!source || source === target || start < 0 || !isRangeFree(occupied, start, end)) {
    return;
  }

  corrections.push({
    source,
    target,
    index: start,
    start,
    end,
    type
  });
  occupyRange(occupied, start, end);
}

function collectPhraseCorrections(text, corrections, occupied) {
  for (const [source, target] of SORTED_RULES) {
    let start = text.indexOf(source);

    while (start !== -1) {
      addCorrection(corrections, occupied, start, source, target, "phrase");
      start = text.indexOf(source, start + source.length);
    }
  }
}

function collectPunctuationCorrections(text, corrections, occupied) {
  const quotePattern = /([：:])”([^“”\n]{1,120})“/g;
  let match = quotePattern.exec(text);

  while (match) {
    const openingQuoteIndex = match.index + match[1].length;
    const closingQuoteIndex = openingQuoteIndex + 1 + match[2].length;
    addCorrection(corrections, occupied, openingQuoteIndex, "”", "“", "punctuation");
    addCorrection(corrections, occupied, closingQuoteIndex, "“", "”", "punctuation");
    match = quotePattern.exec(text);
  }
}

function buildCorrectedText(text, corrections) {
  const sorted = [...corrections].sort((left, right) => left.start - right.start);
  let result = "";
  let cursor = 0;

  for (const item of sorted) {
    result += text.slice(cursor, item.start);
    result += item.target;
    cursor = item.end;
  }

  return result + text.slice(cursor);
}

function findDiffPrefix(source, target) {
  const limit = Math.min(source.length, target.length);
  let index = 0;

  while (index < limit && source[index] === target[index]) {
    index += 1;
  }

  return index;
}

function findDiffSuffix(source, target, sourceStart, targetStart) {
  let sourceEnd = source.length;
  let targetEnd = target.length;

  while (sourceEnd > sourceStart && targetEnd > targetStart && source[sourceEnd - 1] === target[targetEnd - 1]) {
    sourceEnd -= 1;
    targetEnd -= 1;
  }

  return { sourceEnd, targetEnd };
}

function buildDiffCorrections(source, target) {
  if (source === target) {
    return [];
  }

  const prefix = findDiffPrefix(source, target);
  const { sourceEnd, targetEnd } = findDiffSuffix(source, target, prefix, prefix);
  const sourcePart = source.slice(prefix, sourceEnd);
  const targetPart = target.slice(prefix, targetEnd);

  if (!sourcePart && !targetPart) {
    return [];
  }

  if (sourcePart.length * targetPart.length > 200000) {
    return [{
      source: sourcePart,
      target: targetPart,
      index: prefix,
      start: prefix,
      end: sourceEnd,
      type: "model"
    }];
  }

  const sourceLength = sourcePart.length;
  const targetLength = targetPart.length;
  const table = Array.from({ length: sourceLength + 1 }, () => Array(targetLength + 1).fill(0));

  for (let sourceIndex = sourceLength - 1; sourceIndex >= 0; sourceIndex -= 1) {
    for (let targetIndex = targetLength - 1; targetIndex >= 0; targetIndex -= 1) {
      table[sourceIndex][targetIndex] = sourcePart[sourceIndex] === targetPart[targetIndex]
        ? table[sourceIndex + 1][targetIndex + 1] + 1
        : Math.max(table[sourceIndex + 1][targetIndex], table[sourceIndex][targetIndex + 1]);
    }
  }

  const corrections = [];
  let sourceIndex = 0;
  let targetIndex = 0;
  let current = null;

  function startCorrection() {
    if (!current) {
      current = {
        source: "",
        target: "",
        index: prefix + sourceIndex,
        start: prefix + sourceIndex,
        end: prefix + sourceIndex,
        type: "model"
      };
    }
  }

  function flushCorrection() {
    if (current && (current.source || current.target)) {
      const prefix = findDiffPrefix(current.source, current.target);
      const { sourceEnd, targetEnd } = findDiffSuffix(current.source, current.target, prefix, prefix);
      const sourcePart = current.source.slice(prefix, sourceEnd);
      const targetPart = current.target.slice(prefix, targetEnd);

      if (sourcePart || targetPart) {
        corrections.push({
          source: sourcePart,
          target: targetPart,
          index: current.start + prefix,
          start: current.start + prefix,
          end: current.start + sourceEnd,
          type: "model"
        });
      }
    }

    current = null;
  }

  while (sourceIndex < sourceLength || targetIndex < targetLength) {
    if (sourceIndex < sourceLength && targetIndex < targetLength && sourcePart[sourceIndex] === targetPart[targetIndex]) {
      flushCorrection();
      sourceIndex += 1;
      targetIndex += 1;
    } else if (targetIndex < targetLength && (sourceIndex === sourceLength || table[sourceIndex][targetIndex + 1] >= table[sourceIndex + 1]?.[targetIndex])) {
      startCorrection();
      current.target += targetPart[targetIndex];
      targetIndex += 1;
    } else if (sourceIndex < sourceLength) {
      startCorrection();
      current.source += sourcePart[sourceIndex];
      sourceIndex += 1;
      current.end = prefix + sourceIndex;
    }
  }

  flushCorrection();
  return corrections;
}

function proofreadText(text) {
  const corrections = [];
  const occupied = Array.from({ length: text.length }, () => false);

  collectPhraseCorrections(text, corrections, occupied);
  collectPunctuationCorrections(text, corrections, occupied);
  corrections.sort((left, right) => left.start - right.start);

  return {
    result: buildCorrectedText(text, corrections),
    corrections
  };
}

module.exports = {
  MAX_TEXT_CHARS,
  PROVIDER,
  MODEL,
  buildDiffCorrections,
  proofreadText
};
