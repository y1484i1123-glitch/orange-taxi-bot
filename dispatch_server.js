const line    = require('@line/bot-sdk');
const express = require('express');
const fetch   = require('node-fetch');

const config = {
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

// Firebase Realtime Database のURL
const FB_URL = 'https://orange-taxi-iizuka-default-rtdb.asia-southeast1.firebasedatabase.app';

const client = new line.Client(config);
const app    = express();

// ヘルスチェック
app.get('/', (req, res) => res.send('オレンジタクシー配車サーバー稼働中🚖'));

// LINEからのWebhook受信
app.post('/webhook', line.middleware(config), async (req, res) => {
  res.json({ status: 'ok' });
  for (const event of req.body.events) {
    try { await handleEvent(event); } catch (e) { console.error(e.message); }
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text   = event.message.text.trim();
  const source = event.source;

  // お客様からのメッセージ（個人チャット）
  if (source.type === 'user') {
    const userId    = source.userId;

    // ドライバー登録
    if (text === 'ドライバー登録') {
      await fetch(`${FB_URL}/driverLineIds/${userId}.json`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, registeredAt: Date.now() }),
      });
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '✅ ドライバーとして登録しました！\n配車リクエストが来たらLINEでお知らせします。',
      });
      return;
    }

    const requestId = Date.now().toString();
    const timeStr   = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

    // お客様プロフィール取得
    let customerName  = '';
    let customerPhone = '';
    let pickup        = '';

    // メッセージから情報を抽出
    const lines = text.split('\n');
    lines.forEach(l => {
      if (l.includes('TEL：')) customerPhone = l.split('TEL：')[1];
      if (l.includes('】'))    customerName  = l.split('【')[1]?.split('】')[0]?.split('（')[0] || '';
      if (l.includes('に迎え') || l.includes('から乗り') || l.includes('到着')) pickup = l;
    });
    if (!pickup) pickup = lines[1] || lines[0] || text;

    // Firebaseにリクエストを書き込む
    await fetch(`${FB_URL}/requests/${requestId}.json`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        userId,
        message:       text,
        customerName:  customerName  || '（名前未登録）',
        customerPhone: customerPhone || '',
        pickup:        pickup,
        timestamp:     Date.now(),
        time:          timeStr,
        assigned:      false,
      }),
    });

    // 登録済みドライバー全員にLINE通知
    const driversSnap = await fetch(`${FB_URL}/driverLineIds.json`).then(r => r.json());
    if (driversSnap) {
      for (const driverId of Object.keys(driversSnap)) {
        await client.pushMessage(driverId, {
          type: 'text',
          text:
            `🚖 配車リクエストが来ました！\n` +
            `\n` +
            `📍 乗車場所：${pickup}\n` +
            `👤 お客様：${customerName || '（名前未登録）'}\n` +
            (customerPhone ? `📞 電話：${customerPhone}\n` : '') +
            `🕐 時刻：${timeStr}\n` +
            `\n` +
            `乗務員アプリで確認・受付してください。`,
        }).catch(e => console.error('driver push error:', e.message));
      }
    }

    // お客様に受付確認
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        `📨 リクエストを受け付けました！\n` +
        `乗務員が確認次第ご連絡します。\n` +
        `\n` +
        `しばらくお待ちください 🚖\n` +
        `\n` +
        `※お急ぎの場合はお電話ください\n` +
        `📞 0948-22-0023`,
    });

    // 15秒後にタイムアウトチェック
    setTimeout(async () => {
      try {
        const checkSnap = await fetch(`${FB_URL}/requests/${requestId}.json`).then(r => r.json());
        if (checkSnap && !checkSnap.assigned) {
          await client.pushMessage(userId, {
            type: 'text',
            text:
              `⚠️ ご不便をおかけして大変申し訳ありません。\n` +
              `ただいま乗務員がすぐに対応できない状況です。\n\n` +
              `お電話にて配車依頼をしてください。\n` +
              `📞 0948-22-0023`,
          });
        }
      } catch(e) { console.error('timeout check error:', e.message); }
    }, 15000);
  }
}

// 乗務員がOKを押した後の確定処理（ドライバーアプリから呼ばれる）
app.post('/confirm', express.json(), async (req, res) => {
  const { requestId, driverName } = req.body;

  // Firebaseからリクエスト取得
  const snap = await fetch(`${FB_URL}/requests/${requestId}.json`).then(r => r.json());
  if (!snap || snap.assigned) {
    return res.json({ ok: false, message: 'すでに受付済みです' });
  }

  // 割り当て済みに更新
  await fetch(`${FB_URL}/requests/${requestId}.json`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assigned: true, driver: driverName }),
  });

  // お客様にLINEで確定通知
  await client.pushMessage(snap.userId, {
    type: 'text',
    text:
      `✅ 乗務員が決まりました！\n` +
      `\n` +
      `👤 担当：${driverName}\n` +
      `まもなく向かいます 🚖\n` +
      `\n` +
      `※ご不明な点はお電話ください\n` +
      `📞 0948-22-0023`,
  });

  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚖 サーバー起動 port:${PORT}`));
