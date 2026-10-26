/**
 * 兼容入口：真正实现在 index.mjs。
 * 有了它，`node server/index.js` 和 `node server/index.mjs` 两种写法都能启动。
 */
import './index.mjs';
