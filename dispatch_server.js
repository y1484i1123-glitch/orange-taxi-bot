require('dotenv').config();
const line    = require('@line/bot-sdk');
const express = require('express');
const fetch   = require('node-fetch');
const crypto  = require('crypto');

const config = {
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

if (!config.channelAccessToken || !config.channelSecret || !process.env.ADMIN_PASS) {
  console.error('❌ 必須環境変数（LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / ADMIN_PASS）が設定されていません');
  process.exit(1);
}

// Firebase Realtime Database のURL
const FB_URL = 'https://orange-taxi-iizuka-default-rtdb.asia-southeast1.firebasedatabase.app';

const client = new line.Client(config);
const app    = express();

// 管理者トークン管理（メモリ内・サーバー再起動でリセット）
const ADMIN_TOKENS = new Set();
const ADMIN_PASS   = process.env.ADMIN_PASS;

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!ADMIN_TOKENS.has(token)) {
    return res.status(403).json({ ok: false, message: '認証が必要です' });
  }
  next();
}

// CORS（Netlifyからのリクエストを許可）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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

  if (source.type === 'user') {
    const userId    = source.userId;

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

    if (text.includes('新飯塚駅') && text.includes('到着します')) return;
    if (text.includes('鯰田駅') && text.includes('到着します')) return;

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

    let customerName  = '';
    let customerPhone = '';
    let pickup        = '';

    const lines = text.split('\n');
    let navUrl = '';
    lines.forEach(l => {
      if (l.includes('TEL：')) {
        customerPhone = (l.split('TEL：')[1] || '').replace(/】.*/, '').trim();
      }
      if (l.includes('】')) {
        customerName = l.split('【')[1]?.split('】')[0]?.split('（')[0]?.trim() || '';
      }
      if (l.includes('今いる場所')) {
        pickup = '現在地（GPS）';
      } else if (l.includes('に迎え') || l.includes('から乗り') || l.includes('到着')) {
        const m = l.match(/^(.+?)（([^）]+)）/);
        if (m && m[2] !== '住所未登録') {
          const facilityName = m[1].trim();
          const addr = m[2];
          pickup = facilityName ? `${facilityName}（${addr}）` : addr;
        } else {
          pickup = l.replace(/📍.*$/, '').trim();
        }
      }
      if (l.includes('📍ナビ：') || l.includes('📍現在地：')) {
        const url = l.replace('📍ナビ：', '').replace('📍現在地：', '').trim();
        if (url.includes('maps?q=')) {
          const dest = url.split('maps?q=')[1];
          navUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + dest + '&travelmode=driving';
        }
      }
    });
    if (!pickup) pickup = lines[1] || lines[0] || text;

    await fetch(`${FB_URL}/requests/${requestId}.json`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId, userId, message: text,
        customerName:  customerName  || '（名前未登録）',
        customerPhone: customerPhone || '',
        pickup, navUrl: navUrl || '',
        timestamp: Date.now(), time: timeStr, assigned: false,
      }),
    });

    const driversSnap = await fetch(`${FB_URL}/driverLineIds.json`).then(r => r.json());
    if (driversSnap) {
      for (const driverId of Object.keys(driversSnap)) {
        await client.pushMessage(driverId, {
          type: 'text',
          text:
            `🚖 配車リクエストが来ました！\n\n` +
            `📍 乗車場所：${pickup}\n` +
            `👤 お客様：${customerName || '（名前未登録）'}\n` +
            (customerPhone ? `📞 電話：${customerPhone}\n` : '') +
            `🕐 時刻：${timeStr}\n\n` +
            `乗務員アプリで確認・受付してください。`,
        }).catch(e => console.error('driver push error:', e.message));
      }
    }

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
              `お電話にて、受付いたします。\n📞 0948-22-0023`,
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

// 乗務員がOKを押した後の確定処理
app.post('/confirm', express.json(), async (req, res) => {
  const { requestId, driverName } = req.body;
  const snap = await fetch(`${FB_URL}/requests/${requestId}.json`).then(r => r.json());
  if (!snap) return res.json({ ok: false, message: 'リクエストが見つかりません' });
  await client.pushMessage(snap.userId, {
    type: 'text',
    text: '配車受付しました。今からお迎えに行きますのでお待ちください。',
  });
  res.json({ ok: true });
});

