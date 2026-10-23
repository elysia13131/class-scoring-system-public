import React from 'react'

/**
 * 错误边界：捕获子组件渲染期间的同步错误，避免整个应用白屏。
 * Capacitor WebView 中 JS 抛错会直接白屏，此组件兜底并显示错误信息便于排查。
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] 捕获到渲染错误:', error, errorInfo)
    this.setState({ errorInfo })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    // 尝试回到登录页并清除可能损坏的登录缓存
    try {
      localStorage.removeItem('loginCache')
    } catch (e) {}
    if (typeof location !== 'undefined') {
      location.reload()
    }
  }

  render() {
    if (this.state.hasError) {
      const errStr = this.state.error ? (this.state.error.stack || String(this.state.error)) : '未知错误'
      const infoStr = this.state.errorInfo && this.state.errorInfo.componentStack
        ? String(this.state.errorInfo.componentStack)
        : ''
      return (
        <div style={{
          padding: '24px', fontFamily: 'monospace', fontSize: '13px',
          color: '#7f1d1d', background: '#fef2f2', minHeight: '100vh',
          boxSizing: 'border-box', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
        }}>
          <h2 style={{ fontSize: '18px', marginBottom: '12px' }}>应用遇到错误</h2>
          <p style={{ marginBottom: '12px' }}>已清除登录缓存，点击下方按钮重新加载。</p>
          <pre style={{
            background: '#fff', border: '1px solid #fecaca', padding: '12px',
            borderRadius: '6px', marginBottom: '12px', maxHeight: '40vh', overflow: 'auto'
          }}>
{errStr}
{infoStr}
          </pre>
          <button
            onClick={this.handleReset}
            style={{
              padding: '8px 16px', background: '#2563eb', color: '#fff',
              border: 'none', borderRadius: '6px', fontSize: '14px', cursor: 'pointer'
            }}
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
