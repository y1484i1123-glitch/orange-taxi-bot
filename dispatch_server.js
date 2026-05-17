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