// ========== 管理者ログイン ==========
app.post('/admin/login', express.json(), (req, res) => {
  if (!req.body || req.body.password !== ADMIN_PASS) {
    return res.status(401).json({ ok: false, message: 'パスワードが違います' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  ADMIN_TOKENS.add(token);
  setTimeout(() => ADMIN_TOKENS.delete(token), 12 * 60 * 60 * 1000);
  res.json({ ok: true, token });
});

// ========== 予約管理 ==========

app.post('/reserve', express.json(), async (req, res) => {
  const { userId, customerName, customerPhone, pickupTime, pickupTimeStr,
          pickupLocation, pickupGate, note } = req.body;

  if (!userId || !pickupTime || !pickupLocation || !customerName) {
    return res.status(400).json({ ok: false, message: '必須項目が不足しています' });
  }

  const now = Date.now();
  const min = now + 30 * 60 * 1000;
  const max = now + 14 * 24 * 60 * 60 * 1000;
  if (pickupTime < min || pickupTime > max) {
    return res.json({ ok: false, message: '予約可能な時間帯は30分後〜2週間先です' });
  }

  const all = await fetch(`${FB_URL}/reservations.json`).then(r => r.json());
  const conflict = Object.values(all || {}).filter(r =>
    (r.status === 'pending' || r.status === 'accepted') &&
    Math.abs(r.pickupTime - pickupTime) < 15 * 60 * 1000
  );
  const configSnap = await fetch(`${FB_URL}/config.json`).then(r => r.json());
  const taxiCount = (configSnap && configSnap.taxiCount) || 1;
  if (conflict.length >= taxiCount) {
    return res.json({ ok: false, reason: 'slot_full',
      message: 'その時間帯は他のご予約があります。別の時間をお選びください。' });
  }

  const reservationId = `R${Date.now()}`;
  await fetch(`${FB_URL}/reservations/${reservationId}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reservationId, userId,
      customerName, customerPhone: customerPhone || '',
      pickupTime, pickupTimeStr: pickupTimeStr || '',
      pickupLocation, pickupGate: pickupGate || '', note: note || '',
      status: 'pending', createdAt: now,
      acceptedAt: null, rejectedAt: null, cancelledAt: null,
      rejectReason: '', handledBy: '',
    }),
  });

  await client.pushMessage(userId, {
    type: 'text',
    text: '📨 予約を承りました。\n会社で確認後、受付完了をお知らせします。\n\nリッチメニューの「予約確認」からステータスを確認できます。',
  }).catch(e => console.error('reserve push error:', e.message));

  res.json({ ok: true, reservationId });
});

app.post('/reserve/cancel', express.json(), async (req, res) => {
  const { reservationId, userId } = req.body;
  if (!reservationId || !userId) return res.status(400).json({ ok: false });

  const r = await fetch(`${FB_URL}/reservations/${reservationId}.json`).then(r => r.json());
  if (!r) return res.status(404).json({ ok: false, message: '予約が見つかりません' });
  if (r.userId !== userId) return res.status(403).json({ ok: false, message: '権限がありません' });
  if (['cancelled', 'completed', 'rejected'].includes(r.status)) {
    return res.json({ ok: false, message: 'すでに ' + r.status + ' のため変更できません' });
  }

  await fetch(`${FB_URL}/reservations/${reservationId}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled', cancelledAt: Date.now() }),
  });
  res.json({ ok: true });
});

app.post('/reserve/accept', express.json(), requireAdmin, async (req, res) => {
  const { reservationId } = req.body;
  const r = await fetch(`${FB_URL}/reservations/${reservationId}.json`).then(r => r.json());
  if (!r) return res.status(404).json({ ok: false });
  if (r.status !== 'pending') {
    return res.json({ ok: false, message: '対応不可：現状 ' + r.status });
  }

  await fetch(`${FB_URL}/reservations/${reservationId}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'accepted', acceptedAt: Date.now() }),
  });

  const gate = r.pickupGate ? ' ' + r.pickupGate : '';
  await client.pushMessage(r.userId, {
    type: 'text',
    text: `✅ ${r.pickupLocation}${gate}、${r.pickupTimeStr} のご予約を受付しました。\n当日お迎えに上がります。\n\nご不明な点はお電話ください\n📞 0948-22-0023`,
  }).catch(e => console.error('accept push error:', e.message));

  res.json({ ok: true });
});

app.post('/reserve/reject', express.json(), requireAdmin, async (req, res) => {
  const { reservationId, reason } = req.body;
  const r = await fetch(`${FB_URL}/reservations/${reservationId}.json`).then(r => r.json());
  if (!r) return res.status(404).json({ ok: false });
  if (r.status !== 'pending') {
    return res.json({ ok: false, message: '対応不可：現状 ' + r.status });
  }

  await fetch(`${FB_URL}/reservations/${reservationId}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected', rejectedAt: Date.now(), rejectReason: reason || '' }),
  });

  await client.pushMessage(r.userId, {
    type: 'text',
    text: `⚠️ 申し訳ございません。\n只今、ご希望の時間帯でのご予約をお受けできません。\n` +
          (reason ? `理由：${reason}\n` : '') +
          `\nお電話でご相談ください\n📞 0948-22-0023`,
  }).catch(e => console.error('reject push error:', e.message));

  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚖 サーバー起動 port:${PORT}`));
