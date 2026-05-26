/**
 * ============================================================================
 *  管理職昇格AIアセスメント — Google Apps Script Web App
 * ============================================================================
 *
 *  概要:
 *    - HTML テストを Web App として配信
 *    - Section A/B/C/E はクライアント側で自動採点(マークと送信)
 *    - Section D(記述)は Gemini API でサーバー側で自動採点
 *    - 結果は Google Sheets に保存され、ダッシュボードで集計閲覧可能
 *    - 3段階カテゴリ(要努力 / 及第点 / 優良)で判定
 *
 *  デプロイ手順:
 *    1. script.google.com で新規プロジェクトを作成
 *    2. このファイル一式(Code.gs, index.html, dashboard.html, appsscript.json)を配置
 *       - HTMLファイル名は拡張子なし("index", "dashboard")で作成
 *    3. スクリプトプロパティに API キーを設定:
 *       プロジェクト設定 > スクリプトプロパティ > プロパティを追加
 *         プロパティ: GEMINI_API_KEY
 *         値: aistudio.google.com で取得した API キー
 *    4. setupSpreadsheet() を1回実行
 *       - 結果保存用の Google Sheets が新規作成され、ID がスクリプトプロパティに保存される
 *       - 実行ログから Sheet の URL を確認できる
 *    5. デプロイ > 新しいデプロイ
 *       - 種類: ウェブアプリ
 *       - 次のユーザーとして実行: 自分
 *       - アクセスできるユーザー: 自社ドメイン全員 (または適切な範囲)
 *    6. デプロイ URL を共有
 *       - 受験用:    <URL>
 *       - 管理者用:  <URL>?page=dashboard
 *
 *  権限:
 *    初回実行時に以下のスコープへの許可が求められる:
 *      - Google Sheets への読み書き
 *      - 外部API呼び出し (Gemini)
 *      - スクリプトプロパティの読み書き
 *
 *  結果の通知:
 *    結果は Google Sheets に蓄積されます。受験者本人は提出直後の結果画面、
 *    管理者は <URL>?page=dashboard でダッシュボードを参照してください。
 * ============================================================================
 */

// ---------------- Configuration ----------------
const SHEET_ID_PROP       = 'ASSESSMENT_SHEET_ID';
const GEMINI_API_KEY_PROP = 'GEMINI_API_KEY';
const SHEET_NAME          = 'Results';
const GEMINI_MODEL        = 'gemini-2.5-flash';
// 503/429/5xx のときは順にフォールバックを試す。最初に成功したモデルの結果を採用する。
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash'
];
// 各モデルでこの回数までリトライ(初回 + リトライ)。バックオフは 2s, 5s, 11s …
const GEMINI_MAX_ATTEMPTS = 4;

// 合格カテゴリの閾値 (SaaS企業 ビジネスサイド管理職の期待水準)
const PASS_PCT      = 0.60;   // 60% 未満は「要努力」
const EXCELLENT_PCT = 0.80;   // 80% 以上は「優良」
const D_MIN_PCT     = 0.50;   // セクションD が 50% 未満なら自動で「要努力」

// ダッシュボードへのアクセスをドメイン内特定ユーザーに限定したい場合に列挙
// 空配列の場合は Web App デプロイ設定のアクセス権限に従う
const ADMIN_EMAILS = []; // ['admin@example.co.jp']

// ---------------- Web App routing ----------------
function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'test';
  if (page === 'dashboard') {
    return renderDashboard_();
  }
  return renderAssessment_();
}

