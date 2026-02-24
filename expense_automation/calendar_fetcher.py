"""
Google Calendar APIを使って指定日の予定を取得し、
経費の目的・用途を特定するモジュール
"""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]
TOKEN_PATH = Path.home() / ".expense_automation" / "google_token.json"
CREDENTIALS_PATH = Path.home() / ".expense_automation" / "google_credentials.json"

JST = timezone(timedelta(hours=9))


class CalendarEvent:
    def __init__(self, raw: dict):
        self.id = raw.get("id", "")
        self.summary = raw.get("summary", "（タイトルなし）")
        self.description = raw.get("description", "")
        self.location = raw.get("location", "")
        self.attendees = [
            a.get("displayName") or a.get("email", "")
            for a in raw.get("attendees", [])
        ]
        self.organizer = raw.get("organizer", {}).get("displayName") or raw.get(
            "organizer", {}
        ).get("email", "")

        start = raw.get("start", {})
        if "dateTime" in start:
            self.start = datetime.fromisoformat(start["dateTime"])
            self.all_day = False
        else:
            self.start = datetime.strptime(start.get("date", ""), "%Y-%m-%d").replace(
                tzinfo=JST
            )
            self.all_day = True

    def to_purpose_text(self) -> str:
        """経費の目的文として使えるテキストを生成する"""
        parts = [self.summary]
        if self.attendees:
            parts.append(f"参加者: {', '.join(self.attendees[:5])}")
        if self.location:
            parts.append(f"場所: {self.location}")
        return " / ".join(parts)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "summary": self.summary,
            "description": self.description,
            "location": self.location,
            "attendees": self.attendees,
            "organizer": self.organizer,
            "start": self.start.isoformat(),
            "all_day": self.all_day,
        }


class CalendarFetcher:
    def __init__(
        self,
        credentials_path: str | None = None,
        token_path: str | None = None,
    ):
        self._credentials_path = Path(credentials_path or CREDENTIALS_PATH)
        self._token_path = Path(token_path or TOKEN_PATH)
        self._service = None

    def _get_service(self):
        if self._service:
            return self._service

        creds = self._load_credentials()
        self._service = build("calendar", "v3", credentials=creds)
        return self._service

    def _load_credentials(self) -> Credentials:
        creds = None
        self._token_path.parent.mkdir(parents=True, exist_ok=True)

        if self._token_path.exists():
            creds = Credentials.from_authorized_user_file(
                str(self._token_path), SCOPES
            )

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                if not self._credentials_path.exists():
                    raise FileNotFoundError(
                        f"Google認証ファイルが見つかりません: {self._credentials_path}\n"
                        "Google Cloud Consoleで OAuth2 クライアントIDを作成し、"
                        f"{self._credentials_path} に保存してください。"
                    )
                flow = InstalledAppFlow.from_client_secrets_file(
                    str(self._credentials_path), SCOPES
                )
                creds = flow.run_local_server(port=0)

            with open(self._token_path, "w") as token:
                token.write(creds.to_json())

        return creds

    def get_events_on_date(
        self, date_str: str, calendar_id: str = "primary"
    ) -> list[CalendarEvent]:
        """指定日のGoogle Calendarイベントを取得する

        Args:
            date_str: "YYYY-MM-DD" 形式の日付
            calendar_id: カレンダーID（デフォルト: primary）

        Returns:
            CalendarEventのリスト
        """
        date = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=JST)
        time_min = date.isoformat()
        time_max = (date + timedelta(days=1)).isoformat()

        try:
            service = self._get_service()
            result = (
                service.events()
                .list(
                    calendarId=calendar_id,
                    timeMin=time_min,
                    timeMax=time_max,
                    singleEvents=True,
                    orderBy="startTime",
                )
                .execute()
            )
            return [CalendarEvent(e) for e in result.get("items", [])]
        except HttpError as e:
            print(f"Google Calendar APIエラー: {e}")
            return []

    def find_best_match(
        self, events: list[CalendarEvent], vendor: str | None
    ) -> CalendarEvent | None:
        """経費に最も関連するイベントを選ぶ

        ベンダー名がイベントのタイトルや説明に含まれているか確認し、
        マッチするものを優先する。見つからなければ最初のイベントを返す。
        """
        if not events:
            return None

        if vendor:
            vendor_lower = vendor.lower()
            for event in events:
                if vendor_lower in event.summary.lower() or vendor_lower in (
                    event.description or ""
                ).lower():
                    return event

        return events[0]
