"""
Server-side fetchers for public game archives (Lichess, Chess.com).

Uses `urllib.request` (the venv has no `requests`). Each fetcher returns a list
of normalized game records, newest first:

    {
        "source", "external_id", "url", "pgn",
        "white", "black", "result",        # result: "1-0" / "0-1" / "1/2-1/2"
        "played_at",                        # ISO 8601 string or None
        "time_class",
    }

`player_view(record, username)` then annotates the tracked player's color and
result (win/loss/draw) for the given username.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from typing import Any

_UA = "chess-engine-analyzer/1.0 (personal player-db feature)"


class SourceError(Exception):
    """Raised when a remote archive cannot be fetched or parsed."""


def _get(url: str, accept: str = "application/json", timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise SourceError(f"HTTP {e.code} for {url}") from e
    except urllib.error.URLError as e:
        raise SourceError(f"Network error for {url}: {e.reason}") from e


def _epoch_to_iso(value: float | None, unit: str) -> str | None:
    if not value:
        return None
    seconds = value / 1000.0 if unit == "ms" else float(value)
    try:
        return datetime.fromtimestamp(seconds, tz=UTC).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


# --- LICHESS ---------------------------------------------------------------

def fetch_lichess(username: str, count: int) -> list[dict[str, Any]]:
    """Fetches the most recent `count` games for a Lichess user (NDJSON)."""
    # clocks=true keeps the [%clk] move times in the PGN, which the time-
    # management stats and the Review-board clocks read. Chess.com includes them
    # by default; Lichess omits them unless asked.
    url = (
        f"https://lichess.org/api/games/user/{urllib.parse.quote(username)}"
        f"?max={int(count)}&pgnInJson=true&clocks=true"
    )
    raw = _get(url, accept="application/x-ndjson").decode("utf-8", "replace")
    records: list[dict[str, Any]] = []
    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            g = json.loads(line)
        except json.JSONDecodeError:
            continue

        players = g.get("players", {})
        white = (players.get("white", {}).get("user") or {}).get("name") or "Anonymous"
        black = (players.get("black", {}).get("user") or {}).get("name") or "Anonymous"

        winner = g.get("winner")
        if winner == "white":
            result = "1-0"
        elif winner == "black":
            result = "0-1"
        else:
            result = "1/2-1/2"

        records.append({
            "source": "lichess",
            "external_id": g.get("id"),
            "url": f"https://lichess.org/{g.get('id')}" if g.get("id") else None,
            "pgn": g.get("pgn", ""),
            "white": white,
            "black": black,
            "result": result,
            "played_at": _epoch_to_iso(g.get("createdAt"), "ms"),
            "time_class": g.get("speed"),
        })
    return records


# --- CHESS.COM -------------------------------------------------------------

def fetch_chesscom(username: str, count: int) -> list[dict[str, Any]]:
    """
    Fetches the most recent `count` games for a Chess.com user by walking the
    monthly archives from newest to oldest until enough games are collected.
    """
    user = username.lower()
    archives_raw = _get(f"https://api.chess.com/pub/player/{urllib.parse.quote(user)}/games/archives")
    try:
        archives = json.loads(archives_raw).get("archives", [])
    except json.JSONDecodeError as e:
        raise SourceError("Malformed archives response from Chess.com") from e

    records: list[dict[str, Any]] = []
    for archive_url in reversed(archives):  # newest month first
        if len(records) >= count:
            break
        month_raw = _get(archive_url)
        try:
            games = json.loads(month_raw).get("games", [])
        except json.JSONDecodeError:
            continue

        for g in reversed(games):  # newest game first within the month
            if not g.get("pgn"):
                continue
            white = g.get("white", {})
            black = g.get("black", {})
            if white.get("result") == "win":
                result = "1-0"
            elif black.get("result") == "win":
                result = "0-1"
            else:
                result = "1/2-1/2"

            records.append({
                "source": "chesscom",
                "external_id": str(g.get("uuid") or g.get("url") or ""),
                "url": g.get("url"),
                "pgn": g.get("pgn", ""),
                "white": white.get("username"),
                "black": black.get("username"),
                "result": result,
                "played_at": _epoch_to_iso(g.get("end_time"), "s"),
                "time_class": g.get("time_class"),
            })
            if len(records) >= count:
                break

    return records[:count]


def fetch(platform: str, username: str, count: int) -> list[dict[str, Any]]:
    platform = (platform or "").lower()
    if platform in ("lichess", "li"):
        return fetch_lichess(username, count)
    if platform in ("chesscom", "chess.com", "cc"):
        return fetch_chesscom(username, count)
    raise SourceError(f"Unknown platform: {platform!r}")


# --- PLAYER PERSPECTIVE ----------------------------------------------------

def player_view(record: dict[str, Any], username: str) -> dict[str, str | None]:
    """
    Determines which color the tracked player had and their result (win/loss/
    draw) from the record. Falls back to white if the username matches neither
    side (e.g. name mismatch across platforms), so games are never dropped.
    """
    uname = (username or "").strip().lower()
    white = (record.get("white") or "").lower()
    black = (record.get("black") or "").lower()

    if uname and uname == black:
        color = "black"
    elif uname and uname == white:
        color = "white"
    else:
        # Unknown mapping: pick the side that matches loosely, else white.
        color = "black" if (uname and uname in black) else "white"

    result = record.get("result")
    if result == "1/2-1/2":
        player_result = "draw"
    elif result == "1-0":
        player_result = "win" if color == "white" else "loss"
    elif result == "0-1":
        player_result = "win" if color == "black" else "loss"
    else:
        player_result = None

    return {"player_color": color, "player_result": player_result}
