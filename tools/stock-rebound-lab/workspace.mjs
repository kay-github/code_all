import { finite, simulate } from './analysis.mjs';
import { abcScenario, fifthScenario } from './waves.mjs';

export const workspaceMode = value => ['normal','abc','fifth'].includes(value) ? value : 'normal';

// One result model for the three existing calculators; their saved inputs stay independent.
export function workspaceCalculation(mode, price = {}, wave = {}) {
  mode = workspaceMode(mode);
  if (mode === 'normal') {
    if (!finite(price.low) || Number(price.low) <= 0 || !finite(price.rebound) || Number(price.rebound) < 0) return {valid:false,error:'请填写大于零的假设低点及非负反弹涨幅'};
    const s = simulate(price), high = finite(price.high) && Number(price.high) > 0 ? Number(price.high) : null;
    const value = finite(price.shares) && Number(price.shares) >= 0 && Number.isInteger(Number(price.shares)) ? s.value : null;
    return {...s,value,valid:true,high,low:Number(price.low),drop:high ? Number(price.low)/high-1 : null,rise:Number(price.rebound)/100,
      labels:['参考高点','假设低点','反弹目标'],formula:`${price.low} × (1 + ${price.rebound}%)`};
  }
  const s = mode === 'fifth' ? fifthScenario(wave) : abcScenario(wave);
  if (!s.valid) return s;
  const fifth = mode === 'fifth', high = Number(fifth ? wave.thirdEnd : wave.high), low = Number(fifth ? wave.fourthLow : wave.low);
  return {...s,high,low,drop:low/high-1,labels:fifth?['三浪终点','假设四浪底','五浪目标']:['A 浪起点','假设 A 浪终点','B 浪目标'],
    formula:fifth?`${wave.fourthLow} + (${wave.thirdEnd} − ${wave.thirdStart}) × ${wave.extensionPercent}%`:`${wave.low} + (${wave.high} − ${wave.low}) × ${wave.bPercent}%`};
}

// v1 archives keep the original wave fields alongside ordinary price parameters.
export function savedScenarioCalculation({params = {}, wave}) {
  if (!wave) return simulate(params);
  const result = workspaceCalculation(wave.mode === 'fifth' ? 'fifth' : 'abc', {}, {
    high:wave['wave-high'],low:wave['wave-low'],bPercent:wave['wave-b-ratio'],
    thirdStart:wave['wave-third-start'],thirdEnd:wave['wave-third-end'],
    fourthLow:wave['wave-fourth-low'],extensionPercent:wave['wave-fifth-ratio'],shares:params.shares
  });
  return result.valid ? {...simulate({...params,low:result.target,rebound:0}),value:result.value} : simulate(params);
}
