import * as Misskey from 'misskey-js';
import Database from 'better-sqlite3';
import fs from 'fs';
import pkg from 'ws';

// WebSocketポリフィル
const WebSocket = pkg.WebSocket || pkg.default || pkg;
global.WebSocket = WebSocket;

// 環境変数
const MISSKEY_URL = process.env.MISSKEY_URL;
const MISSKEY_TOKEN = process.env.MISSKEY_TOKEN;

if (!MISSKEY_URL || !MISSKEY_TOKEN) {
  console.error('Error: Set MISSKEY_URL and MISSKEY_TOKEN in .env or docker-compose environment');
  process.exit(1);
}

const BOT_HOST = new URL(MISSKEY_URL).hostname;
console.log(`Bot instance host: ${BOT_HOST}`);

// データディレクトリ作成
if (!fs.existsSync('./data')) {
  try {
    fs.mkdirSync('./data', { recursive: true });
  } catch (err) {
    console.error('Failed to create data directory:', err);
    process.exit(1);
  }
}

// Misskeyクライアント
const cli = new Misskey.api.APIClient({
  origin: MISSKEY_URL,
  credential: MISSKEY_TOKEN,
});

const stream = new Misskey.Stream(MISSKEY_URL, {
  token: MISSKEY_TOKEN,
});

let botUserId;
cli.request('i').then((res) => {
  botUserId = res.id;
  console.log(`Bot user ID: ${botUserId}`);
}).catch(err => {
  console.error('Login failed:', err);
  process.exit(1);
});

// DB初期化
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

// 
const processedNotes = new Set();

function checkAndLock(noteId) {
  if (processedNotes.has(noteId)) {
    return true; // ロック済み（スキップ）
  }
  processedNotes.add(noteId);
  setTimeout(() => {
    processedNotes.delete(noteId);
  }, 30000);
  return false; // 新規（処理実行）
}
//

function getLogboDate() {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstTime = new Date(now.getTime() + jstOffset);
  jstTime.setHours(jstTime.getHours() - 5);
  return jstTime.toISOString().split('T')[0];
}

async function isFollower(userId) {
  try {
    const relation = await cli.request('users/relation', { userId: [userId] });
    return relation[0]?.isFollowing || false;
  } catch (error) {
    console.error('Error checking follower:', error);
    return false;
  }
}

async function followUser(userId) {
  try {
    await cli.request('following/create', { userId });
    console.log(`Followed user: ${userId}`);
  } catch (error) {
    console.error('Error following user:', error);
  }
}

function recordLogbo(userId, fullAcct) {
  const today = getLogboDate();
  const record = db.prepare('SELECT * FROM logbo_records WHERE user_id = ?').get(userId);

  if (!record) {
    db.prepare('INSERT INTO logbo_records (user_id, username, total_days, consecutive_days, last_logbo_date) VALUES (?, ?, 1, 1, ?)').run(userId, fullAcct, today);
    return { total: 1, consecutive: 1, alreadyDone: false };
  }

  if (record.last_logbo_date === today) {
    if (record.username !== fullAcct) {
      db.prepare('UPDATE logbo_records SET username = ? WHERE user_id = ?').run(fullAcct, userId);
    }
    return { total: record.total_days, consecutive: record.consecutive_days, alreadyDone: true };
  }

  const lastDate = new Date(record.last_logbo_date + 'T00:00:00Z');
  const todayDate = new Date(today + 'T00:00:00Z');
  const diffDays = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));

  if (diffDays === 1) {
    const newTotal = record.total_days + 1;
    const newConsecutive = record.consecutive_days + 1;
    db.prepare('UPDATE logbo_records SET username = ?, total_days = ?, consecutive_days = ?, last_logbo_date = ? WHERE user_id = ?')
      .run(fullAcct, newTotal, newConsecutive, today, userId);
    return { total: newTotal, consecutive: newConsecutive, alreadyDone: false };
  } else {
    const newTotal = record.total_days + 1;
    db.prepare('UPDATE logbo_records SET username = ?, total_days = ?, consecutive_days = 1, last_logbo_date = ? WHERE user_id = ?')
      .run(fullAcct, newTotal, today, userId);
    return { total: newTotal, consecutive: 1, alreadyDone: false };
  }
}

