"""
Playwrightを使って楽楽精算にレシートを登録し、
Google Calendarの予定情報で目的・用途を補完するモジュール

楽楽精算のレシート登録機能（OCR）を利用するため、
金額・日付・支払先はシステムが自動読み取りします。
"""
import time
from dataclasses import dataclass, field
from pathlib import Path

from playwright.sync_api import Page, sync_playwright, TimeoutError as PlaywrightTimeoutError

from .calendar_fetcher import CalendarEvent


# 楽楽精算のセレクタ設定（テナントによって異なる場合はカスタマイズしてください）
DEFAULT_SELECTORS = {
    # ログイン画面
    "login_company_id": 'input[name="company_id"], #company_id, input[placeholder*="会社ID"]',
    "login_user_id": 'input[name="user_id"], #user_id, input[placeholder*="ユーザーID"], input[placeholder*="メールアドレス"]',
    "login_password": 'input[type="password"]',
    "login_submit": 'button[type="submit"], input[type="submit"]',

    # レシート登録
    "receipt_upload_menu": 'a:has-text("レシート登録"), a:has-text("証憑登録"), nav a[href*="receipt"]',
    "receipt_file_input": 'input[type="file"]',
    "receipt_upload_button": 'button:has-text("アップロード"), button:has-text("登録"), button:has-text("読み取り")',

    # OCR結果確認・補完フォーム（レシート登録後に表示されるフォーム）
    "ocr_purpose": 'textarea[name*="purpose"], input[name*="purpose"], textarea[placeholder*="目的"], textarea[placeholder*="用途"], #purpose',
    "ocr_notes": 'textarea[name*="note"], textarea[name*="memo"], textarea[placeholder*="備考"], #notes',
    "ocr_category": 'select[name*="category"], select[name*="expense_type"], #category',
    "ocr_date": 'input[name*="date"], input[type="date"], #date',
    "ocr_amount": 'input[name*="amount"], input[type="number"], #amount',
    "ocr_vendor": 'input[name*="vendor"], input[name*="shop"], input[placeholder*="支払先"], #vendor',

    # 申請操作
    "save_button": 'button:has-text("保存"), button:has-text("一時保存"), button:has-text("下書き")',
    "apply_button": 'button:has-text("申請"), button:has-text("提出")',
    "confirm_ok": 'button:has-text("OK"), button:has-text("確認"), button:has-text("はい")',
}

# 楽楽精算の経費科目マッピング（テナントの設定に合わせて調整してください）
CATEGORY_MAPPING = {
    "交通費": ["交通費", "旅費交通費"],
    "宿泊費": ["宿泊費", "旅費"],
    "会議費": ["会議費", "会議・打合費"],
    "接待交際費": ["接待交際費", "接待費", "交際費"],
    "物品費": ["物品費", "消耗品費"],
    "通信費": ["通信費"],
    "その他": ["その他", "雑費"],
}


@dataclass
class ReceiptSubmission:
    """登録するレシートの情報"""
    image_path: str
    # 以下はオプション。指定しない場合はOCR結果を使用
    date: str | None = None
    amount: int | None = None
    vendor: str | None = None
    category: str | None = None
    # 目的はGoogle Calendarから自動生成
    purpose: str = ""
    notes: str = ""


@dataclass
class SubmissionResult:
    success: bool
    image_path: str
    purpose_used: str = ""
    error_message: str = ""
    submission_id: str = ""


