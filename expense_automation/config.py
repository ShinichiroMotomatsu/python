"""
設定管理モジュール
環境変数または .env ファイルから設定を読み込む
"""
import os
from dataclasses import dataclass
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


@dataclass
class Config:
    # 楽楽精算
    rakuraku_url: str = ""
    rakuraku_company_id: str = ""
    rakuraku_user_id: str = ""
    rakuraku_password: str = ""

    # Google Calendar
    google_credentials_path: str = str(
        Path.home() / ".expense_automation" / "google_credentials.json"
    )
    google_calendar_id: str = "primary"

    # 動作設定
    headless: bool = False
    dry_run: bool = False
    slow_mo_ms: int = 500

    @classmethod
    def from_env(cls) -> "Config":
        """環境変数から設定を読み込む"""
        return cls(
            rakuraku_url=os.getenv("RAKURAKU_URL", ""),
            rakuraku_company_id=os.getenv("RAKURAKU_COMPANY_ID", ""),
            rakuraku_user_id=os.getenv("RAKURAKU_USER_ID", ""),
            rakuraku_password=os.getenv("RAKURAKU_PASSWORD", ""),
            google_credentials_path=os.getenv(
                "GOOGLE_CREDENTIALS_PATH",
                str(Path.home() / ".expense_automation" / "google_credentials.json"),
            ),
            google_calendar_id=os.getenv("GOOGLE_CALENDAR_ID", "primary"),
            headless=os.getenv("HEADLESS", "false").lower() == "true",
            dry_run=os.getenv("DRY_RUN", "false").lower() == "true",
            slow_mo_ms=int(os.getenv("SLOW_MO_MS", "500")),
        )

    def validate(self) -> list[str]:
        """必須設定の検証。不足している環境変数名のリストを返す"""
        errors = []
        if not self.rakuraku_url:
            errors.append("RAKURAKU_URL")
        if not self.rakuraku_user_id:
            errors.append("RAKURAKU_USER_ID")
        if not self.rakuraku_password:
            errors.append("RAKURAKU_PASSWORD")
        return errors