function renderAssessment_() {
  return HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle('管理職昇格AIアセスメント')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

function renderDashboard_() {
  if (ADMIN_EMAILS.length > 0) {
    const u = Session.getActiveUser().getEmail();
    if (!ADMIN_EMAILS.includes(u)) {
      return HtmlService.createHtmlOutput(
        '<div style="font-family:sans-serif;padding:40px;text-align:center;">' +
        '<h1>403 — Access Denied</h1><p>このページへのアクセス権限がありません。</p></div>');
    }
  }
  return HtmlService.createTemplateFromFile('dashboard').evaluate()
    .setTitle('AIアセスメント ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// ---------------- Setup ----------------
/**
 * 結果保存用 Google Sheets を初期化する。最初に1回手動で実行する。
 * 既存のシートが既に紐付いていればヘッダ確認のみ。
 */
function setupSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(SHEET_ID_PROP);
  let ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { id = null; ss = null; }
  }
  if (!id) {
    ss = SpreadsheetApp.create('管理職昇格AIアセスメント — 結果ログ');
    id = ss.getId();
    props.setProperty(SHEET_ID_PROP, id);
  }
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow([
      'submissionId','受験日時','氏名','所属','所要(秒)',
      'A_got','A_max','B_got','B_max','C_got','C_max','D_got','D_max',
      '総合','満点','達成率(%)','カテゴリ',
      'Gemini評価(JSON)','回答ログ(JSON)'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1,1,1,sheet.getLastColumn()).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
    sheet.setColumnWidth(1, 280); // submissionId
    sheet.setColumnWidth(2, 150); // timestamp
    sheet.setColumnWidth(3, 120); // 氏名
    sheet.setColumnWidth(18, 200); sheet.setColumnWidth(19, 200); // JSON columns
  }
  const url = ss.getUrl();
  Logger.log('結果保存シートを準備しました: ' + url);
  return url;
}

// ---------------- Submission API (called from client) ----------------
/**
 * クライアントから提出された結果を受け取り、Gemini で D を採点し、保存する。
 * payload schema:
 *   {
 *     examinee: { name, role },
 *     elapsedSec: number,
 *     autoScores: { A:{got,max}, B:{got,max}, C:{got,max} },
 *     sectionD: [ { id, skill, prompt, rubric:[5項目], answer, points } ],
 *     questionsLog: [ ... 監査用 ... ]
 *   }
 */
function submitAssessment(payload) {
  try {
    if (!payload || !payload.examinee || !payload.autoScores) {
      throw new Error('提出データが不正です');
    }

    // 1) Gemini に Section D 採点を依頼
    const dResult = gradeSectionDWithGemini_(payload.sectionD || []);

    // 2) スコア集計
    const sec = payload.autoScores;
    const totalAuto = (sec.A.got||0) + (sec.B.got||0) + (sec.C.got||0);
    const maxAuto   = (sec.A.max||0) + (sec.B.max||0) + (sec.C.max||0);
    const totalScore = totalAuto + dResult.totalScore;
    const totalMax   = maxAuto + dResult.totalMax;
    const dPct = dResult.totalMax > 0 ? (dResult.totalScore / dResult.totalMax) : 0;
    const totalPct = totalMax > 0 ? (totalScore / totalMax) : 0;
    const category = categorize_(totalPct, dPct);

    // 3) Sheets に保存
    const submissionId = Utilities.getUuid();
    saveToSheet_({
      submissionId, examinee: payload.examinee, elapsedSec: payload.elapsedSec || 0,
      sec, dResult, totalScore, totalMax, category,
      questionsLog: payload.questionsLog || []
    });

    return {
      success: true,
      submissionId,
      sec, dResult,
      totalScore, totalMax,
      totalPct: Math.round(totalPct * 1000) / 10,
      dPct: Math.round(dPct * 1000) / 10,
      category,
      thresholds: {
        passPct: PASS_PCT * 100,
        excellentPct: EXCELLENT_PCT * 100,
        dMinPct: D_MIN_PCT * 100
      }
    };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

// HTTP コードが transient(リトライする価値あり)か判定
function isTransientHttpCode_(code) {
  return code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
}

// Gemini API を1モデル × 1回呼び出して { code, text } を返す
function callGeminiOnce_(model, body, apiKey) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
              ':generateContent?key=' + encodeURIComponent(apiKey);
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), text: res.getContentText() };
}

/**
 * GEMINI_MODELS の各モデルに対して指数バックオフでリトライしつつ呼び出す。
 * 503/429/5xx は transient とみなしリトライ。
 * いずれかのモデルが 2xx を返したら { jsonStr, modelUsed } を返す。
 * 全モデル全リトライが失敗した場合のみ throw。
 */
