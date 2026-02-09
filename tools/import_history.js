// tools/import_history.js
// 実行方法: node tools/import_history.js
// 依存: npm install misskey-js better-sqlite3 dotenv

import * as Misskey from 'misskey-js';
import Database from 'better-sqlite3';
import fs from 'fs';
import 'dotenv/config'; // .envを読み込む

// 設定
const MISSKEY_URL = process.env.MISSKEY_URL;
const MISSKEY_TOKEN = process.env.MISSKEY_TOKEN;
const DB_PATH = './data/database.db';

if (!MISSKEY_URL || !MISSKEY_TOKEN) {
    console.error('Error: .envが見つかりません');
    process.exit(1);
}

const cli = new Misskey.api.APIClient({
    origin: MISSKEY_URL,
    credential: MISSKEY_TOKEN,
});

// DB準備（履歴用テーブル作成）
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS logbo_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    logbo_date TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, logbo_date)
  );
  CREATE INDEX IF NOT EXISTS idx_user_date ON logbo_history(user_id, logbo_date);
`);

// 5時切り替えの日付計算
function getLogboDate(dateObj) {
    const jstOffset = 9 * 60 * 60 * 1000;
    const jstTime = new Date(dateObj.getTime() + jstOffset);
    jstTime.setHours(jstTime.getHours() - 5); // 5時引く
    return jstTime.toISOString().split('T')[0];
}

async function main() {
    console.log('ログイン中...');
    const me = await cli.request('i');
    const myId = me.id;
    console.log(`Bot ID: ${myId}, Username: ${me.username}`);

    let untilId = null;
    let count = 0;
    let totalImported = 0;

    while (true) {
        console.log(`Fetching notes... (untilId: ${untilId || 'latest'})`);
        
        const notes = await cli.request('users/notes', {
            userId: myId,
            limit: 100,
            untilId: untilId,
            includeReplies: true,
        });

        if (notes.length === 0) break;

        for (const note of notes) {
            untilId = note.id;

            // Botが送った「ログボ成功リプライ」か判定
            // 「ログインボーナス！」または「ログボ受取済み」を含む
            const text = note.text || '';
            const isLogboSuccess = text.includes('ログインボーナス！') || text.includes('初回ログインボーナス');
            const isAlreadyDone = text.includes('受取済み');

            if (isLogboSuccess || isAlreadyDone) {
                // 宛先（ユーザーID）を特定
                // noteオブジェクトにreplyが含まれていない場合はmentionsを見る
                let targetUserId = note.reply?.userId;
                
                // reply情報がない場合、メンションから探す（自分以外）
                if (!targetUserId && note.mentions) {
                   targetUserId = note.mentions.find(id => id !== myId);
                }

                if (targetUserId) {
                    const date = new Date(note.createdAt);
                    const logboDate = getLogboDate(date);

                    try {
                        const info = db.prepare('INSERT OR IGNORE INTO logbo_history (user_id, logbo_date) VALUES (?, ?)').run(targetUserId, logboDate);
                        if (info.changes > 0) {
                            console.log(`[Import] ${logboDate} - User: ${targetUserId}`);
                            totalImported++;
                        }
                    } catch (e) {
                        console.error('DB Error:', e);
                    }
                }
            }
        }
        
        count += notes.length;
        console.log(`Processed ${count} notes... (Imported: ${totalImported})`);
        
        // API制限回避のため少し待機
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('完了');
}

main();