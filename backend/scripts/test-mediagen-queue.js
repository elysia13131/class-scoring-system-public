/**
 * test-mediagen-queue.js —— 并发队列行为测试（不依赖真实 Agnes API）
 * 用 fake impl 替换 provider，验证：
 *   1. worker 池并发闸门（默认 2）、FIFO 排队、完成顺序
 *   2. 限流/并发超限错误 → 任务退避后回队尾重试，最终完成（不失败）
 *   3. 视频轮询被限流 → 等待继续轮询，不重复提交
 */
process.env.AGNES_API_KEY = 'test-key'; // 让 enabled=true（不真正调用）
process.env.AGNES_BACKOFF_BASE_MS = '20'; // 限流退避基数调小，加速测试
process.env.AGNES_POLL_RETRY_MS = '30';   // 轮询限流等待调小，加速测试
process.env.AGNES_POLL_INTERVAL = '10';

const assert = require('assert');
const mediaGen = require('../agent/mediaGen');

function makeImpl({ imageLimitHits = 0, pollLimitEvery = 0 } = {}) {
  let activeNow = 0;
  const state = { maxActiveSeen: 0, completed: [], imageHits: 0, pollCount: 0, pollByVideo: {}, submitCount: 0 };
  return {
    state,
    impl: {
      generateImage: async () => {
        activeNow++;
        state.maxActiveSeen = Math.max(state.maxActiveSeen, activeNow);
        state.imageHits++;
        if (state.imageHits <= imageLimitHits) throw Object.assign(new Error('concurrency limit exceeded'), { response: { status: 429 } });
        await new Promise(r => setTimeout(r, 15));
        activeNow--;
        return { filePath: '/tmp/img.png', fileName: 'img.png', mime: 'image/png', size: 1 };
      },
      submitVideo: async () => {
        activeNow++;
        state.maxActiveSeen = Math.max(state.maxActiveSeen, activeNow);
        state.submitCount++;
        await new Promise(r => setTimeout(r, 5));
        activeNow--;
        return { videoId: `v${state.submitCount}`, duration: 5 };
      },
      pollVideo: async (videoId) => {
        state.pollCount++;
        state.pollByVideo[videoId] = (state.pollByVideo[videoId] || 0) + 1;
        if (pollLimitEvery && state.pollCount % pollLimitEvery === 0) throw Object.assign(new Error('rate limited'), { response: { status: 429 } });
        await new Promise(r => setTimeout(r, 5));
        return state.pollByVideo[videoId] >= 3 ? { status: 'completed', metadata: { url: 'http://x/v.mp4' } } : { status: 'in_progress' };
      },
      downloadVideo: async () => ({ filePath: '/tmp/v.mp4', fileName: 'v.mp4', mime: 'video/mp4', size: 1 }),
      ensureVideoThumb: async () => ({ thumbPath: '/tmp/t.jpg', thumbMime: 'image/jpeg' }),
    },
  };
}

async function waitUntil(fn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

(async () => {
  // —— 场景 1：并发闸门 + FIFO 排队（6 个任务，池=2）——
  {
    const { state, impl } = makeImpl();
    const mgr = new mediaGen.MediaGenManager({ impl, onComplete: async (job) => state.completed.push(job.jobId), onError: async () => { throw new Error('不应失败'); } });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(mgr.submit('image', { prompt: `img${i}` }, { memberId: '1' }).jobId);
    for (let i = 0; i < 3; i++) ids.push(mgr.submit('video', { prompt: `vid${i}`, seconds: 5 }, { memberId: '1' }).jobId);

    assert.strictEqual(mgr.active, 2, `启动时应占 2 个槽位，实际 ${mgr.active}`);
    assert.strictEqual(mgr.queue.length, 4, `应有 4 个排队，实际 ${mgr.queue.length}`);

    const ok = await waitUntil(() => state.completed.length === 6 && mgr.queue.length === 0 && mgr.active === 0);
    assert.ok(ok, '6 个任务应在 3s 内全部完成');
    assert.strictEqual(mgr.jobs.size, 0, 'jobs 表应清空');
    assert.ok(state.maxActiveSeen <= 2, `并发峰值应 ≤2，实际 ${state.maxActiveSeen}`);
    assert.deepStrictEqual(state.completed, ids, '完成顺序应与提交顺序一致（FIFO）');
    console.log('PASS 场景1: 并发闸门=2、FIFO 排队、6 任务全部完成');
  }

  // —— 场景 2：生图限流 → 回队尾重试，最终成功不失败 ——
  {
    const { state, impl } = makeImpl({ imageLimitHits: 2 });
    const mgr = new mediaGen.MediaGenManager({ impl, onComplete: async (job) => state.completed.push(job.jobId), onError: async (job, e) => { console.error('FAIL 不应失败:', e.message); process.exit(1); } });
    const job = mgr.submit('image', { prompt: 'x' }, { memberId: '1' });
    const ok = await waitUntil(() => state.completed.length === 1 && mgr.jobs.size === 0);
    assert.ok(ok, '限流后任务应重试成功');
    assert.strictEqual(state.imageHits, 3, '应限流 2 次 + 成功 1 次');
    assert.strictEqual(job.retries, 2, 'retries 应累计 2');
    console.log('PASS 场景2: 429 限流 2 次 → 退避回队 → 第 3 次成功');
  }

  // —— 场景 3：视频轮询限流 → 等待继续轮询（不重复提交）——
  {
    const { state, impl } = makeImpl({ pollLimitEvery: 2 });
    const mgr = new mediaGen.MediaGenManager({ impl, onComplete: async (job) => state.completed.push(job.jobId), onError: async () => { throw new Error('不应失败'); } });
    mgr.submit('video', { prompt: 'y', seconds: 5 }, { memberId: '1' });
    const ok = await waitUntil(() => state.completed.length === 1);
    assert.ok(ok, '视频任务应在轮询限流后仍完成');
    assert.strictEqual(state.submitCount, 1, '视频只应提交 1 次（限流不重复提交）');
    console.log('PASS 场景3: 轮询 429 → 等待续查 → 完成，提交仅 1 次');
  }

  console.log('\nALL PASS');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
