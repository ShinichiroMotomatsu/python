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
// dashboard.html の CLIENT_BUILD と必ず一致させる。Code.gs を更新したら
// この値も更新して、Web App の「新バージョン」デプロイを発行する。
// ダッシュボード上のバッジに DASH/SRV 双方のビルド ID が並び、Web App
// デプロイが古いままだと SRV 側が一致せず赤バッジで警告される。
const SERVER_BUILD        = '2026-05-29-detail-fix-2';
function getServerVersion() { return SERVER_BUILD; }

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
      'Gemini評価(JSON)','回答ログ(JSON)',
      'モード','職種大分類','職種(詳細)','AI活用記述','AI評価アドバイス(JSON)'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1,1,1,sheet.getLastColumn()).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
    sheet.setColumnWidth(1, 280); // submissionId
    sheet.setColumnWidth(2, 150); // timestamp
    sheet.setColumnWidth(3, 120); // 氏名
    sheet.setColumnWidth(18, 200); sheet.setColumnWidth(19, 200); // JSON columns
    sheet.setColumnWidth(20, 90); sheet.setColumnWidth(21, 140); sheet.setColumnWidth(22, 200);
    sheet.setColumnWidth(23, 280); sheet.setColumnWidth(24, 280);
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

    // 3) Gemini に「総合評価・現状の使い方コメント・今後のアドバイス」を生成依頼
    //    失敗しても提出は成功扱いとし、advice 部分は空で記録する
    let advice = null;
    try {
      advice = generateAssessmentAdvice_({
        examinee: payload.examinee,
        sec, dResult, totalScore, totalMax,
        totalPct: totalPct * 100, dPct: dPct * 100,
        category, dailyUsage: payload.dailyUsage || ''
      });
    } catch (adviceErr) {
      Logger.log('advice generation failed: ' + (adviceErr.message || adviceErr));
      advice = { _error: String(adviceErr.message || adviceErr) };
    }

    // 4) Sheets に保存
    const submissionId = Utilities.getUuid();
    saveToSheet_({
      submissionId, examinee: payload.examinee, elapsedSec: payload.elapsedSec || 0,
      sec, dResult, totalScore, totalMax, category,
      questionsLog: payload.questionsLog || [],
      mode: payload.examinee.mode || '',
      jobCategory: payload.examinee.jobCategory || '',
      jobTitle: payload.examinee.jobTitle || '',
      dailyUsage: payload.dailyUsage || '',
      advice: advice
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
      },
      advice: advice
    };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

// ---------------- AI 評価アドバイス生成 ----------------
/**
 * Gemini に「総合評価 / カテゴリ別理解状況 / 現状の使い方の評価 / 今後のアドバイス」
 * を一括生成依頼する。職種・モードに応じてプロンプトを切り替える。
 */
