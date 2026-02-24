"""
経費精算自動化メインスクリプト

使い方:
    python -m expense_automation.main receipts/20260224_lunch.jpg receipts/20260223_taxi.jpg

    # ドライラン（申請ボタンを押さない）
    DRY_RUN=true python -m expense_automation.main receipts/*.jpg

    # ヘッドレスモード
    HEADLESS=true python -m expense_automation.main receipts/*.jpg
"""
import argparse
import sys
from pathlib import Path

from .calendar_fetcher import CalendarFetcher
from .config import Config
from .expense_submitter import ExpenseSubmitter, ReceiptSubmission


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="楽楽精算にレシートを一括登録します",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
例:
  python -m expense_automation.main receipts/20260224_lunch.jpg
  python -m expense_automation.main receipts/*.jpg --dry-run
  python -m expense_automation.main receipts/*.jpg --headless
        """,
    )
    parser.add_argument(
        "receipts",
        nargs="+",
        help="登録するレシート画像ファイル（JPG/PNG）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="フォームを入力するが申請ボタンを押さない",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="ブラウザを表示せずに実行する",
    )
    parser.add_argument(
        "--no-calendar",
        action="store_true",
        help="Google Calendarとの連携をスキップする",
    )
    args = parser.parse_args(argv)

    # 設定読み込み
    config = Config.from_env()
    if args.dry_run:
        config.dry_run = True
    if args.headless:
        config.headless = True

    missing = config.validate()
    if missing:
        print(f"エラー: 以下の環境変数が設定されていません: {', '.join(missing)}")
        print(".env.example を参考に .env ファイルを作成してください。")
        return 1

    # レシートファイルの確認
    receipt_paths = []
    for pattern in args.receipts:
        path = Path(pattern)
        if path.exists():
            receipt_paths.append(str(path))
        else:
            print(f"警告: ファイルが見つかりません: {pattern}")

    if not receipt_paths:
        print("エラー: 有効なレシートファイルがありません")
        return 1

    print(f"\n対象レシート: {len(receipt_paths)} 件")
    for p in receipt_paths:
        print(f"  - {p}")

    # Google Calendarから予定を取得
    calendar_events_map: dict = {}
    if not args.no_calendar:
        print("\nGoogle Calendarから予定を取得中...")
        try:
            fetcher = CalendarFetcher(
                credentials_path=config.google_credentials_path,
            )
            # レシートのファイル名から日付を推測して取得
            dates = _extract_dates_from_filenames(receipt_paths)
            for date in dates:
                events = fetcher.get_events_on_date(date, config.google_calendar_id)
                if events:
                    calendar_events_map[date] = events
                    print(f"  {date}: {len(events)} 件の予定")
        except FileNotFoundError as e:
            print(f"  Google Calendar連携をスキップします（{e}）")
        except Exception as e:
            print(f"  Google Calendar連携でエラーが発生しました: {e}")
            print("  --no-calendar オプションでスキップできます")

    # 楽楽精算へ登録
    print(f"\n楽楽精算への登録を開始します{'（DRY RUN）' if config.dry_run else ''}...")
    submitter = ExpenseSubmitter(
        rakuraku_url=config.rakuraku_url,
        company_id=config.rakuraku_company_id,
        user_id=config.rakuraku_user_id,
        password=config.rakuraku_password,
        headless=config.headless,
        slow_mo=config.slow_mo_ms,
    )

    receipts = [ReceiptSubmission(image_path=p) for p in receipt_paths]
    results = submitter.submit_receipts(
        receipts=receipts,
        calendar_events_map=calendar_events_map,
        dry_run=config.dry_run,
    )

    # 結果サマリー
    succeeded = sum(1 for r in results if r.success)
    failed = len(results) - succeeded
    print(f"\n完了: {succeeded} 件成功 / {failed} 件失敗")

    if failed > 0:
        print("\n失敗したレシート:")
        for r in results:
            if not r.success:
                print(f"  - {r.image_path}: {r.error_message}")
        return 1

    return 0


def _extract_dates_from_filenames(paths: list[str]) -> list[str]:
    """ファイル名から日付（YYYYMMDD または YYYY-MM-DD）を抽出する

    例: "20260224_lunch.jpg" -> "2026-02-24"
    """
    import re
    dates = set()
    patterns = [
        r"(\d{4})-(\d{2})-(\d{2})",  # YYYY-MM-DD
        r"(\d{4})(\d{2})(\d{2})",     # YYYYMMDD
    ]
    for path in paths:
        name = Path(path).stem
        for pattern in patterns:
            m = re.search(pattern, name)
            if m:
                dates.add(f"{m.group(1)}-{m.group(2)}-{m.group(3)}")
                break
    return sorted(dates)


if __name__ == "__main__":
    sys.exit(main())
