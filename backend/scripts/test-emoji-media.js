/**
 * test-emoji-media.js —— 微信表情消息（MsgType 47）下载解析单测
 *
 * 验证 geweChannel.downloadMedia 的 47 分支：
 *  A. <emoji> 属性 cdnurl 原图直链 HTTP 下载 → kind=image
 *  B. cdnurl 缺省回退 cdnthumburl 缩略图
 *  C. cdnurl 的 &amp; HTML 转义正确解码
 *  D. 后缀推断：gif / png / jpg
 *  E. 无任何直链 → 返回 null（不下载）
 *  F. 非 47（图片/文件）仍走 downloadCdn（不受影响）
 *
 * 运行：node scripts/test-emoji-media.js
 */
const path = require('path');
process.env.GEWE_API = 'http://127.0.0.1:1';   // 47 分支不走 _api，占位即可
process.env.GEWE_CALLBACK_URL = 'http://127.0.0.1:1/cb';

const axios = require('axios');
const { GeweChannel } = require('../wechat/geweChannel.js');

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? '✓' : '❌'} ${name}${detail !== undefined && detail !== '' ? ' → ' + detail : ''}`);
}

(async () => {
  const fakeBytes = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]);
  const origGet = axios.get;
  const downloaded = [];
  axios.get = async (url, opts) => {
    downloaded.push(url);
    return { data: fakeBytes };
  };
  try {
    const ch = new GeweChannel();
    ch.appId = 'wx_test';

    // A. gif 表情：cdnurl 原图直链
    const xmlA = '<msg><emoji fromusername="wxid_a" tousername="wxid_b" type="1" md5="m1" len="100" '
      + 'cdnurl="https://mmtcdn.weixin.qq.com/emotion/1.gif" '
      + 'cdnthumburl="https://mmtcdn.weixin.qq.com/emotion/1_thumb.gif"/></msg>';
    const a = await ch.downloadMedia({ msgType: 47, text: xmlA });
    check('A 47 gif 原图下载', a && a.kind === 'image' && a.mime === 'image/gif'
      && /^emoji_m1\.gif$/.test(a.fileName), a ? `${a.fileName} ${a.mime}` : 'null');

    // B. 无 cdnurl → 回退 cdnthumburl
    const xmlB = '<msg><emoji fromusername="wxid_a" tousername="wxid_b" md5="m2" '
      + 'cdnthumburl="https://mmtcdn.weixin.qq.com/emotion/2_thumb.png"/></msg>';
    const b = await ch.downloadMedia({ msgType: 47, text: xmlB });
    check('B 缺 cdnurl 回退缩略图', b && b.kind === 'image' && b.mime === 'image/png',
      b ? `${b.fileName} ${b.mime}` : 'null');

    // C. cdnurl 含 &amp; 转义 → 解码 & 且后缀推断正确
    const xmlC = '<msg><emoji md5="m3" cdnurl="https://x.qq.com/e/3.gif&amp;type=0"/></msg>';
    const c = await ch.downloadMedia({ msgType: 47, text: xmlC });
    check('C &amp; 转义解码', c && c.mime === 'image/gif'
      && downloaded.some(u => u.includes('&type=0')), c ? c.mime : 'null');

    // D. jpg 后缀
    const xmlD = '<msg><emoji md5="m4" cdnurl="https://x.qq.com/e/4.jpg"/></msg>';
    const d = await ch.downloadMedia({ msgType: 47, text: xmlD });
    check('D jpg 后缀推断', d && d.mime === 'image/jpeg', d ? d.mime : 'null');

    // E. 无 cdnurl / cdnthumburl → null，不下载
    const n0 = downloaded.length;
    const e = await ch.downloadMedia({ msgType: 47, text: '<msg><emoji md5="m5"/></msg>' });
    check('E 无直链返回 null', e === null && downloaded.length === n0, e === null ? 'null ✓' : '非 null');

    // F. 图片（MsgType 3）仍走 downloadCdn：需要 _api → 构造不完整，应抛错而不是走直链下载
    const n1 = downloaded.length;
    let threw = false;
    try { await ch.downloadMedia({ msgType: 3, text: '<img cdnmidimgurl="u" aeskey="k" length="1"/>' }); }
    catch { threw = true; }
    check('F 图片不走表情直链', threw && downloaded.length === n1, threw ? '走 downloadCdn ✓' : '意外');

    const pass = results.filter(Boolean).length;
    console.log(`\n${pass}/${results.length} 通过`);
    process.exit(pass === results.length ? 0 : 1);
  } finally {
    axios.get = origGet;
  }
})();