function generateAssessmentAdvice_(s) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(GEMINI_API_KEY_PROP);
  if (!apiKey) throw new Error('GEMINI_API_KEY 未設定のため、アドバイス生成をスキップします');

  const modeLabel = s.examinee.mode === 'onboarding' ? '管理職オンボーディング(昇格後3か月時点)' : '昇格試験(非管理職)';
  const audienceLabel = s.examinee.mode === 'onboarding'
    ? '管理職オンボーディングモード(昇格後3か月時点での役員面談の補助資料)'
    : '昇格試験モード(管理職昇格試験の面接の補助資料)';

  // セクション別評価のサマリ
  const dEvalsSummary = (s.dResult.evaluations || []).map((e, i) =>
    'D' + (i+1) + ' [' + (e.skill||'') + '] ' + (e.subtotal||0) + '/' + (e.maxPoints||15) +
    ' (' + (e.verdict||'') + ')'
  ).join('\n');

  const dailyUsageBlock = (s.dailyUsage && s.dailyUsage.trim().length > 0)
    ? s.dailyUsage.trim()
    : '(受験者からの記載なし)';

  const prompt =
    'あなたは、ある SaaS 企業(ラクス)の人材開発を支援する評価コメンテーターです。\n' +
    '受験者の AI アセスメント結果と本人の業務上の AI 活用状況の自由記載をもとに、面談で使う補助資料として\n' +
    '「総合評価」「セクション別の理解状況コメント」「現状の使い方への評価」「今後推奨される使い方のアドバイス」\n' +
    'を、職種特性を踏まえて日本語で生成してください。\n\n' +
    '【利用シーン】\n' + audienceLabel + '\n\n' +
    '【受験者情報】\n' +
    '- 氏名:' + (s.examinee.name || '') + '\n' +
    '- 所属:' + (s.examinee.role || '') + '\n' +
    '- 職種大分類:' + (s.examinee.jobCategory || '') + '\n' +
    '- 職種(詳細):' + (s.examinee.jobTitle || '') + '\n' +
    '- 受験モード:' + modeLabel + '\n\n' +
    '【スコア】\n' +
    '- A. L1 基礎理解              : ' + s.sec.A.got + '/' + s.sec.A.max + '\n' +
    '- B. L2 業務活用判断          : ' + s.sec.B.got + '/' + s.sec.B.max + '\n' +
    '- C. L3 マネジメント応用      : ' + s.sec.C.got + '/' + s.sec.C.max + '\n' +
    '- D. プロンプト記述 (Gemini)  : ' + s.dResult.totalScore + '/' + s.dResult.totalMax + '\n' +
    '- 総合                       : ' + s.totalScore + '/' + s.totalMax + ' (' + Math.round(s.totalPct*10)/10 + '%)\n' +
    '- 判定カテゴリ               : ' + s.category + '\n\n' +
    '【セクションDの個別評価】\n' + (dEvalsSummary || '(評価無し)') + '\n\n' +
    '【受験者本人による「日々の業務で AI をどう使っているか」の自由記載】\n' + dailyUsageBlock + '\n\n' +
    '【生成上の注意】\n' +
    '- 全文を通して敬体(です・ます)で書くこと\n' +
    '- 受験者の職種特性を踏まえて、当該職種で AI 活用が効くシーンを具体的に挙げること\n' +
    (s.examinee.mode === 'onboarding'
      ? '- 「数値マネジメント」「ピープルマネジメント」での AI 活用を必ず一言以上触れること\n'
      : '- 個人業務の効率化と、チームの成果最大化(非管理職でもできる範囲)の両面を触れること\n') +
    '- 称賛だけでなく、実行可能な具体提案(プロンプトの型・ツール選び・運用習慣)を 2〜4 個含めること\n' +
    '- 自由記載が無い場合は「日常活用の言語化が不足している」点を率直に指摘すること\n' +
    '- セキュリティ(ラクス AIサービス利活用ガイドライン:認証情報・NDA下他社秘密・顧客委託個人情報の入力NG)に反する記載があれば、必ず注意喚起すること';

  const schema = {
    type: 'OBJECT',
    properties: {
      overall_summary:          { type: 'STRING' },
      category_assessment: {
        type: 'OBJECT',
        properties: {
          A: { type: 'STRING' },
          B: { type: 'STRING' },
          C: { type: 'STRING' },
          D: { type: 'STRING' }
        },
        required: ['A','B','C','D']
      },
      current_usage_assessment: { type: 'STRING' },
      advice:                   { type: 'STRING' }
    },
    required: ['overall_summary','category_assessment','current_usage_assessment','advice']
  };

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  const { jsonStr } = callGeminiWithRetry_(body, apiKey);
  const parsed = JSON.parse(jsonStr);
  return parsed;
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
    JSON.stringify(o.questionsLog).substring(0, 49000), // セル上限対策
    o.mode || '',
    o.jobCategory || '',
    o.jobTitle || '',
    (o.dailyUsage || '').substring(0, 4900),
    o.advice ? JSON.stringify(o.advice).substring(0, 9000) : ''
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
      mode: ix['モード'] != null ? r[ix['モード']] : '',
      jobCategory: ix['職種大分類'] != null ? r[ix['職種大分類']] : '',
      jobTitle: ix['職種(詳細)'] != null ? r[ix['職種(詳細)']] : '',
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
 * シート schema の差異/ヘッダ名のズレ/列位置の変動に強い設計:
 *  1) ヘッダ行と対象行をそのまま読む
 *  2) ヘッダ名で obj を作る(ヘッダ通りのアクセスが効く場合)
 *  3) ヘッダが壊れていても、行内の文字列値をスキャンして
 *     dResult JSON / qLog JSON を発見できれば拾う
 *  4) 必ずオブジェクトを返す(null を返さない)。何かおかしければ
 *     _diagnostic にその情報を入れる。
 */
