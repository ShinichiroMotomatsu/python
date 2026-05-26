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
 *    5. testSendEmail() を実行(任意)し、自分のアドレス宛にサンプル結果メールが届くことを確認
 *    6. デプロイ > 新しいデプロイ
 *       - 種類: ウェブアプリ
 *       - 次のユーザーとして実行: 自分
 *       - アクセスできるユーザー: 自社ドメイン全員 (または適切な範囲)
 *    7. デプロイ URL を共有
 *       - 受験用:    <URL>
 *       - 管理者用:  <URL>?page=dashboard
 *
 *  権限:
 *    初回実行時に以下のスコープへの許可が求められる:
 *      - Google Sheets への読み書き
 *      - 外部API呼び出し (Gemini)
 *      - スクリプトプロパティの読み書き
 *      - Gmail からのメール送信 (MailApp)
 *
 *  メール送信について:
 *    - 提出時に受験者宛・評価者宛に自動でHTMLメールを送信します
 *    - 評価者メールアドレスが指定された場合は、評価者を To、受験者を Cc とします
 *    - 評価者未指定の場合は受験者本人にだけ届きます
 *    - 送信元は本スクリプトをデプロイしたユーザーの Gmail アドレスです
 *    - メール送信枠: 個人 Gmail = 100通/日 / Google Workspace = 1500通/日
 *    - 送信を無効化したい場合: Code.gs 冒頭の SEND_EMAIL_ON_SUBMIT を false に変更
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

// メール送信設定
const SEND_EMAIL_ON_SUBMIT = true;  // false にすると提出時メール送信を無効化
const EMAIL_BCC            = '';    // 監査用に必ず BCC したいアドレスがあれば設定
const EMAIL_SENDER_NAME    = 'AIアセスメント システム';

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
      'submissionId','受験日時','氏名','所属','受験者メール','評価者メール','所要(秒)',
      'A_got','A_max','B_got','B_max','C_got','C_max','D_got','D_max',
      '総合','満点','達成率(%)','カテゴリ',
      'Gemini評価(JSON)','回答ログ(JSON)'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1,1,1,sheet.getLastColumn()).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
    // Reasonable widths
    sheet.setColumnWidth(1, 280); // submissionId
    sheet.setColumnWidth(2, 150); // timestamp
    sheet.setColumnWidth(3, 120); // 氏名
    sheet.setColumnWidth(22, 200); sheet.setColumnWidth(23, 200);
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
 *     examinee: { name, role, email, evaluatorEmail },
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

    // 4) 結果メール送信(受験者・評価者宛)
    let emailStatus = { sent: false, reason: 'メール送信が無効化されています' };
    if (SEND_EMAIL_ON_SUBMIT) {
      emailStatus = sendResultEmail_(payload, dResult, {
        submissionId, sec, totalScore, totalMax,
        totalPct: Math.round(totalPct * 1000) / 10,
        dPct: Math.round(dPct * 1000) / 10,
        category,
        elapsedSec: payload.elapsedSec || 0
      });
    }

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
      },
      emailStatus
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
    o.examinee.email || '',
    o.examinee.evaluatorEmail || '',
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
      email: r[ix['受験者メール']],
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

// ---------------- Result Email ----------------
function sendResultEmail_(payload, dResult, s) {
  const evaluator = String(payload.examinee.evaluatorEmail || '').trim();
  const examinee  = String(payload.examinee.email || '').trim();
  const to  = evaluator || examinee;
  if (!to) return { sent: false, reason: '送信先メールアドレスが指定されていません(評価者・受験者ともに未入力)' };
  const cc  = (evaluator && examinee && evaluator.toLowerCase() !== examinee.toLowerCase()) ? examinee : '';

  const subject = '[管理職昇格AIアセスメント] 結果通知 — ' + payload.examinee.name + '(' + s.category + ' / ' + s.totalPct + '%)';
  const htmlBody = buildResultEmailHtml_(payload, dResult, s);
  const textBody = buildResultEmailText_(payload, dResult, s);

  try {
    const opts = { htmlBody: htmlBody, name: EMAIL_SENDER_NAME };
    if (cc)         opts.cc  = cc;
    if (EMAIL_BCC)  opts.bcc = EMAIL_BCC;
    MailApp.sendEmail(to, subject, textBody, opts);
    return { sent: true, to: to, cc: cc, bcc: EMAIL_BCC, remainingDailyQuota: MailApp.getRemainingDailyQuota() };
  } catch (e) {
    return { sent: false, reason: String(e.message || e) };
  }
}

function categoryColors_(cat) {
  if (cat === '優良')   return { bg:'#e6f4ea', border:'#34a853', fg:'#137333' };
  if (cat === '及第点') return { bg:'#fef7e0', border:'#fbbc04', fg:'#b06000' };
  return { bg:'#fdecea', border:'#ea4335', fg:'#a50e0e' };
}

