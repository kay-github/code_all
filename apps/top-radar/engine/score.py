# -*- coding: utf-8 -*-
"""R / E / C scoring and 5-tier rule. Same logic as the research engine."""
import numpy as np
import pandas as pd

from config import TIER_ACTION, TIER_NAME


def roll_pct(s, n=252, minp=60):
    return s.rolling(n, min_periods=minp).apply(lambda x: (x[-1] > x[:-1]).mean(), raw=True)


def score(f: pd.DataFrame) -> pd.DataFrame:
    f = f.copy()
    f["crowd"] = f["amt_share"].where(f["amt_share"].notna(), f["amt_ratio60"])
    f["up_avg"] = np.where(f["ret_eq"] > 0, f["ret_eq"], np.nan)
    f["dn_avg"] = np.where(f["ret_eq"] < 0, f["ret_eq"], np.nan)
    f["updn_ratio"] = f["up_avg"].rolling(20, min_periods=5).mean() / (
        -f["dn_avg"].rolling(20, min_periods=5).mean() + 1e-12
    )
    f["eff20"] = f["ret20"] / (f["amt_ratio"].rolling(20).mean() + 1e-12)
    f["ret250"] = f["idx"].pct_change(250)

    f["p_dist60"] = roll_pct(f["dist60"])
    f["p_ret60"] = roll_pct(f["ret60"])
    f["p_ret250"] = roll_pct(f["ret250"])
    f["p_crowd"] = roll_pct(f["crowd"])
    f["p_rsi"] = roll_pct(f["rsi14"])

    f["R"] = (
        f["p_ret250"] * 25 + f["p_ret60"] * 25 + f["p_dist60"] * 20
        + f["p_crowd"] * 15 + f["p_rsi"] * 15
    )
    f["R"] = f["R"].fillna(50)
    f["R_peak20"] = f["R"].rolling(20, min_periods=1).max()

    rsi_peak = f["rsi14"].rolling(60, min_periods=20).max()
    lim_peak = f["limit_up_count"].rolling(60, min_periods=20).max()
    nh_peak = f["newhigh20_ratio"].rolling(60, min_periods=20).max()
    lead_peak = f["leader_excess20"].rolling(60, min_periods=20).max()
    eff_peak = f["eff20"].rolling(60, min_periods=20).max()
    disp_pct = roll_pct(f["disp20"])

    f["E1"] = ((rsi_peak >= 75) & (f["rsi14"] <= rsi_peak - 8)).astype(int)
    f["E2"] = ((lim_peak >= 5) & (f["limit_up_count"] <= lim_peak * 0.5)).astype(int)
    f["E3"] = ((f["idx"] >= f["idx"].rolling(20).max()) & (f["newhigh20_ratio"] <= nh_peak * 0.5)).astype(int)
    f["E4"] = ((lead_peak >= 0.20) & (f["leader_excess20"] <= lead_peak - 0.15)).astype(int)
    f["E5"] = ((eff_peak > 0) & (f["eff20"] <= eff_peak * 0.5)).astype(int)
    f["E6"] = (disp_pct >= 0.90).astype(int)
    f["E7"] = (f["above60_ratio"] < 0.85).astype(int)
    f["E"] = f[["E1", "E2", "E3", "E4", "E5", "E6", "E7"]].sum(axis=1)

    f["C1"] = (f["rebreak20"] == 1).astype(int)
    f["C2"] = (f["rebreak20_20d"] >= 2).astype(int)
    f["C3"] = ((f["ret1_idx"] <= -0.04) & (f["amt_ratio"] >= 1.3)).astype(int)
    f["C4"] = (f["ma20_slope"] < 0).astype(int)
    f["C"] = f[["C1", "C2", "C3", "C4"]].sum(axis=1)

    hot = (
        (rsi_peak >= 85)
        | (lim_peak >= 8)
        | (f["ret60"].rolling(60, min_periods=20).max() >= 0.50)
        | (f["p_crowd"].rolling(60, min_periods=20).max() >= 0.95)
    )
    near = f["dd250"] >= -0.08

    red = (f["R"] >= 75) & hot & near & (f["C"] >= 1)
    red_latch = red.rolling(10, min_periods=1).max().astype(bool)
    deep = red_latch & (f["dd250"] <= -0.08) & (f["C"] >= 1)
    deep_latch = deep.rolling(20, min_periods=1).max().astype(bool)
    orange = (f["R"] >= 70) & hot & near & (~red_latch)
    orange_latch = orange.rolling(10, min_periods=1).max().astype(bool)
    watch = f["R"] >= 55

    f["tier_raw"] = np.select([deep_latch, red_latch, orange_latch, watch], [4, 3, 2, 1], default=0)
    f["tier"] = f["tier_raw"].astype(int)
    f["tier_name"] = f["tier"].map(TIER_NAME)
    f["action"] = f["tier"].map(TIER_ACTION)
    f["red_flag"] = red_latch
    f["deep_flag"] = deep_latch
    f["hot"] = hot
    f["near"] = near

    f["gate_ret250"] = f["p_ret250"] >= 0.80
    f["gate_accel"] = (f["ret60"] > 0) & (f["ma20_slope"] > 0)
    f["gate_hot"] = hot
    f["gate_near"] = near
    f["gate_all"] = f[["gate_ret250", "gate_accel", "gate_hot", "gate_near"]].all(axis=1)

    return f