function getSubmissionByRow(rowIndex) {
  const out = { _diagnostic: {} };
  try {
    const sheet = getOrCreateSheet_();
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    out._diagnostic.sheetName    = sheet.getName();
    out._diagnostic.lastRow      = lastRow;
    out._diagnostic.lastCol      = lastCol;
    out._diagnostic.requestedRow = rowIndex;

    if (!rowIndex || rowIndex < 2 || rowIndex > lastRow) {
      out._diagnostic.error = 'rowIndex が範囲外です (要求=' + rowIndex + ', 有効=2〜' + lastRow + ')';
      return out;
    }

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const row     = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
    out._diagnostic.headers = headers;

    headers.forEach((h, j) => { if (h) out[String(h).trim()] = row[j]; });

    // dResult / qLog JSON の発掘
    let dJsonRaw = out['Gemini評価(JSON)'];
    let qJsonRaw = out['回答ログ(JSON)'];
    if (typeof dJsonRaw !== 'string' || typeof qJsonRaw !== 'string') {
      // ヘッダ名と一致しなくても、行内の文字列値からそれっぽいものを拾う
      for (let i = 0; i < row.length; i++) {
        const v = row[i];
        if (typeof v !== 'string') continue;
        const s = v.trim();
        if ((typeof dJsonRaw !== 'string') && s.charAt(0) === '{' && s.indexOf('"evaluations"') >= 0) dJsonRaw = s;
        if ((typeof qJsonRaw !== 'string') && s.charAt(0) === '[') qJsonRaw = s;
      }
    }

    try { out.dResultParsed = (typeof dJsonRaw === 'string') ? JSON.parse(dJsonRaw) : null; }
    catch (e) { out.dResultParsed = null; out._diagnostic.dParseError = String(e.message || e); }
    try { out.qLogParsed = (typeof qJsonRaw === 'string') ? JSON.parse(qJsonRaw) : null; }
    catch (e) { out.qLogParsed = null; out._diagnostic.qParseError = String(e.message || e); }

    // AI 評価アドバイス JSON もパース
    const adviceRaw = out['AI評価アドバイス(JSON)'];
    if (typeof adviceRaw === 'string' && adviceRaw.trim().length > 0) {
      try { out.adviceParsed = JSON.parse(adviceRaw); }
      catch (e) { out.adviceParsed = null; out._diagnostic.adviceParseError = String(e.message || e); }
    } else {
      out.adviceParsed = null;
    }

    if (out['受験日時']) {
      try { out.timestamp = Utilities.formatDate(new Date(out['受験日時']), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'); } catch (e) {}
    }
    return out;
  } catch (e) {
    out._diagnostic.error = String(e.message || e);
    return out;
  }
}

/**
 * 後方互換: submissionId 文字列から行を引く。
 * 新規 UI は getSubmissionDetailFlexible を使うこと。
 */
function getSubmissionDetail(submissionId) {
  return getSubmissionDetailFlexible({ submissionId: submissionId });
}

/**
 * 行番号 / submissionId のどちらか(または両方)で受験詳細を取得する。
 *   1) rowIndex が有効ならそれで読む
 *   2) ダメなら submissionId 列を探して該当行を見つけて読む
 *   3) どちらも失敗したら必ず _diagnostic 入りオブジェクトを返す
 * クライアントは null チェックする必要なく、d._diagnostic.error の有無で
 * 結果の信頼性を判断できる。
 */
function getSubmissionDetailFlexible(query) {
  query = query || {};
  const sheet = getOrCreateSheet_();
  const lastRow = sheet.getLastRow();

  // (1) rowIndex 直接
  if (query.rowIndex && Number(query.rowIndex) >= 2 && Number(query.rowIndex) <= lastRow) {
    const r = getSubmissionByRow(Number(query.rowIndex));
    if (r && !r._diagnostic.error) return r;
  }

  // (2) submissionId フォールバック
  if (query.submissionId) {
    const data = sheet.getDataRange().getValues();
    if (data && data.length >= 2) {
      const headers = data[0];
      let idCol = headers.indexOf('submissionId');
      // ヘッダ名がブレている場合は列0(常に submissionId を最初に書いている)を当てにする
      if (idCol < 0) idCol = 0;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][idCol]) === String(query.submissionId)) {
          const r = getSubmissionByRow(i + 1);
          r._diagnostic.matchedBy = 'submissionId';
          return r;
        }
      }
    }
    return {
      _diagnostic: {
        error: 'submissionId に一致する行が見つかりませんでした',
        searchedSubmissionId: query.submissionId,
        sheetName: sheet.getName(),
        lastRow: lastRow
      }
    };
  }

  return {
    _diagnostic: {
      error: 'rowIndex も submissionId も指定されていません',
      query: query
    }
  };
}

