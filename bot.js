import * as Misskey from 'misskey-js';
import Database from 'better-sqlite3';
// import { WebSocket } from 'ws';
import pkg from 'ws';
const WebSocket = pkg.WebSocket || pkg.default || pkg;

global.WebSocket = WebSocket;

const MISSKEY_URL = process.env.MISSKEY_URL;
const MISSKEY_TOKEN = process.env.MISSKEY_TOKEN;

// Misskey接続
const cli = new Misskey.api.APIClient({
  origin: MISSKEY_URL,
  credential: MISSKEY_TOKEN,
});

const stream = new Misskey.Stream(MISSKEY_URL, {
  token: MISSKEY_TOKEN,
  // WebSocket: ws.WebSocket || ws
});

// Bot自身のユーザーID取得
let botUserId;
cli.request('i').then((res) => {
  botUserId = res.id;
  console.log(`Bot user ID: ${botUserId}`);
});

// SQLiteデータベース初期化
const db = new Database('./data/database.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS logbo_records (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    total_days INTEGER DEFAULT 0,
    consecutive_days INTEGER DEFAULT 0,
    last_logbo_date TEXT
  )
`);

// JST朝5時基準の日付を取得
function getLogboDate() {
  const now = new Date();
  // 日本時間に変換（UTC+9）
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstTime = new Date(now.getTime() + jstOffset);

  // 5時間引いて日付判定（朝5時切り替え）
  jstTime.setHours(jstTime.getHours() - 5);

  // YYYY-MM-DD形式で返す
  return jstTime.toISOString().split('T')[0];
}

// フォロワーかどうかチェック
async function isFollower(userId) {
  try {
    const relation = await cli.request('users/relation', { userId: [userId] });
    return relation[0]?.isFollowing || false; // ユーザーがbotをフォローしているか
  } catch (error) {
    console.error('Failed to check follower status:', error);
    return false;
  }
}

// フォロー機能
async function followUser(userId) {
  try {
    await cli.request('following/create', { userId });
    console.log(`Followed user: ${userId}`);
  } catch (error) {
    console.error('Failed to follow user:', error);
  }
}

// ログボ記録処理
function recordLogbo(userId, username) {
  const today = getLogboDate();
  const record = db.prepare('SELECT * FROM logbo_records WHERE user_id = ?').get(userId);

  if (!record) {
    // 初回ログボ
    db.prepare('INSERT INTO logbo_records (user_id, username, total_days, consecutive_days, last_logbo_date) VALUES (?, ?, 1, 1, ?)').run(userId, username, today);
    return { total: 1, consecutive: 1, alreadyDone: false };
  }

  if (record.last_logbo_date === today) {
    // 今日既にログボ済み
    return { total: record.total_days, consecutive: record.consecutive_days, alreadyDone: true };
  }

  // 前回のログボ日との差分計算
  const lastDate = new Date(record.last_logbo_date + 'T00:00:00Z');
  const todayDate = new Date(today + 'T00:00:00Z');
  const diffDays = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));

  if (diffDays === 1) {
    // 連続ログボ
    const newTotal = record.total_days + 1;
    const newConsecutive = record.consecutive_days + 1;
    db.prepare('UPDATE logbo_records SET username = ?, total_days = ?, consecutive_days = ?, last_logbo_date = ? WHERE user_id = ?')
      .run(username, newTotal, newConsecutive, today, userId);
    return { total: newTotal, consecutive: newConsecutive, alreadyDone: false };
  } else {
    // 連続途切れた
    const newTotal = record.total_days + 1;
    db.prepare('UPDATE logbo_records SET username = ?, total_days = ?, consecutive_days = 1, last_logbo_date = ? WHERE user_id = ?')
      .run(username, newTotal, today, userId);
    return { total: newTotal, consecutive: 1, alreadyDone: false };
  }
}

// ランキング取得
function getRanking() {
  const ranking = db.prepare(`
    SELECT username, consecutive_days, total_days
    FROM logbo_records
    ORDER BY consecutive_days DESC, total_days DESC
    LIMIT 10
  `).all();

  if (ranking.length === 0) {
    return '現在、ログインボーナスのデータはございません。';
  }

  let rankingText = '📊 **連続ログインボーナス ランキング TOP 10**\n\n';
  ranking.forEach((record, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}. `;
    rankingText += `${medal} @${record.username}\n`;
    rankingText += `   連続: ${record.consecutive_days}日 / 合計: ${record.total_days}日\n\n`;
  });

  return rankingText;
}

// タイムライン監視
// note: botが未フォローの人のメンションを拾うため、hybridTimeline推奨
const timelineChannel = stream.useChannel('hybridTimeline');

timelineChannel.on('note', async (note) => {
  const text = note.text || '';
  const userId = note.userId;
  const username = note.user.username;

  // 自分の投稿は無視
  if (userId === botUserId) return;

  // 「follow me」でフォロー
  // メンションが含まれており、かつキーワードがある場合
  if ((text.includes('follow me') || text.includes('フォローして')) && note.mentions && note.mentions.includes(botUserId)) {
    await followUser(userId);
    await cli.request('notes/create', {
      text: `@${username} フォローいたしました。「ログボ」と呟いてログインボーナスをお受け取りください。`,
      replyId: note.id,
    });
    return;
  }

  // 「ランキング」でランキング表示
  if (text.includes('ランキング') && note.mentions && note.mentions.includes(botUserId)) {
    const rankingText = getRanking();
    await cli.request('notes/create', {
      text: `@${username}\n${rankingText}`,
      replyId: note.id,
    });
    return;
  }

  // 「ログボ」でログボ処理
  if (text.includes('ログボ')) {
    // フォロワーチェック
    const isFollowerUser = await isFollower(userId);

    if (!isFollowerUser) {
      // 未フォローの場合は誘導（頻繁なスパムにならないようメンション時のみ反応するなど調整可だが、一旦反応させる）
      await cli.request('notes/create', {
        text: `@${username} ログインボーナスを受け取るには、私をフォローしてください。「follow me」とメンションを送っていただければフォローいたします。`,
        replyId: note.id,
      });
      return;
    }

    const result = recordLogbo(userId, username);

    // リアクション
    await cli.request('notes/reactions/create', {
      noteId: note.id,
      reaction: '⭕',
    });

    // リプライ
    if (result.alreadyDone) {
      await cli.request('notes/create', {
        text: `@${username} 本日は既にログインボーナスを受取済みです。\n連続: ${result.consecutive}日 / 合計: ${result.total}日`,
        replyId: note.id,
      });
    } else {
      const message = result.consecutive === 1 && result.total === 1
        ? `@${username} 🎉 初回ログインボーナスです！明日もまたお越しください。`
        : `@${username} 🎁 ログインボーナス！\n連続ログイン: ${result.consecutive}日目\n合計: ${result.total}日`;

      await cli.request('notes/create', {
        text: message,
        replyId: note.id,
      });
    }
  }
});

console.log('Logbo bot started with Polite mode.');
console.log(`Logbo date boundary: JST 05:00`);