function callGeminiWithRetry_(body, apiKey) {
  const errors = [];
  for (let m = 0; m < GEMINI_MODELS.length; m++) {
    const model = GEMINI_MODELS[m];
    for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
      let code, text;
      try {
        const r = callGeminiOnce_(model, body, apiKey);
        code = r.code; text = r.text;
      } catch (netErr) {
        // ネットワーク/タイムアウト系も transient 扱いで再試行
        errors.push(model + ' attempt ' + attempt + ': ' + String(netErr.message || netErr));
        if (attempt < GEMINI_MAX_ATTEMPTS) { Utilities.sleep(backoffMs_(attempt)); continue; }
        break;
      }

      if (code >= 200 && code < 300) {
        let data;
        try { data = JSON.parse(text); } catch (e) {
          errors.push(model + ' attempt ' + attempt + ': JSON parse failed');
          break;
        }
        if (!data.candidates || !data.candidates[0] ||
            !data.candidates[0].content || !data.candidates[0].content.parts ||
            !data.candidates[0].content.parts[0]) {
          errors.push(model + ' attempt ' + attempt + ': empty candidates (finishReason=' + (data.candidates && data.candidates[0] && data.candidates[0].finishReason) + ')');
          break;
        }
        return { jsonStr: data.candidates[0].content.parts[0].text, modelUsed: model };
      }

      errors.push(model + ' attempt ' + attempt + ': HTTP ' + code + ' ' + text.substring(0, 200));
      if (!isTransientHttpCode_(code)) break; // 4xx (auth/quota永続) はモデル変えても無駄なので次へ
      if (attempt < GEMINI_MAX_ATTEMPTS) Utilities.sleep(backoffMs_(attempt));
    }
  }
  throw new Error(
    'Gemini API が一時的に応答しません(' + GEMINI_MODELS.length + 'モデル × ' + GEMINI_MAX_ATTEMPTS +
    '回まで再試行しました)。数分待ってから再提出してください。\n詳細:\n  - ' +
    errors.slice(-6).join('\n  - ')
  );
}

// attempt=1 → 2000ms, attempt=2 → 5000ms, attempt=3 → 11000ms, attempt=4 → 23000ms (±20% jitter)
function backoffMs_(attempt) {
  const base = Math.pow(2, attempt) * 1000 + Math.pow(2, attempt - 1) * 1000;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

function categorize_(totalPct, dPct) {
  if (dPct < D_MIN_PCT) return '要努力';
  if (totalPct < PASS_PCT) return '要努力';
  if (totalPct >= EXCELLENT_PCT) return '優良';
  return '及第点';
}

// ---------------- Gemini grading ----------------
function gradeSectionDWithGemini_(sectionDQAs) {
  if (!sectionDQAs || sectionDQAs.length === 0) {
    return { totalScore: 0, totalMax: 0, evaluations: [], overallSummary: '(セクションD設問なし)' };
  }
  const apiKey = PropertiesService.getScriptProperties().getProperty(GEMINI_API_KEY_PROP);
  if (!apiKey) throw new Error('GEMINI_API_KEY がスクリプトプロパティに設定されていません');

  const totalMax = sectionDQAs.reduce((s,q)=>s+(q.points||15), 0);
  const prompt = buildEvalPrompt_(sectionDQAs);

  const schema = {
    type: 'OBJECT',
    properties: {
      evaluations: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id:           { type: 'STRING' },
            skill:        { type: 'STRING' },
            rubricScores: { type: 'ARRAY', items: { type: 'INTEGER' } },
            subtotal:     { type: 'INTEGER' },
            comments:     { type: 'ARRAY', items: { type: 'STRING' } },
            strengths:    { type: 'STRING' },
            improvements: { type: 'STRING' },
            verdict:      { type: 'STRING' }
          },
          required: ['id','rubricScores','subtotal','verdict']
        }
      },
      totalScore:     { type: 'INTEGER' },
      overallSummary: { type: 'STRING' }
    },
    required: ['evaluations','totalScore','overallSummary']
  };

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  const { jsonStr, modelUsed } = callGeminiWithRetry_(body, apiKey);
  const parsed = JSON.parse(jsonStr);
  if (modelUsed !== GEMINI_MODELS[0]) {
    Logger.log('Gemini fallback model used: ' + modelUsed);
  }

  // Sanity-clamp scores per question, recompute totals
  let runningTotal = 0;
  parsed.evaluations.forEach((e, idx) => {
    const q = sectionDQAs[idx];
    const maxPoints = q ? (q.points || 15) : 15;
    if (typeof e.subtotal !== 'number') e.subtotal = 0;
    if (e.subtotal > maxPoints) e.subtotal = maxPoints;
    if (e.subtotal < 0) e.subtotal = 0;
    e.maxPoints = maxPoints;
    runningTotal += e.subtotal;
  });
  parsed.totalScore = runningTotal;
  parsed.totalMax = totalMax;
  return parsed;
}

