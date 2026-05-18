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

    // 配車に関係ないメッセージは無視
    const ignoreList = [
      '運転手を評価したいです',
      'クーポンを使いたいです',
      'カードを登録したいです',
      '予約確認',
      '料金を教えてください',
      '会社の情報を教えてください',
      'よくある質問を教えてください',
      'お知らせ',
      'ご意見・ご感想があります',
    ];
    if (ignoreList.includes(text)) return;

    // 新飯塚駅・鯰田駅の予約は配車処理しない（会社が手動で対応）
    if (text.includes('新飯塚駅') && text.includes('到着します')) return;
    if (text.includes('鯰田駅') && text.includes('到着します')) return;

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
    let navUrl = '';
    lines.forEach(l => {
      // 電話番号（】を除去）
      if (l.includes('TEL：')) {
        customerPhone = (l.split('TEL：')[1] || '').replace(/】.*/, '').trim();
      }
      // 名前
      if (l.includes('】')) {
        customerName = l.split('【')[1]?.split('】')[0]?.split('（')[0]?.trim() || '';
      }
      // 現在地
      if (l.includes('今いる場所')) {
        pickup = '現在地（GPS）';
      }
      // 自宅・施設からの乗車（施設名＋住所を抽出）
      else if (l.includes('に迎え') || l.includes('から乗り') || l.includes('到着')) {
        const m = l.match(/^(.+?)（([^）]+)）/);
        if (m && m[2] !== '住所未登録') {
          const facilityName = m[1].trim();
          const addr = m[2];
          pickup = facilityName ? `${facilityName}（${addr}）` : addr;
        } else {
          pickup = l.replace(/📍.*$/, '').trim();
        }
      }
      // ナビURL（現在地GPS含む）
      if (l.includes('📍ナビ：') || l.includes('📍現在地：')) {
        const url = l.replace('📍ナビ：', '').replace('📍現在地：', '').trim();
        if (url.includes('maps?q=')) {
          const dest = url.split('maps?q=')[1];
          navUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + dest + '&travelmode=driving';
        }
      }
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
        navUrl:        navUrl || '',
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

    // 一次返信なし（乗務員確定後に通知）

    // 30秒後にタイムアウトチェック
    setTimeout(async () => {
      try {
        const checkSnap = await fetch(`${FB_URL}/requests/${requestId}.json`).then(r => r.json());
        if (checkSnap && !checkSnap.assigned) {
          await fetch(`${FB_URL}/requests/${requestId}.json`, { method: 'DELETE' });
          await client.pushMessage(userId, {
            type: 'text',
            text:
              `⚠️ ご不便をおかけして大変申し訳ありません。\n` +
              `ただいま乗務員がすぐに対応できない状況です。\n\n` +
              `お電話にて、受付いたします。\n` +
              `📞 0948-22-0023`,
          });
        }
      } catch(e) { console.error('timeout check error:', e.message); }
    }, 30000);
  }
}

// 乗車完了（ドライバーアプリから呼ばれる）→ Firebaseからリクエストを削除
app.post('/complete', express.json(), async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) return res.json({ ok: false, message: 'requestId がありません' });
  try {
    await fetch(`${FB_URL}/requests/${requestId}.json`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, message: e.message });
  }
});

// 乗務員がOKを押した後の確定処理（ドライバーアプリから呼ばれる）
app.post('/confirm', express.json(), async (req, res) => {
  const { requestId, driverName } = req.body;

  const snap = await fetch(`${FB_URL}/requests/${requestId}.json`).then(r => r.json());
  if (!snap) {
    return res.json({ ok: false, message: 'リクエストが見つかりません' });
  }

  await client.pushMessage(snap.userId, {
    type: 'text',
    text: '配車受付しました。今からお迎えに行きますのでお待ちください。',
  });

  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚖 サーバー起動 port:${PORT}`));