function buildResultEmailHtml_(payload, dResult, s) {
  const c = categoryColors_(s.category);
  const m = Math.floor(s.elapsedSec/60), sec = s.elapsedSec%60;
  const sheetUrl = (function(){
    try { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROP)).getUrl(); }
    catch(e){ return ''; }
  })();

  let evalRows = '';
  (dResult.evaluations || []).forEach((e, i) => {
    evalRows +=
      '<tr><td style="padding:6px 10px;border-bottom:1px solid #dadce0;font-family:Menlo,monospace;font-size:12px;">D' + (i+1) + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #dadce0;font-size:13px;">' + escapeHtml_(e.skill || '') + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #dadce0;font-family:Menlo,monospace;font-size:12px;text-align:right;">' + (e.subtotal || 0) + '/' + (e.maxPoints || 15) + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #dadce0;font-size:12px;color:' + (e.verdict === '合格' ? '#137333' : '#a50e0e') + ';">' + escapeHtml_(e.verdict || '') + '</td></tr>';
  });

  return '' +
'<div style="font-family:\'Noto Sans JP\',sans-serif;color:#202124;max-width:680px;margin:0 auto;">' +
  '<div style="background:#1a73e8;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">' +
    '<div style="font-size:11px;letter-spacing:2px;color:#cfdcf3;">SAAS BUSINESS MANAGER · AI ASSESSMENT</div>' +
    '<div style="font-size:20px;font-weight:700;margin-top:4px;">受験結果のお知らせ</div>' +
  '</div>' +
  '<div style="border:1px solid #dadce0;border-top:none;padding:20px 24px;background:#fff;">' +
    '<table style="width:100%;font-size:14px;line-height:1.7;">' +
      '<tr><td style="color:#5f6368;width:120px;">受験者</td><td><b>' + escapeHtml_(payload.examinee.name) + '</b>(' + escapeHtml_(payload.examinee.role) + ')</td></tr>' +
      '<tr><td style="color:#5f6368;">受験者メール</td><td>' + escapeHtml_(payload.examinee.email || '(未入力)') + '</td></tr>' +
      '<tr><td style="color:#5f6368;">受験日時</td><td>' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + '</td></tr>' +
      '<tr><td style="color:#5f6368;">所要時間</td><td>' + m + '分' + (String(sec).length===1?'0'+sec:sec) + '秒</td></tr>' +
      '<tr><td style="color:#5f6368;">提出ID</td><td style="font-family:Menlo,monospace;font-size:12px;color:#5f6368;">' + escapeHtml_(s.submissionId) + '</td></tr>' +
    '</table>' +

    '<div style="background:' + c.bg + ';border:2px solid ' + c.border + ';border-radius:8px;padding:16px;margin:18px 0;text-align:center;">' +
      '<div style="font-size:11px;letter-spacing:2px;color:#5f6368;">RESULT</div>' +
      '<div style="font-size:36px;font-weight:800;color:' + c.fg + ';margin:4px 0;">' + escapeHtml_(s.category) + '</div>' +
      '<div style="font-family:Menlo,monospace;font-size:18px;font-weight:700;">' + s.totalScore + ' / ' + s.totalMax + '点 (' + s.totalPct + '%)</div>' +
      '<div style="font-size:11px;color:#5f6368;margin-top:6px;">及第点: ' + (PASS_PCT*100) + '%以上 / 優良: ' + (EXCELLENT_PCT*100) + '%以上 / セクションD最低: ' + (D_MIN_PCT*100) + '%以上</div>' +
    '</div>' +

    '<h3 style="font-size:14px;color:#174ea6;border-left:4px solid #1a73e8;padding-left:8px;margin:18px 0 8px;">セクション別スコア</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
      '<tr><td style="padding:6px 10px;border-bottom:1px solid #dadce0;">A. L1 基礎理解</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid #dadce0;font-family:Menlo,monospace;text-align:right;">' + s.sec.A.got + '/' + s.sec.A.max + '</td></tr>' +
      '<tr><td style="padding:6px 10px;border-bottom:1px solid #dadce0;">B. L2 業務活用判断</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid #dadce0;font-family:Menlo,monospace;text-align:right;">' + s.sec.B.got + '/' + s.sec.B.max + '</td></tr>' +
      '<tr><td style="padding:6px 10px;border-bottom:1px solid #dadce0;">C. L3 マネジメント応用</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid #dadce0;font-family:Menlo,monospace;text-align:right;">' + s.sec.C.got + '/' + s.sec.C.max + '</td></tr>' +
      '<tr><td style="padding:6px 10px;border-bottom:1px solid #dadce0;">D. プロンプト記述(Gemini評価)</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid #dadce0;font-family:Menlo,monospace;text-align:right;">' + dResult.totalScore + '/' + dResult.totalMax + '</td></tr>' +
    '</table>' +

    '<h3 style="font-size:14px;color:#174ea6;border-left:4px solid #1a73e8;padding-left:8px;margin:18px 0 8px;">セクションD ルーブリック別判定</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
      '<thead><tr style="background:#f1f3f4;"><th style="padding:6px 10px;text-align:left;">#</th><th style="padding:6px 10px;text-align:left;">スキル</th><th style="padding:6px 10px;text-align:right;">スコア</th><th style="padding:6px 10px;text-align:left;">判定</th></tr></thead>' +
      '<tbody>' + evalRows + '</tbody>' +
    '</table>' +

    (dResult.overallSummary ?
      '<div style="background:#e8f0fe;border-left:4px solid #1a73e8;padding:12px 14px;margin:18px 0;font-size:13px;line-height:1.7;">' +
      '<b>Gemini 総評:</b><br>' + escapeHtml_(dResult.overallSummary).replace(/\n/g, '<br>') + '</div>' : '') +

    (sheetUrl ?
      '<p style="font-size:12px;color:#5f6368;margin-top:18px;">詳細データ・全受験者の集計は <a href="' + sheetUrl + '" style="color:#1a73e8;">結果保存シート</a> から確認できます。</p>' : '') +

    '<p style="font-size:11px;color:#9aa0a6;margin-top:18px;border-top:1px solid #dadce0;padding-top:12px;">' +
      'このメールは管理職昇格AIアセスメント Web App から自動送信されています。' +
    '</p>' +
  '</div>' +
