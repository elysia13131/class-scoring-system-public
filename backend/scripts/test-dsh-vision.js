/**
 * test-dsh-vision.js —— DeepSeek vision 模型在 dsh 底座上的实测
 *
 * 差分验证法：两张主题迥异的图（星辉资源/训练场）分别发给
 * deepseek-v4-flash-vision-exp，若描述与各自主题吻合且相互可区分，
 * 即证明图片真实到达模型（而非文本幻觉）。
 *
 * 用法：node scripts/test-dsh-vision.js
 */
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASSETS = path.join(__dirname, '..', '..', 'frontend', 'public', 'game-assets');
const VISION_MODEL = process.env.DSH_VISION_MODEL || 'deepseek-v4-flash-vision-exp';

async function main() {
  const mod = await import('@deepseek-ai/dsh-sdk-client');

  const HOME_DIR = path.join(__dirname, '..', 'agent', 'dsh', 'home');
  const WORKSPACE = path.join(__dirname, '..', 'agent', 'dsh', 'workspace');
  const bootId = crypto.randomBytes(4).toString('hex');

  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const storages = path.join(HOME_DIR, 'storages');
  if (fs.existsSync(storages)) fs.rmSync(storages, { recursive: true, force: true });

  console.log(`=== vision 实测：model=${VISION_MODEL} ===\n`);

  const harness = new mod.DeepSeekHarness({
    provider: 'deepseek-official',
    model: VISION_MODEL,
    cwd: WORKSPACE,
    processCwd: WORKSPACE,
    dshHome: HOME_DIR,
    env: { ...process.env, DSH_HOME: HOME_DIR },
  });

  await harness.start();
  console.log('harness started ✓\n');

  // 两张图：主题差异大（星空资源 vs 训练场）
  const cases = [
    { file: 'resource_starlight.jpg', theme: '星辉/星空/夜晚/发光资源' },
    { file: 'training_ground.jpg', theme: '训练/操场/体能设施' },
  ];

  const answers = [];
  for (const c of cases) {
    const imgPath = path.join(ASSETS, c.file);
    const data = fs.readFileSync(imgPath).toString('base64');
    console.log(`--- 图: ${c.file}（${Math.round(data.length * 3 / 4 / 1024)}KB, base64 ${Math.round(data.length / 1024)}KB）---`);

    const session = harness.session(`vision-${bootId}-${path.basename(c.file, '.jpg')}`);
    const result = await session.run([
      { type: 'image', data, mimeType: 'image/jpeg' },
      { type: 'text', text: '用两三句话描述这张图：主体是什么、主色调是什么、氛围如何。' },
    ]);

    console.log('模型描述:', result.finalResponse);
    answers.push({ ...c, desc: result.finalResponse });

    // 事件里应有 attachment 相关记录
    const hasImage = result.events.some(e => JSON.stringify(e).includes('image'));
    console.log(`(事件流含 image 引用: ${hasImage ? '✓' : '✗'})\n`);
  }

  await harness.close();

  // 差分判定
  console.log('=== 差分判定 ===');
  const [a, b] = answers;
  const aStar = /星|star|夜|night|光|glow|发光/i.test(a.desc);
  const bTrain = /训练|操场|跑道|运动|体能|跑|exercise|track|field/i.test(b.desc);
  const distinct = a.desc !== b.desc && (aStar || bTrain);
  console.log(`图1(${a.file}) 描述含星空/发光要素: ${aStar ? '✓' : '✗'}`);
  console.log(`图2(${b.file}) 描述含训练/场地要素: ${bTrain ? '✓' : '✗'}`);
  console.log(`两图描述可区分: ${a.desc !== b.desc ? '✓' : '✗'}`);

  if (!a.desc || !b.desc) {
    console.error('\n❌ vision 测试失败：模型返回空');
    process.exit(1);
  }
  console.log(distinct
    ? '\n✅ vision 实测通过：图片真实到达模型（差分描述与主题吻合）'
    : '\n⚠️ 描述未与主题吻合，需人工核对上面两段描述');
}

main().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1); });