function buildEvalPrompt_(qas) {
  let p = '# 役割\nあなたは管理職昇格試験の評価者です。SaaS企業のビジネスサイド管理職に求められるAI活用力を、提示されたルーブリックに従って厳密に採点します。\n\n';
  p += '# 採点基準\n';
  p += '- 各設問の各ルーブリック項目を、以下の4段階で採点:\n';
  p += '    0 = 欠落(該当要素が含まれない、または致命的に不適切)\n';
  p += '    1 = 部分的(触れているが浅い・不十分)\n';
  p += '    2 = 明示(具体的に書かれている)\n';
  p += '    3 = 十分に明示(具体性と妥当性が高い水準で揃っている)\n';
  p += '- 各ルーブリック項目の上限は3点。1問あたり最大点は (ルーブリック項目数) × 3 (上限は配点)。\n';
  p += '- 厳密に採点。以下は厳しく減点:\n';
  p += '    * 一般論で終わっている / シナリオの数値・関係者・制約が反映されていない\n';
  p += '    * 安全性・情報セキュリティ配慮の欠落\n';
  p += '    * 分量要件(○○字以上)の未達\n';
  p += '- 各設問に「合格(配点の70%以上)」または「要再受験(70%未満)」の verdict を付与。\n\n';

  qas.forEach((q, i) => {
    p += '---\n\n# 設問 ' + (i+1) + ' (id: ' + q.id + ', skill: ' + (q.skill || '') + ', 配点: ' + (q.points || 15) + '点)\n\n';
    p += '## 設問本文\n' + (q.prompt || '') + '\n\n';
    p += '## ルーブリック (' + (q.rubric ? q.rubric.length : 0) + '項目)\n';
    (q.rubric || []).forEach((r, j) => p += 'R' + (j+1) + '. ' + r + '\n');
    p += '\n## 受験者の回答\n"""\n' + (q.answer || '(未回答)') + '\n"""\n\n';
  });

  p += '---\n\n以上について、JSON 形式で出力してください。\n';
  p += 'evaluations[i] の各項目には: id, skill, rubricScores (要素数=ルーブリック項目数の配列、各0-3), subtotal (合計、最大は配点), comments (各ルーブリックへの短いコメント配列), strengths (短文), improvements (短文), verdict (合格 / 要再受験) を入れてください。\n';
  p += 'totalScore は全設問の subtotal の合計、overallSummary には受験者全体に対する3〜5行の総評(具体的な改善アドバイス)を入れてください。';
  return p;
}

// ---------------- Sheets storage ----------------
function getOrCreateSheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(SHEET_ID_PROP);
  if (!id) {
    setupSpreadsheet();
    id = props.getProperty(SHEET_ID_PROP);
  }
  const ss = SpreadsheetApp.openById(id);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    setupSpreadsheet();
    sheet = ss.getSheetByName(SHEET_NAME);
  }
  return sheet;
}

function saveToSheet_(o) {
  const sheet = getOrCreateSheet_();
  sheet.appendRow([
    o.submissionId,
    new Date(),
    o.examinee.name || '',
    o.examinee.role || '',
    o.elapsedSec || 0,
    o.sec.A.got, o.sec.A.max,
    o.sec.B.got, o.sec.B.max,
    o.sec.C.got, o.sec.C.max,
    o.dResult.totalScore, o.dResult.totalMax,
    o.totalScore, o.totalMax,
    o.totalMax > 0 ? (o.totalScore / o.totalMax * 100).toFixed(1) : '0',
    o.category,
    JSON.stringify(o.dResult),
    JSON.stringify(o.questionsLog).substring(0, 49000) // セル上限対策
  ]);
}

