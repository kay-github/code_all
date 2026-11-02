import test from 'node:test';
import assert from 'node:assert/strict';
import { abcScenario, fifthScenario, ABC_RATIOS } from '../tools/stock-rebound-lab/waves.mjs';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test('截图 ABC：618.87到190，B回补23.6/38.2/50/61.8/78.6%及7000股市值',()=>{
  const expected=[291.21332,353.82834,404.435,455.04166,527.09182];
  ABC_RATIOS.forEach((bPercent,i)=>{const s=abcScenario({high:618.87,low:190,bPercent,shares:7000});assert.equal(s.valid,true);near(s.target,expected[i]);near(s.value,expected[i]*7000);near(s.length,428.87);near(s.drawdown,190/618.87-1);});
});
test('回补前段跌幅38.2%不等于从低点上涨38.2%',()=>{
  const s=abcScenario({high:618.87,low:190,bPercent:38.2});near(s.rise,.8622544210526317);assert.notEqual(s.target,190*1.382);
});
test('ABC可使用自定义比例，0%为低点，100%回到前高',()=>{
  near(abcScenario({high:100,low:50,bPercent:0}).target,50);near(abcScenario({high:100,low:50,bPercent:100}).target,100);near(abcScenario({high:100,low:50,bPercent:120}).target,110);
});
test('C按A价格长度计算；非正目标明确无效而非夹到零',()=>{
  const s=abcScenario({high:618.87,low:190,bPercent:38.2,cPercent:61.8,shares:7000});near(s.cTarget,88.78668);near(s.cValue,88.78668*7000);
  const invalid=abcScenario({high:618.87,low:190,bPercent:38.2,cPercent:100});assert.equal(invalid.valid,true);assert.equal(invalid.cValid,false);assert.equal(invalid.cTarget,null);assert.equal(invalid.cValue,null);assert.match(invalid.cError,/非正价格/);
});
test('截图五浪：33.5到618.87，四浪底192，0.786与1倍为652.10及777.37',()=>{
  const a=fifthScenario({thirdStart:33.5,thirdEnd:618.87,fourthLow:192,extensionPercent:78.6,shares:7000});near(a.length,585.37);near(a.target,652.10082);near(a.value,4564705.74);assert.equal(a.exceedsThird,true);
  near(fifthScenario({thirdStart:33.5,thirdEnd:618.87,fourthLow:192,extensionPercent:100}).target,777.37);
});
test('比例缩放不改变涨跌幅，持股只影响个人市值',()=>{
  const a=abcScenario({high:100,low:40,bPercent:50,shares:100}),b=abcScenario({high:1000,low:400,bPercent:50,shares:7000});near(a.drawdown,b.drawdown);near(a.rise,b.rise);near(b.target,a.target*10);near(b.value,b.target*7000);
});
test('缺失、逆序、非正价格与非法比例不输出伪目标',()=>{
  for(const p of[{high:100,low:0},{high:100,low:120},{high:'',low:50},{high:100,low:50,bPercent:-1},{high:100,low:50,bPercent:Infinity}])assert.equal(abcScenario(p).valid,false);
  for(const p of[{thirdStart:100,thirdEnd:50,fourthLow:80},{thirdStart:10,thirdEnd:100,fourthLow:5},{thirdStart:10,thirdEnd:100,fourthLow:101},{thirdStart:10,thirdEnd:100,fourthLow:50,extensionPercent:''}])assert.equal(fifthScenario(p).valid,false);
});
test('不同股票使用独立锚点，空持仓不冒充实际股数',()=>{
  const stockA=abcScenario({high:618.87,low:190,bPercent:50,shares:7000}),stockB=abcScenario({high:100,low:40,bPercent:50,shares:''});near(stockB.target,70);assert.notEqual(stockA.target,stockB.target);assert.equal(stockB.value,null);
});
