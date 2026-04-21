"""Google Calendar から予定を取得し、各予定の参加者一覧を表示する。

使い方:
    1. Google Cloud Console で Google Calendar API を有効化し、
       OAuth クライアント ID (デスクトップアプリ) を作成して
       credentials.json としてこのスクリプトと同じディレクトリに配置する。
    2. 必要なライブラリをインストールする:
           pip install -r requirements.txt
    3. スクリプトを実行する:
           python google_calendar_attendees.py
       任意で取得件数を指定できる:
           python google_calendar_attendees.py --max-results 20
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]
CREDENTIALS_FILE = "credentials.json"
TOKEN_FILE = "token.json"


def get_credentials() -> Credentials:
    creds: Credentials | None = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS_FILE):
                raise FileNotFoundError(
                    f"{CREDENTIALS_FILE} が見つかりません。Google Cloud Console から "
                    "OAuth クライアント ID をダウンロードして配置してください。"
                )
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(TOKEN_FILE, "w", encoding="utf-8") as token:
            token.write(creds.to_json())

    return creds


def fetch_events(service: Any, max_results: int, calendar_id: str) -> list[dict[str, Any]]:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    response = (
        service.events()
        .list(
            calendarId=calendar_id,
            timeMin=now,
            maxResults=max_results,
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )
    return response.get("items", [])


def format_event_time(event: dict[str, Any]) -> str:
    start = event.get("start", {})
    end = event.get("end", {})
    start_str = start.get("dateTime") or start.get("date") or "(不明)"
    end_str = end.get("dateTime") or end.get("date") or "(不明)"
    return f"{start_str} 〜 {end_str}"


def format_attendee(attendee: dict[str, Any]) -> str:
    name = attendee.get("displayName")
    email = attendee.get("email", "(メールなし)")
    status = attendee.get("responseStatus", "needsAction")
    status_label = {
        "accepted": "出席",
        "declined": "欠席",
        "tentative": "未定",
        "needsAction": "未回答",
    }.get(status, status)

    flags = []
    if attendee.get("organizer"):
        flags.append("主催者")
    if attendee.get("self"):
        flags.append("自分")
    if attendee.get("optional"):
        flags.append("任意")
    if attendee.get("resource"):
        flags.append("リソース")
    flag_str = f" [{', '.join(flags)}]" if flags else ""

    label = f"{name} <{email}>" if name else email
    return f"{label} - {status_label}{flag_str}"


def print_event(event: dict[str, Any]) -> None:
    summary = event.get("summary", "(タイトルなし)")
    when = format_event_time(event)
    location = event.get("location")
    organizer = event.get("organizer", {}).get("email", "")
    attendees = event.get("attendees", [])

    print("=" * 60)
    print(f"予定: {summary}")
    print(f"日時: {when}")
    if location:
        print(f"場所: {location}")
    if organizer:
        print(f"主催者: {organizer}")

    if not attendees:
        print("参加者: (登録された参加者はいません)")
        return

    print(f"参加者 ({len(attendees)}人):")
    for attendee in attendees:
        print(f"  - {format_attendee(attendee)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Google Calendar から予定と参加者一覧を取得して表示する"
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=10,
        help="取得する予定の最大件数 (デフォルト: 10)",
    )
    parser.add_argument(
        "--calendar-id",
        default="primary",
        help="対象カレンダーの ID (デフォルト: primary)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        creds = get_credentials()
        service = build("calendar", "v3", credentials=creds)
        events = fetch_events(service, args.max_results, args.calendar_id)
    except FileNotFoundError as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 1
    except HttpError as exc:
        print(f"Google Calendar API エラー: {exc}", file=sys.stderr)
        return 1

    if not events:
        print("これから始まる予定はありません。")
        return 0

    print(f"これからの予定 {len(events)} 件を表示します。\n")
    for event in events:
        print_event(event)
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