function getRanking() {
  const ranking = db.prepare(`
    SELECT username, consecutive_days, total_days 
    FROM logbo_records 
    ORDER BY consecutive_days DESC, total_days DESC 
    LIMIT 10
  `).all();
  
  if (ranking.length === 0) return '現在、データはありません。';
  
  let rankingText = '📊 **連続ログインボーナス ランキング TOP 10**\n\n';
  ranking.forEach((record, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}. `;
    rankingText += `${medal} \`${record.username}\`\n`; 
    rankingText += `   連続: ${record.consecutive_days}日 / 合計: ${record.total_days}日\n\n`;
  });
  return rankingText;
}

// ヘルパー: ノート処理の本体（ロックチェック通過後に呼ばれる）
async function processNote(note, channelName) {
    const userId = note.userId;
    const text = note.text || '';
    const acct = getFullAcct(note.user);
    
    // stationstaff無視
    if (note.user.username === 'stationstaff') {
        console.log(`[${channelName}] Ignoring note from @${acct} (stationstaff).`);
        return; // ここで強制終了：これ以降の処理は一切しない
    }

    console.log(`[${channelName}] Processing note from @${acct}: ${text}`);

    // Follow Me
    if (text.includes('follow me') || text.includes('フォローして')) {
      const isAlreadyFollowing = await isFollower(userId);
      if (isAlreadyFollowing) {
        console.log(`[${channelName}] Already following @${acct}. Skipping follow action.`);
        return; // 既にフォロー済みなら何もしないで終了
      }
      // 

      console.log(`[${channelName}] Follow me detected`);
      await followUser(userId);
      await cli.request('notes/create', {
        text: `@${acct} フォローいたしました。「ログボ」と呟いてログインボーナスをお受け取りください。`,
        replyId: note.id,
        visibility: note.visibility === 'specified' ? 'specified' : 'public'
      });
      return;
    }


    // ランキング正規表現
    const rankingPattern = /ランキング|らんきんぐ|ranking/i;
    // ランキング
    //if (text.includes('ランキング')) {
    if (rankingPattern.test(text)) {
      const rankingText = getRanking();
      await cli.request('notes/create', {
        text: `@${acct}\n${rankingText}`,
        replyId: note.id,
        visibility: note.visibility === 'specified' ? 'specified' : 'public'
      });
      return;
    }

    // ログボ正規表現
    const logboPattern = /ログボ|ろぐぼ|ログインボーナス|ろぐいんぼーなす/;
    // ログボ
    // if (text.includes('ログボ')) {
    if (logboPattern.test(text)) {
      // ★ここで processLogboWithAcct を呼んでいるので、この関数が存在しないとエラーになる
      await processLogboWithAcct(note, userId, acct);
      return;
    }

    // メンションされているときの処理
    const isMentioned = note.mentions && note.mentions.includes(botUserId);
    if (isMentioned){
      // 認証コードの確認
      if (pendingAuth.has(userId)) {
          const requiredCode = pendingAuth.get(userId);
          if (note.text && note.text.includes(requiredCode)) {
              // 正解
              pendingAuth.delete(userId);
              await cli.request('notes/reactions/create', { noteId: note.id, reaction: '✅' });
              await processLogboWithAcct(note, userId, acct); // ログボ判定
          } else {
              // 不正解
              await cli.request('notes/create', {
                  text: `@${acct} 認証コードが確認できませんでした...\n返信に「${requiredCode}」を含めてください。`,
                  replyId: note.id,
                  visibility: 'public'
              });
          }
        return;
      }
    }
}

// 認証待ちのユーザーIDと正解コードを保存するリスト
const pendingAuth = new Map();

// ログボ済みかどうか（読み取り専用）
function checkLogboStatus(userId) {
  const today = getLogboDate();
  const record = db.prepare('SELECT * FROM logbo_records WHERE user_id = ?').get(userId);

  if (!record) {
    return { alreadyDone: false, total: 0, consecutive: 0 };
  }

  if (record.last_logbo_date === today) {
    return { 
      alreadyDone: true, 
      total: record.total_days, 
      consecutive: record.consecutive_days 
    };
  }

  return { 
    alreadyDone: false, 
    total: record.total_days, 
    consecutive: record.consecutive_days 
  };
}