// ---------------- Dashboard data ----------------
function getDashboardData() {
  const sheet = getOrCreateSheet_();
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return { rows: [], summary: { total:0, byCategory:{'要努力':0,'及第点':0,'優良':0}, avgPct:0, avgDPct:0 } };
  }
  const headers = data[0];
  const ix = {};
  headers.forEach((h, i) => ix[h] = i);

  const rows = [];
  const byCategory = { '要努力':0, '及第点':0, '優良':0 };
  let pctSum = 0, dGotSum = 0, dMaxSum = 0;

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const pct = parseFloat(r[ix['達成率(%)']] || 0);
    const cat = r[ix['カテゴリ']] || '';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    pctSum += pct;
    dGotSum += parseInt(r[ix['D_got']] || 0);
    dMaxSum += parseInt(r[ix['D_max']] || 0);

    rows.push({
      rowIndex: i + 1, // 1-based sheet row number (header is row 1)
      submissionId: r[ix['submissionId']],
      timestamp: r[ix['受験日時']] ? Utilities.formatDate(new Date(r[ix['受験日時']]), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : '',
      name: r[ix['氏名']],
      role: r[ix['所属']],
      A: r[ix['A_got']] + '/' + r[ix['A_max']],
      B: r[ix['B_got']] + '/' + r[ix['B_max']],
      C: r[ix['C_got']] + '/' + r[ix['C_max']],
      D: r[ix['D_got']] + '/' + r[ix['D_max']],
      total: r[ix['総合']] + '/' + r[ix['満点']],
      percent: r[ix['達成率(%)']],
      category: cat
    });
  }
  // Most recent first
  rows.reverse();

  return {
    rows,
    summary: {
      total: rows.length,
      byCategory,
      avgPct: rows.length > 0 ? (pctSum / rows.length).toFixed(1) : '0',
      avgDPct: dMaxSum > 0 ? (dGotSum / dMaxSum * 100).toFixed(1) : '0'
    },
    thresholds: {
      passPct: PASS_PCT * 100,
      excellentPct: EXCELLENT_PCT * 100,
      dMinPct: D_MIN_PCT * 100
    },
    sheetUrl: SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROP)).getUrl()
  };
}

/**
 * 指定された行(1-based、ヘッダ行は1)の受験詳細を返す。
 * 古いバージョンの sheet schema や submissionId 列ズレに依存しないよう
 * 行番号で直接読み出す。
 */
function getSubmissionByRow(rowIndex) {
  const sheet = getOrCreateSheet_();
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (!rowIndex || rowIndex < 2 || rowIndex > lastRow) return null;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const row     = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  const obj = {};
  headers.forEach((h, j) => obj[h] = row[j]);
  try { obj.dResultParsed = JSON.parse(obj['Gemini評価(JSON)']); } catch (e) { obj.dResultParsed = null; }
  try { obj.qLogParsed    = JSON.parse(obj['回答ログ(JSON)']); }  catch (e) { obj.qLogParsed    = null; }
  if (obj['受験日時']) {
    try { obj.timestamp = Utilities.formatDate(new Date(obj['受験日時']), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'); } catch (e) {}
  }
  return obj;
}

/**
 * 後方互換: submissionId 文字列から行を引く。
 * シートに submissionId 列が無い / ズレている場合は null を返す。
 * 新しい UI は getSubmissionByRow を使うこと。
 */
function getSubmissionDetail(submissionId) {
  const sheet = getOrCreateSheet_();
  const data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return null;
  const headers = data[0];
  const idCol = headers.indexOf('submissionId');
  if (idCol < 0) return null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(submissionId)) {
      return getSubmissionByRow(i + 1);
    }
  }
  return null;
}

// Optional: quick health check from the script editor.
function testGeminiConnection() {
  const apiKey = PropertiesService.getScriptProperties().getProperty(GEMINI_API_KEY_PROP);
  if (!apiKey) { Logger.log('GEMINI_API_KEY が未設定'); return; }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
  const body = { contents: [{ parts: [{ text: 'OK と1単語だけ答えてください。' }]}], generationConfig: { temperature: 0 } };
  const res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json', payload: JSON.stringify(body), muteHttpExceptions: true });
  Logger.log('HTTP ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 500));
}