/**
 * 同上を「JSON 文字列で返す」バリアント。
 * 既知の問題: google.script.run はサーバ側で正しく構築したオブジェクトを
 * クライアントへ運ぶ際に null に化けるケースが報告されている(オブジェクト内に
 * Date / 親オブジェクトキーが括弧を含む等の組み合わせで発生しうる)。
 * ここでは responseObj を JSON.stringify してプレーン文字列として返すことで、
 * 経路の serialize 周りの揺れを回避する。クライアント側で JSON.parse する。
 */
function getSubmissionDetailFlexibleString(query) {
  const obj = getSubmissionDetailFlexible(query);
  try {
    // 受験日時(Date) を文字列化してから stringify(循環参照は元から無いが念のため)
    const safe = (function clone(v){
      if (v === null || v === undefined) return v;
      if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      if (Array.isArray(v)) return v.map(clone);
      if (typeof v === 'object') {
        const out = {};
        Object.keys(v).forEach(k => { out[k] = clone(v[k]); });
        return out;
      }
      return v;
    })(obj);
    return JSON.stringify(safe);
  } catch (e) {
    return JSON.stringify({ _diagnostic: { error: 'serializeError: ' + (e.message || e) } });
  }
}

// ---------------- Sheet migration ----------------
/**
 * シートを現行の 24 列スキーマに正規化する。
 *
 * 過去のバージョンでヘッダが {21列(メール列あり) / 19列(メール列なし) /
 * 24列(現行)} と変わってきており、運用中のシートではヘッダ行と
 * 実データの位置がズレている可能性がある。本関数は:
 *   1) 元のシートを Results_backup_yyyyMMdd_HHmmss にリネームして退避
 *   2) 新しい Results シートを 24 列スキーマで再作成
 *   3) 旧データを 1 行ずつ「内容」から書式バージョンを推定して正規化し再書き込み
 *
 * 推定ロジック: 5列目(E列)がメールアドレスっぽい文字列なら 21列スキーマ、
 *               そうでなければ 19列もしくは 24列スキーマと判定する。
 *
 * 実行手順(スクリプトエディタから):
 *   1. シートを開いて事前に手動バックアップ(念のため)
 *   2. migrateSheetToCanonicalSchema を実行
 *   3. 実行ログでバックアップ名と移行件数を確認
 *   4. 新 Results シートを開いて、列ヘッダと値の整合を目視確認
 *
 * 一度しか実行する必要はない。再実行する場合はバックアップシートが
 * もう一段増えるだけ。
 */