class ExpenseSubmitter:
    def __init__(
        self,
        rakuraku_url: str,
        company_id: str,
        user_id: str,
        password: str,
        headless: bool = False,
        selectors: dict | None = None,
        slow_mo: int = 500,
    ):
        self.rakuraku_url = rakuraku_url.rstrip("/")
        self.company_id = company_id
        self.user_id = user_id
        self.password = password
        self.headless = headless
        self.selectors = {**DEFAULT_SELECTORS, **(selectors or {})}
        self.slow_mo = slow_mo

    def submit_receipts(
        self,
        receipts: list[ReceiptSubmission],
        calendar_events_map: dict[str, list[CalendarEvent]] | None = None,
        dry_run: bool = False,
    ) -> list[SubmissionResult]:
        """複数のレシートを楽楽精算に登録する

        Args:
            receipts: 登録するレシートのリスト
            calendar_events_map: {"YYYY-MM-DD": [CalendarEvent, ...]} 形式
            dry_run: Trueの場合、入力はするが最終申請ボタンを押さない
        """
        results = []
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=self.headless,
                slow_mo=self.slow_mo,
            )
            context = browser.new_context(
                viewport={"width": 1280, "height": 900},
                locale="ja-JP",
            )
            page = context.new_page()

            try:
                self._login(page)

                for receipt in receipts:
                    result = self._process_receipt(
                        page, receipt, calendar_events_map or {}, dry_run
                    )
                    results.append(result)

                    status = "[OK]" if result.success else "[NG]"
                    msg = result.error_message if not result.success else result.purpose_used
                    print(f"  {status} {Path(receipt.image_path).name}: {msg}")

            finally:
                browser.close()

        return results

    def _login(self, page: Page) -> None:
        """楽楽精算にログインする"""
        print("ログイン中...")
        page.goto(self.rakuraku_url)
        page.wait_for_load_state("networkidle")

        # 会社IDフィールドがある場合のみ入力（シングルテナント環境は不要）
        try:
            company_input = page.query_selector(self.selectors["login_company_id"])
            if company_input and self.company_id:
                company_input.fill(self.company_id)
        except Exception:
            pass

        page.fill(self.selectors["login_user_id"], self.user_id)
        page.fill(self.selectors["login_password"], self.password)
        page.click(self.selectors["login_submit"])
        page.wait_for_load_state("networkidle")

        if "login" in page.url.lower() or "signin" in page.url.lower():
            raise RuntimeError("ログインに失敗しました。認証情報を確認してください。")
        print("ログイン成功")

    def _process_receipt(
        self,
        page: Page,
        receipt: ReceiptSubmission,
        calendar_events_map: dict[str, list[CalendarEvent]],
        dry_run: bool,
    ) -> SubmissionResult:
        """1件のレシートを処理する"""
        image_path = receipt.image_path

        if not Path(image_path).exists():
            return SubmissionResult(
                success=False,
                image_path=image_path,
                error_message=f"ファイルが見つかりません: {image_path}",
            )

        try:
            # レシート登録画面へ移動
            self._navigate_to_receipt_upload(page)

            # レシート画像をアップロード（楽楽精算のOCRが動作）
            self._upload_receipt_image(page, image_path)

            # OCR完了を待機
            self._wait_for_ocr(page)

            # OCR後に不足情報を補完
            date_used = receipt.date or self._read_ocr_date(page)
            self._fill_missing_fields(page, receipt)

            # Google Calendarから目的を生成・入力
            purpose = self._build_purpose(receipt, date_used, calendar_events_map)
            self._fill_purpose(page, purpose)

            if not dry_run:
                submission_id = self._submit(page)
                return SubmissionResult(
                    success=True,
                    image_path=image_path,
                    purpose_used=purpose,
                    submission_id=submission_id,
                )
            else:
                print("    [DRY RUN] 申請をスキップ")
                return SubmissionResult(
                    success=True,
                    image_path=image_path,
                    purpose_used=f"[DRY RUN] {purpose}",
                )

        except PlaywrightTimeoutError as e:
            return SubmissionResult(
                success=False,
                image_path=image_path,
                error_message=f"タイムアウト: {e}",
            )
        except Exception as e:
            return SubmissionResult(
                success=False,
                image_path=image_path,
                error_message=str(e),
            )

    def _navigate_to_receipt_upload(self, page: Page) -> None:
        """レシート登録画面へ移動する"""
        page.click(self.selectors["receipt_upload_menu"])
        page.wait_for_load_state("networkidle")

    def _upload_receipt_image(self, page: Page, image_path: str) -> None:
        """レシート画像をアップロードする"""
        file_input = page.wait_for_selector(
            self.selectors["receipt_file_input"], timeout=10000
        )
        file_input.set_input_files(image_path)

        # アップロードボタンがある場合はクリック
        upload_btn = page.query_selector(self.selectors["receipt_upload_button"])
        if upload_btn:
            upload_btn.click()

    def _wait_for_ocr(self, page: Page, timeout: int = 30000) -> None:
        """OCR処理の完了を待機する

        楽楽精算はレシートアップロード後にOCRで金額・日付等を読み取る。
        フォームフィールドに値が入るまで待機する。
        """
        try:
            # 金額フィールドに値が入るのを待つ
            page.wait_for_function(
                f"""() => {{
                    const el = document.querySelector('{self.selectors["ocr_amount"].split(",")[0].strip()}');
                    return el && el.value && el.value !== '';
                }}""",
                timeout=timeout,
            )
        except PlaywrightTimeoutError:
            # OCRがない/タイムアウトした場合は処理を続行
            page.wait_for_load_state("networkidle")

    def _read_ocr_date(self, page: Page) -> str | None:
        """OCRで読み取られた日付を取得する"""
        date_input = page.query_selector(self.selectors["ocr_date"])
        if date_input:
            return date_input.input_value() or None
        return None

    def _fill_missing_fields(self, page: Page, receipt: ReceiptSubmission) -> None:
        """OCRで読み取れなかったフィールドを手動で補完する"""
        if receipt.date:
            date_input = page.query_selector(self.selectors["ocr_date"])
            if date_input and not date_input.input_value():
                date_input.fill(receipt.date)

        if receipt.amount is not None:
            amount_input = page.query_selector(self.selectors["ocr_amount"])
            if amount_input and not amount_input.input_value():
                amount_input.fill(str(receipt.amount))

        if receipt.vendor:
            vendor_input = page.query_selector(self.selectors["ocr_vendor"])
            if vendor_input and not vendor_input.input_value():
                vendor_input.fill(receipt.vendor)

        if receipt.category:
            self._select_category(page, receipt.category)

        if receipt.notes:
            notes_input = page.query_selector(self.selectors["ocr_notes"])
            if notes_input:
                notes_input.fill(receipt.notes)

    def _select_category(self, page: Page, category: str) -> None:
        """経費科目プルダウンを選択する"""
        select = page.query_selector(self.selectors["ocr_category"])
        if not select:
            return

        candidates = CATEGORY_MAPPING.get(category, [category])
        options = select.query_selector_all("option")
        option_texts = [o.inner_text().strip() for o in options]

        for candidate in candidates:
            for i, text in enumerate(option_texts):
                if candidate in text:
                    select.select_option(index=i)
                    return

    def _build_purpose(
        self,
        receipt: ReceiptSubmission,
        date: str | None,
        calendar_events_map: dict[str, list[CalendarEvent]],
    ) -> str:
        """経費の目的文を構築する

        優先順位:
        1. ReceiptSubmissionに直接指定されたpurpose
        2. Google CalendarのイベントからAIが生成
        3. フォールバック（空文字）
        """
        if receipt.purpose:
            return receipt.purpose

        if date and date in calendar_events_map:
            events = calendar_events_map[date]
            if events:
                return events[0].to_purpose_text()

        return ""

    def _fill_purpose(self, page: Page, purpose: str) -> None:
        """目的フィールドに入力する"""
        if not purpose:
            return
        purpose_input = page.query_selector(self.selectors["ocr_purpose"])
        if purpose_input:
            purpose_input.fill(purpose)

    def _submit(self, page: Page) -> str:
        """申請ボタンを押して送信する"""
        # 確認ダイアログが出る場合の対応
        apply_btn = page.query_selector(self.selectors["apply_button"])
        if apply_btn:
            apply_btn.click()
        else:
            page.click(self.selectors["save_button"])

        # 確認ダイアログのOKボタン
        try:
            confirm = page.wait_for_selector(
                self.selectors["confirm_ok"], timeout=5000
            )
            if confirm:
                confirm.click()
        except PlaywrightTimeoutError:
            pass

        page.wait_for_load_state("networkidle")

        # 申請IDを取得（存在する場合）
        id_el = page.query_selector('[class*="application-id"], [id*="app-id"], [class*="slip-no"]')
        return id_el.inner_text().strip() if id_el else ""
