// 全局错误边界（架构健壮性）
//
// 本应用的数据只存在于用户本机的 localStorage，一旦 React 渲染抛错导致白屏，
// 用户既看不到内容也无法导出——对记账工具是灾难性体验。这里兜住渲染异常：
// 提供「导出抢救备份」与「重试」，并明确告知数据仍在本机。

import { Component, ErrorInfo, ReactNode } from 'react';
import { STORAGE_KEY } from '../storage';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留现场，便于排查（不影响用户）
    console.error('[grid-trading-manager] 渲染异常：', error, info.componentStack);
  }

  private rescue = (): void => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY) ?? '{}';
      const blob = new Blob([raw], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'grid-data-rescue.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch {
      /* 忽略：抢救失败时至少界面仍在 */
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="phone">
        <div className="error-screen">
          <div className="error-icon">🛟</div>
          <h2>界面出现异常</h2>
          <p className="muted">你的网格数据仍安全保存在本机浏览器中，可先导出抢救备份。</p>
          <p className="muted small">{this.state.error.message}</p>
          <button className="btn" onClick={this.rescue}>导出抢救备份</button>
          <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>返回重试</button>
        </div>
      </div>
    );
  }
}
