// 品种配置页（移动端）：表单 + 网卡片编辑器 + 可折叠预览 + 校验

import { useMemo, useState } from 'react';
import { Net, NetType, Variety } from '../engine/types';
import { expandRows, orphanJournalIds, stepToBp } from '../engine/engine';
import { fmtPct, fmtScaled, PRICE_SCALE } from '../engine/money';
import { validateNets, validateVarietyBase, netWarnings } from '../engine/validation';
import { Dialog, Sheet } from './ui';

interface Props {
  variety: Variety;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  existingNames: string[];
  onBack: () => void;
  onSave: (v: Variety) => void;
}

const NET_TYPES: NetType[] = ['小网', '中网', '大网'];

export default function ConfigPage({ variety, theme, onToggleTheme, existingNames, onBack, onSave }: Props) {
  const [name, setName] = useState(variety.name);
  const [code, setCode] = useState(variety.code);
  const [base, setBase] = useState(variety.basePrice === null ? '' : String(variety.basePrice));
  const [stepPct, setStepPct] = useState(String(Math.round(variety.gridStep * 10000) / 100));
  const [nets, setNets] = useState<Net[]>(JSON.parse(JSON.stringify(variety.nets)));
  const [journal, setJournal] = useState<Record<string, { buyQty: number; sellQty: number }>>({ ...variety.journal });
  const [quoteUrl, setQuoteUrl] = useState(variety.quoteUrl ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [delIndex, setDelIndex] = useState<number | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const stepNum = Number(stepPct) / 100;
  const stepOk = Number.isFinite(stepNum) && stepNum > 0;
  const bp = stepToBp(stepOk ? stepNum : 0.02);
  const netErrors = useMemo(() => validateNets(nets), [nets]);
  const netWarns = useMemo(() => netWarnings(nets, bp), [nets, bp]);
  const orphans = useMemo(() => orphanJournalIds({ ...variety, nets }), [variety, nets]);

  const preview = useMemo(() => {
    const bpv = base.trim() === '' ? null : Number(base);
    return expandRows({ ...variety, basePrice: bpv ?? 1, gridStep: stepOk ? stepNum : 0.02, nets });
  }, [base, stepOk, stepNum, nets, variety]);

  const patchNet = (i: number, patch: Partial<Net>) => {
    setNets((ns) => ns.map((n, j) => (j === i ? { ...n, ...patch } : n)));
  };
  const moveNet = (i: number, dir: -1 | 1) => {
    setNets((ns) => {
      const j = i + dir;
      if (j < 0 || j >= ns.length) return ns;
      const copy = [...ns];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  };
  const dupNet = (i: number) => setNets((ns) => [...ns.slice(0, i + 1), { ...ns[i] }, ...ns.slice(i + 1)]);
  const delNet = (i: number) => setNets((ns) => (ns.length > 1 ? ns.filter((_, j) => j !== i) : ns));
  const addNet = () =>
    setNets((ns) => {
      const last = ns[ns.length - 1];
      const start = last ? last.endGrid + 1 : 0;
      return [...ns, { type: '中网', startGrid: start, endGrid: start + 5, anchorGrid: last ? 0 : null }];
    });

  const errorFor = (i: number, field: 'start' | 'end' | 'anchor') =>
    netErrors.find((e) => e.netIndex === i && e.field === field)?.message ?? null;

  const doSave = () => {
    const baseNum = base.trim() === '' ? null : Number(base);
    const errs = validateVarietyBase({ name, code, basePrice: baseNum, gridStep: stepNum, excludeName: variety.name, existingNames });
    if (netErrors.length > 0) errs.push('网结构存在校验错误，请修正后保存');
    if (errs.length > 0) { setErrors(errs); return; }
    const normalized = nets.map((n, i) => ({ ...n, anchorGrid: i === 0 ? null : (n.anchorGrid ?? 0) }));
    onSave({ ...variety, name: name.trim(), code: code.trim(), basePrice: baseNum, gridStep: stepNum, nets: normalized, journal, quoteUrl: quoteUrl.trim() || null });
  };

  return (
    <div className="phone stack-page">
      <header className="navbar">
        <button className="icon-btn" aria-label="返回" onClick={onBack}>‹</button>
        <div className="navbar-title">
          <h2>网格配置</h2>
          <span className="muted small">{variety.name}</span>
        </div>
        <button className="icon-btn" aria-label="切换浅色/深色" onClick={onToggleTheme}>{theme === 'dark' ? '☀️' : '🌙'}</button>
        <button className="btn btn-mini btn-primary" onClick={doSave}>保存</button>
      </header>

      <div className="page">
        {errors.length > 0 && (
          <ul className="error-list banner-error">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        )}

        <section className="group-block">
          <h4 className="group-title">基本信息</h4>
          <div className="field-list">
            <label className="field">
              <span>品种名称 *</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>标的代码</span>
              <input className="input" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" />
            </label>
            <label className="field">
              <span>基准价（源表 C2）</span>
              <input className="input" value={base} onChange={(e) => setBase(e.target.value)} inputMode="decimal" placeholder="留空表示暂不设置" />
            </label>
            <label className="field">
              <span>行情源 URL（FR-09，可选）</span>
              <input className="input" value={quoteUrl} onChange={(e) => setQuoteUrl(e.target.value)} placeholder="留空=手动标注当前价" />
              <em className="field-hint">返回当前价的接口（JSON 含 price/last/f43，或纯文本含数值）。浏览器受 CORS 限制，请填「允许跨域」的地址（如自建代理）。</em>
            </label>
            <label className="field">
              <span>网格步长 % *</span>
              <input className="input" value={stepPct} onChange={(e) => setStepPct(e.target.value)} inputMode="decimal" />
            </label>
          </div>
        </section>

        <section className="group-block">
          <div className="group-head-row">
            <h4 className="group-title">网结构（{preview.length} 档）</h4>
            <button className="btn btn-mini" onClick={addNet}>＋ 添加网</button>
          </div>
          <p className="muted small">档位 = 档数 × 步长（当前步长 {fmtPct(bp)}）</p>

          {netWarns.length > 0 && (
            <div className="banner banner-warn" style={{ margin: '0 0 10px' }} role="alert">
              <span>
                ⚠️ {netWarns[0].message}
                {netWarns.length > 1 ? `（共 ${netWarns.length} 处越界）` : ''} —— 不阻断保存，请自行确认是否合理
              </span>
            </div>
          )}

          {nets.map((n, i) => {
            const errS = errorFor(i, 'start');
            const errE = errorFor(i, 'end');
            const errA = errorFor(i, 'anchor');
            const errG = netErrors.find((e) => e.netIndex === i && e.field === 'general')?.message ?? null;
            const rows = Math.max(0, n.endGrid - n.startGrid) + 1;
            return (
              <div className={'net-item net-item-' + n.type} key={i}>
                <div className="net-item-top">
                  <span className={'net-pill net-' + n.type}>{n.type}</span>
                  <span className="muted small">
                    第 {i + 1} 网 ·{' '}
                    {Number.isInteger(n.startGrid) && Number.isInteger(n.endGrid)
                      ? `${fmtPct(n.startGrid * bp)} ~ ${fmtPct(n.endGrid * bp)}`
                      : '—'}{' '}
                    · {Number.isInteger(n.startGrid) && Number.isInteger(n.endGrid) && n.startGrid <= n.endGrid ? rows : '?'} 档
                  </span>
                  <span className="net-ops">
                    <button className="icon-btn" aria-label="上移" onClick={() => moveNet(i, -1)}>↑</button>
                    <button className="icon-btn" aria-label="下移" onClick={() => moveNet(i, 1)}>↓</button>
                    <button className="icon-btn" aria-label="复制" onClick={() => dupNet(i)}>⧉</button>
                    <button className="icon-btn" aria-label="删除" onClick={() => setDelIndex(i)} disabled={nets.length <= 1}>✕</button>
                  </span>
                </div>
                <div className="net-item-body">
                  <label className="field half">
                    <span>起始档数</span>
                    <input
                      className={'input' + (errS ? ' invalid' : '')}
                      type="number" inputMode="numeric" min={0}
                      value={Number.isNaN(n.startGrid) ? '' : n.startGrid}
                      onChange={(e) => patchNet(i, { startGrid: e.target.value === '' ? NaN : Number(e.target.value) })}
                    />
                    {errS && <em className="field-error">{errS}</em>}
                  </label>
                  <label className="field half">
                    <span>结束档数</span>
                    <input
                      className={'input' + (errE ? ' invalid' : '')}
                      type="number" inputMode="numeric" min={0}
                      value={Number.isNaN(n.endGrid) ? '' : n.endGrid}
                      onChange={(e) => patchNet(i, { endGrid: e.target.value === '' ? NaN : Number(e.target.value) })}
                    />
                    {errE && <em className="field-error">{errE}</em>}
                  </label>
                </div>
                <div className="net-item-anchor">
                  {i === 0 ? (
                    <span className="muted small">首网无锚点 —— 首档行卖出价 = 基准价 × (1 + 步长)</span>
                  ) : (
                    <label className="field">
                      <span>锚点档数（卖出目标）</span>
                      <select
                        className="input"
                        value={n.anchorGrid ?? ''}
                        onChange={(e) => patchNet(i, { anchorGrid: Number(e.target.value) })}
                      >
                        {Array.from({ length: Math.max(0, n.startGrid) }, (_, g) => (
                          <option key={g} value={g}>{g} 档（{fmtPct(g * bp)}）</option>
                        ))}
                      </select>
                      {errA && <em className="field-error">{errA}</em>}
                    </label>
                  )}
                </div>
                {errG && <em className="field-error">{errG}</em>}
              </div>
            );
          })}

          {orphans.length > 0 && (
            <div className="banner banner-warn">
              <span>{orphans.length} 条录入数据不再对应任何行（孤儿数据，不参与计算）</span>
              <button className="btn btn-mini" onClick={() => {
                const j = { ...journal };
                orphans.forEach((k) => delete j[k]);
                setJournal(j);
              }}>清理</button>
            </div>
          )}
        </section>

        <section className="group-block">
          <div className="group-head-row">
            <h4 className="group-title">预览</h4>
            <button className="btn btn-mini" onClick={() => setShowPreview(!showPreview)}>
              {showPreview ? '收起' : `展开（${preview.length} 档）`}
            </button>
          </div>
          {showPreview && (
            <>
              <p className="muted small">{base.trim() === '' ? '未设基准价，按 1 预览' : `基准价 ${base}`}</p>
              <div className="preview-list">
                {preview.map((r) => (
                  <div className="preview-row" key={r.rowId}>
                    <span className={'net-pill net-' + r.netType}>{r.netType}</span>
                    <span className="level">{fmtPct(r.levelBp)}{r.sellRule === 'anchor' ? '⚓' : ''}</span>
                    <span className="muted small">买 {fmtScaled(r.buyU4, PRICE_SCALE, 4)}</span>
                    <span className="muted small">卖 {fmtScaled(r.sellU4, PRICE_SCALE, 4)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {delIndex !== null && (
        <Dialog title="删除网" onClose={() => setDelIndex(null)}>
          <h3>删除网</h3>
          <p>删除第 {delIndex! + 1} 个网后，其覆盖档位的录入数据将变为孤儿数据（不参与计算，可清理）。</p>
          <div className="sheet-actions">
            <button className="btn" onClick={() => setDelIndex(null)}>取消</button>
            <button className="btn btn-danger" onClick={() => { delNet(delIndex!); setDelIndex(null); }}>确认删除</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
