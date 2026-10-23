import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import * as echarts from 'echarts';

const ChartRenderer = forwardRef(({ config, style = {}, height = 350, showExport = false }, ref) => {
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const [error, setError] = useState(null);
  const [exportStatus, setExportStatus] = useState(null);

  const ensureInstance = () => {
    if (chartInstance.current) return chartInstance.current;
    if (chartRef.current) {
      try {
        chartInstance.current = echarts.getInstanceByDom(chartRef.current) || echarts.init(chartRef.current);
        return chartInstance.current;
      } catch (e) {
        console.error('Failed to get chart instance:', e);
        return null;
      }
    }
    return null;
  };

  useImperativeHandle(ref, () => ({
    exportPNG: () => handleExportPNG(),
    exportSVG: () => handleExportSVG(),
    getInstance: () => ensureInstance()
  }));

  useEffect(() => {
    if (!chartRef.current || !config) return;

    try {
      const existing = echarts.getInstanceByDom(chartRef.current);
      if (existing) {
        chartInstance.current = existing;
      } else if (!chartInstance.current) {
        chartInstance.current = echarts.init(chartRef.current);
      }

      chartInstance.current.setOption(config, true);
      setError(null);

      const handleResize = () => {
        try { chartInstance.current?.resize(); } catch(e) {}
      };

      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    } catch (err) {
      console.error('Chart render error:', err);
      setError(err.message);
    }
  }, [config]);

  useEffect(() => {
    return () => {
      try {
        if (chartRef.current) {
          const inst = echarts.getInstanceByDom(chartRef.current);
          inst?.dispose();
        }
      } catch(e) {}
      chartInstance.current = null;
    };
  }, []);

  const showExportFeedback = (success, format) => {
    setExportStatus(success ? `${format} 导出成功！` : `${format} 导出失败`);
    setTimeout(() => setExportStatus(null), 2500);
  };

  const handleExportPNG = () => {
    const instance = ensureInstance();
    if (!instance) {
      showExportFeedback(false, 'PNG');
      return;
    }

    try {
      const dataURL = instance.getDataURL({
        type: 'png',
        pixelRatio: 2,
        backgroundColor: '#fff'
      });

      const link = document.createElement('a');
      link.href = dataURL;
      const title = config?.title?.text || 'chart';
      link.download = `${title}_${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showExportFeedback(true, 'PNG');
    } catch (err) {
      console.error('Export PNG error:', err);
      showExportFeedback(false, 'PNG');
    }
  };

  const handleExportSVG = () => {
    const instance = ensureInstance();
    if (!instance) {
      showExportFeedback(false, 'SVG');
      return;
    }

    try {
      const dataURL = instance.getDataURL({
        type: 'svg',
        backgroundColor: '#fff'
      });

      if (dataURL.startsWith('data:image/svg+xml')) {
        const svgContent = decodeURIComponent(dataURL.split(',')[1]);
        const blob = new Blob([svgContent], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const title = config?.title?.text || 'chart';
        link.download = `${title}_${Date.now()}.svg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showExportFeedback(true, 'SVG');
      } else {
        showExportFeedback(false, 'SVG');
      }
    } catch (err) {
      console.error('Export SVG error:', err);
      showExportFeedback(false, 'SVG');
    }
  };

  if (!config) {
    return (
      <div className="bg-gray-100 rounded-lg flex items-center justify-center text-gray-400"
           style={{ width: '100%', height: height || 300, ...style }}>
        <span className="text-sm">暂无图表数据</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 rounded-lg p-4" style={{ width: '100%', height: height || 300, ...style }}>
        <p className="text-red-600 text-sm text-center">图表渲染错误: {error}</p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={chartRef}
        className="echart-container bg-white rounded-xl shadow-sm border border-gray-100"
        style={{ width: '100%', height: height || 350, ...style }}
      />

      {showExport && (
        <div className="absolute top-2 right-2 flex gap-1.5" style={{ zIndex: 10 }}>
          <button
            onClick={handleExportPNG}
            className="px-2.5 py-1 bg-white/95 hover:bg-white text-gray-600 hover:text-indigo-600 rounded-lg text-xs font-medium shadow-sm border border-gray-200 hover:border-indigo-300 transition flex items-center gap-1 cursor-pointer"
            title="导出为PNG图片"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            导出图片
          </button>
          <button
            onClick={handleExportSVG}
            className="px-2.5 py-1 bg-white/95 hover:bg-white text-gray-600 hover:text-indigo-600 rounded-lg text-xs font-medium shadow-sm border border-gray-200 hover:border-indigo-300 transition flex items-center gap-1 cursor-pointer"
            title="导出为SVG矢量图"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            SVG
          </button>
        </div>
      )}

      {exportStatus && (
        <div className={`absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all ${exportStatus.includes('成功') ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`} style={{ zIndex: 10 }}>
          {exportStatus.includes('成功') ? '✓' : '✗'} {exportStatus}
        </div>
      )}
    </div>
  );
});

ChartRenderer.displayName = 'ChartRenderer';

export default ChartRenderer;