// メイン処理
async function processLogboWithAcct(note, userId, acct) {
  try {
    const isFollowerUser = await isFollower(userId);
    if (!isFollowerUser) {
      await cli.request('notes/create', {
        text: `@${acct} ログインボーナスを受け取るには、私をフォローしてください。「follow me」と送っていただければフォローいたします。`,
        replyId: note.id,
        visibility: note.visibility === 'specified' ? 'specified' : 'public'
      });
      return;
    }

    const status = checkLogboStatus(userId);

    if (status.alreadyDone) {
        try {
            await cli.request('notes/reactions/create', { 
                noteId: note.id, 
                reaction: ':ablobcatblinkhyper:' 
            });
        } catch (e) {
            // 無視
        }

        await cli.request('notes/create', {
            text: `@${acct} 本日は既にログインボーナスを**受取済み**です...\n$[sparkle **連続: ${status.consecutive}日**] / **合計: ${status.total}日**`,
            replyId: note.id,
            visibility: 'public'
        });
        return; // ここで終了・認証には進まない
    }

    // 自動化対策（ver 2.0）
    // B. 新規かつ未実施: 00秒判定，認証コード送る
    else if (new Date(note.createdAt).getSeconds() === 0) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        pendingAuth.set(userId, code);

        await cli.request('notes/create', {
            text: `@${acct} 【自動化対策】\n$[fg.color=ff0000 ログボを受け取るには認証が必要です。]\n返信で「${code}」と送ってください。`,
            replyId: note.id,
            visibility: 'public'
        });
        console.log(`>>> Auth challenge sent to ${acct} (Code: ${code})`);
        return; // 書き込まずに終了
    }
    // 自動化クリア

    // ここで記録
    const result = recordLogbo(userId, acct);
    
    try {
        const reactionEmoji = result.alreadyDone ? ':ablobcatblinkhyper:' : ':blobcat_fun_c30:';
        await cli.request('notes/reactions/create', { noteId: note.id, reaction: reactionEmoji });
    } catch (e) {
        // リアクション重複エラーは無視
    }

    const replyVisibility = note.visibility === 'specified' ? 'specified' : 'public';
    let message = '';
    
    // ここは recordLogbo の戻り値を使う（さっき書き込んだ最新の結果）
    if (result.alreadyDone) {
      // ※ ここに来ることは理論上少ないが、タイミング次第でありえるので残す
      message = `@${acct} 本日は既にログインボーナスを受取済みです...\n$[sparkle **連続: ${result.consecutive}日**] / **合計: ${result.total}日**`;
    } else {
      message = result.consecutive === 1 && result.total === 1
        ? `@${acct} $[sparkle **初回**ログインボーナスです！] 明日もまたログインしてください。`
        : `@${acct} **ログインボーナス！**\n$[sparkle 連続ログイン: ${result.consecutive}日目]\n合計: ${result.total}日`;
      // 認証待ちに入ってたら削除
      if (pendingAuth.has(userId)) {
              pendingAuth.delete(userId);
      }
    }

    await cli.request('notes/create', { text: message, replyId: note.id, visibility: replyVisibility });
    console.log(`>>> Logbo Reply sent to ${acct}`);
  } catch (err) {
    console.error(`Error processing logbo for ${acct}:`, err);
  }
}
// 

function getFullAcct(user) {
  const host = user.host || BOT_HOST;
  return `${user.username}@${host}`;
}

// ---------------------------------------------------------
// タイムライン監視
// ---------------------------------------------------------

const mainChannel = stream.useChannel('main');

mainChannel.on('mention', async (note) => {
  try {
    if (note.userId === botUserId) return;

    if (checkAndLock(note.id)) {
        console.log(`[SKIP-MAIN] Duplicate detected: ${note.id}`);
        return;
    }
    
    await processNote(note, 'MAIN');
  } catch (err) {
    console.error('[MAIN] Error:', err);
  }
});

const homeChannel = stream.useChannel('homeTimeline');

homeChannel.on('note', async (note) => {
  try {
    if (note.userId === botUserId) return;

    if (checkAndLock(note.id)) {
        console.log(`[SKIP-HOME] Duplicate detected: ${note.id}`);
        return;
    }

    await processNote(note, 'HOME');
    
  } catch (err) {
    console.error('[HOME] Error:', err);
  }
});

console.log('Logbo bot started with Fixed Functions.');
console.log(`Bot Hostname: ${BOT_HOST}`);
