/**
 * 等两帧再截图：视口覆写后布局要重排一次，立刻拍会拍到旧布局。
 */

if (typeof requestAnimationFrame !== 'function') return true;
return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