'</div>';
}

function buildResultEmailText_(payload, dResult, s) {
  const m = Math.floor(s.elapsedSec/60), sec = s.elapsedSec%60;
  const lines = [];
  lines.push('管理職昇格AIアセスメント — 受験結果のお知らせ');
  lines.push('');
  lines.push('受験者: ' + payload.examinee.name + ' (' + payload.examinee.role + ')');
  lines.push('受験者メール: ' + (payload.examinee.email || '(未入力)'));
  lines.push('受験日時: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
  lines.push('所要時間: ' + m + '分' + sec + '秒');
  lines.push('提出ID: ' + s.submissionId);
  lines.push('');
  lines.push('===== 判定: ' + s.category + ' =====');
  lines.push('総合スコア: ' + s.totalScore + ' / ' + s.totalMax + ' 点 (' + s.totalPct + '%)');
  lines.push('及第点: ' + (PASS_PCT*100) + '%以上 / 優良: ' + (EXCELLENT_PCT*100) + '%以上 / セクションD最低: ' + (D_MIN_PCT*100) + '%以上');
  lines.push('');
  lines.push('セクション別スコア:');
  lines.push('  A. L1 基礎理解         : ' + s.sec.A.got + '/' + s.sec.A.max);
  lines.push('  B. L2 業務活用判断     : ' + s.sec.B.got + '/' + s.sec.B.max);
  lines.push('  C. L3 マネジメント応用 : ' + s.sec.C.got + '/' + s.sec.C.max);
  lines.push('  D. プロンプト記述      : ' + dResult.totalScore + '/' + dResult.totalMax);
  lines.push('');
  lines.push('セクションD ルーブリック別:');
  (dResult.evaluations || []).forEach((e, i) => {
    lines.push('  D' + (i+1) + ' ' + (e.skill || '') + ' : ' + (e.subtotal||0) + '/' + (e.maxPoints||15) + ' [' + (e.verdict || '') + ']');
  });
  if (dResult.overallSummary) {
    lines.push('');
    lines.push('Gemini 総評:');
    lines.push(dResult.overallSummary);
  }
  lines.push('');
  lines.push('---');
  lines.push('このメールは管理職昇格AIアセスメント Web App から自動送信されています。');
  return lines.join('\n');
}

function escapeHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
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

// Optional: test email sending. Sends a sample result mail to the script owner.
function testSendEmail() {
  const me = Session.getActiveUser().getEmail();
  if (!me) { Logger.log('実行ユーザーのメールアドレスが取得できませんでした'); return; }
  const payload = {
    examinee: { name:'テスト 太郎', role:'テスト部', email: me, evaluatorEmail: me }
  };
  const dResult = {
    totalScore: 60, totalMax: 90,
    evaluations: [
      { skill:'業務プロンプト設計力(5要素)', subtotal:12, maxPoints:15, verdict:'合格' },
      { skill:'マネジメント判断の線引き',      subtotal:10, maxPoints:15, verdict:'合格' },
      { skill:'業務自動化の設計',              subtotal: 9, maxPoints:15, verdict:'要再受験' },
      { skill:'高度な資料作成プロンプト',      subtotal:11, maxPoints:15, verdict:'合格' },
      { skill:'NotebookLM オンボーディング',  subtotal: 9, maxPoints:15, verdict:'要再受験' },
      { skill:'顧客ヒアリング→ Slides 提案',  subtotal: 9, maxPoints:15, verdict:'要再受験' },
    ],
    overallSummary: 'テストメールです。全体として基礎は固いが、自動化設計とオンボーディング設計でシナリオ固有の具体性に弱さあり。'
  };
  const s = {
    submissionId: 'TEST-' + Date.now(),
    sec: { A:{got:10,max:12}, B:{got:24,max:30}, C:{got:13,max:15} },
    totalScore: 10+24+13+60, totalMax: 12+30+15+90,
    totalPct: 72.8, dPct: 66.7,
    category: '及第点',
    elapsedSec: 38*60
  };
  const result = sendResultEmail_(payload, dResult, s);
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('残りメール送信枠: ' + MailApp.getRemainingDailyQuota());
}