function migrateSheetToCanonicalSchema() {
  const ssId = PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROP);
  if (!ssId) throw new Error('SHEET_ID_PROP が未設定です。先に setupSpreadsheet を実行してください。');
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('"' + SHEET_NAME + '" シートが見つかりません');

  const data = sheet.getDataRange().getValues();
  if (data.length < 1) { Logger.log('データが無いため移行不要'); return; }

  const CANONICAL_HEADERS = [
    'submissionId','受験日時','氏名','所属','所要(秒)',
    'A_got','A_max','B_got','B_max','C_got','C_max','D_got','D_max',
    '総合','満点','達成率(%)','カテゴリ',
    'Gemini評価(JSON)','回答ログ(JSON)',
    'モード','職種大分類','職種(詳細)','AI活用記述','AI評価アドバイス(JSON)'
  ];

  // メール文字列っぽいか(@ を含むか) を判定するヘルパ
  const looksEmail = v => typeof v === 'string' && v.indexOf('@') > 0;

  const normalized = [];
  const stats = { v21:0, v19:0, v24:0, unknown:0 };

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    // 行のスキーマを推定
    const col4 = r[4], col5 = r[5];
    let schema;
    if (looksEmail(col4) || looksEmail(col5)) {
      schema = 21; // 受験者メール / 評価者メール 列が残っている
    } else if (r.length >= 20 && (r[19] === 'promotion' || r[19] === 'onboarding')) {
      schema = 24; // モード列が入っている現行
    } else {
      schema = 19; // メール列無し、追加5列も無し
    }
    stats['v' + schema]++;

    let row;
    if (schema === 21) {
      row = [
        r[0], r[1], r[2], r[3],          // subId, date, name, role
        r[6],                             // elapsed(7番目)
        r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14],
        r[15], r[16], r[17], r[18],
        r[19], r[20],
        '', '', '', '', ''
      ];
    } else if (schema === 19) {
      row = [
        r[0], r[1], r[2], r[3], r[4],
        r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12],
        r[13], r[14], r[15], r[16],
        r[17], r[18],
        '', '', '', '', ''
      ];
    } else {
      // 24 列(現行スキーマ)はそのまま24列分を取り出す
      row = [];
      for (let j = 0; j < 24; j++) row.push(j < r.length ? r[j] : '');
    }
    normalized.push(row);
  }

  // 旧シートをタイムスタンプ付きでリネームしてバックアップ
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  const backupName = SHEET_NAME + '_backup_' + stamp;
  sheet.setName(backupName);

  // 新しい Results シートを 24 列スキーマで作成
  const ns = ss.insertSheet(SHEET_NAME);
  ns.appendRow(CANONICAL_HEADERS);
  ns.setFrozenRows(1);
  ns.getRange(1, 1, 1, CANONICAL_HEADERS.length)
    .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
  ns.setColumnWidth(1, 280); ns.setColumnWidth(2, 150); ns.setColumnWidth(3, 120);
  ns.setColumnWidth(18, 200); ns.setColumnWidth(19, 200);
  ns.setColumnWidth(20, 90);  ns.setColumnWidth(21, 140); ns.setColumnWidth(22, 200);
  ns.setColumnWidth(23, 280); ns.setColumnWidth(24, 280);

  if (normalized.length > 0) {
    ns.getRange(2, 1, normalized.length, CANONICAL_HEADERS.length).setValues(normalized);
  }

  Logger.log('Migration 完了');
  Logger.log('  バックアップ: ' + backupName + ' (元データはそのまま保持)');
  Logger.log('  移行件数: ' + normalized.length + ' 行');
  Logger.log('  スキーマ別内訳: 21列(旧emailあり)=' + stats.v21 +
             ' / 19列(emailなし)=' + stats.v19 +
             ' / 24列(現行)=' + stats.v24);
}

/**
 * デバッグ用: ダッシュボードの「詳細」ボタンと同じ経路でサーバ側を呼び出し、
 * 戻り値の構造を Logger.log で確認する。スクリプトエディタから直接実行する。
 *
 * 「サーバから空の応答が返りました」が出るケースの切り分けに使う:
 *   - この関数で `out` がオブジェクトとして返れば、サーバ側のロジックは健全。
 *     → 原因はクライアント側のキャッシュやデプロイバージョン古い問題。
 *   - この関数自体がエラーで止まれば、サーバ側にバグあり。エラー文を確認。
 *   - 期待した内容と違う(例:diagnostic にエラー)ならログを共有。
 */
function debugSubmissionDetailLookup(rowIndex) {
  const rIdx = Number(rowIndex) || 2;
  Logger.log('=== getSubmissionDetailFlexible({rowIndex: ' + rIdx + '}) を実行 ===');
  let r;
  try {
    r = getSubmissionDetailFlexible({ rowIndex: rIdx, submissionId: '' });
  } catch (e) {
    Logger.log('!! サーバー関数自体が例外: ' + (e.message || e));
    Logger.log('   stack: ' + (e.stack || '(stack なし)'));
    return { error: String(e.message || e) };
  }
  Logger.log('returned typeof: ' + typeof r);
  Logger.log('returned is null?: ' + (r === null));
  Logger.log('returned is undefined?: ' + (r === undefined));
  if (r && typeof r === 'object') {
    Logger.log('keys: ' + Object.keys(r).join(', '));
    if (r._diagnostic) Logger.log('_diagnostic: ' + JSON.stringify(r._diagnostic, null, 2));
    Logger.log('氏名: ' + r['氏名']);
    Logger.log('カテゴリ: ' + r['カテゴリ']);
    Logger.log('総合/満点: ' + r['総合'] + ' / ' + r['満点']);
    Logger.log('dResultParsed type: ' + typeof r.dResultParsed);
    Logger.log('adviceParsed type: ' + typeof r.adviceParsed);
  }
  return r;
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
