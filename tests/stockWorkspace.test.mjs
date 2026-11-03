import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceMode, workspaceCalculation, savedScenarioCalculation } from '../tools/stock-rebound-lab/workspace.mjs';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const price = {high:618.87,low:194,rebound:100,shares:7000};
const wave = {high:618.87,low:190,bPercent:38.2,thirdStart:33.5,thirdEnd:618.87,fourthLow:192,extensionPercent:78.6,shares:7000};

test('三种模式共用结果模型，但保留各自的价格假设', () => {
  const original = structuredClone({price,wave});
  const normal = workspaceCalculation('normal',price,wave);
  const abc = workspaceCalculation('abc',price,wave);
  const fifth = workspaceCalculation('fifth',price,wave);
  near(normal.target,388); near(normal.value,2716000);
  near(abc.target,353.82834); near(abc.value,2476798.38);
  near(fifth.target,652.10082); near(fifth.value,4564705.74);
  assert.deepEqual({price,wave},original);
});

test('路径涨跌幅使用前后价格，ABC回补比例与五浪长度比例不冒充实际涨幅', () => {
  const abc = workspaceCalculation('abc',price,wave), fifth = workspaceCalculation('fifth',price,wave);
  near(abc.drop,190/618.87-1); near(abc.rise,353.82834/190-1);
  near(fifth.drop,192/618.87-1); near(fifth.rise,652.10082/192-1);
  assert.notEqual(abc.rise,.382); assert.notEqual(fifth.rise,.786);
  assert.match(abc.formula,/618.87 − 190/); assert.match(fifth.formula,/618.87 − 33.5/);
});

test('持股数量只影响市值；三种模式均允许零持仓且不把空值当成持仓', () => {
  for (const mode of ['normal','abc','fifth']) {
    const base = workspaceCalculation(mode,price,wave);
    for (const shares of [0,100,'','-1','1.5']) {
      const r=workspaceCalculation(mode,{...price,shares},{...wave,shares});
      near(r.target,base.target);
      if (shares===0 || shares===100) near(r.value,r.target*shares);
      else assert.equal(r.value,null);
    }
  }
});

test('普通涨幅测算不依赖非核心参考高点；无效输入不输出伪目标', () => {
  const r=workspaceCalculation('normal',{...price,high:''});
  assert.equal(r.valid,true); assert.equal(r.high,null); assert.equal(r.drop,null); near(r.target,388);
  assert.equal(workspaceCalculation('normal',{...price,low:''}).valid,false);
  assert.equal(workspaceCalculation('abc',price,{...wave,high:100}).valid,false);
  assert.equal(workspaceCalculation('fifth',price,{...wave,fourthLow:10}).valid,false);
  assert.equal(workspaceCalculation().valid,false);
});

test('旧备份无最近模式或模式未知时回到普通涨幅测算', () => {
  for (const value of [undefined,null,'wave','other','']) assert.equal(workspaceMode(value),'normal');
  near(workspaceCalculation('old-mode',price,wave).target,388);
  assert.equal(workspaceMode('abc'),'abc'); assert.equal(workspaceMode('fifth'),'fifth');
});

test('旧版浪型档案按原始锚点恢复全精度结果，保留附加估值参数', () => {
  const record={params:{low:192,rebound:239.635844,shares:7000,capital:13.95,profit:180},wave:{
    mode:'fifth','wave-third-start':33.5,'wave-third-end':618.87,'wave-fourth-low':192,'wave-fifth-ratio':78.6
  }};
  const original=structuredClone(record),r=savedScenarioCalculation(record);
  near(r.target,652.10082); near(r.value,4564705.74);
  near(r.marketCap,652.10082*13.95); near(r.pe,r.marketCap/180);
  assert.deepEqual(record,original);
  near(savedScenarioCalculation({params:price}).target,388);
});
