"""Record normalisation for the remote archives — no network access."""

import json

import pytest

from player_db import ingest, sources

# --- fingerprint -----------------------------------------------------------

def test_fingerprint_is_stable_for_identical_pgn():
    pgn = "1. e4 e5 2. Nf3 Nc6"
    assert ingest.fingerprint(pgn) == ingest.fingerprint(pgn)


def test_fingerprint_ignores_line_ending_style():
    assert ingest.fingerprint("1. e4\r\n2. Nf3") == ingest.fingerprint("1. e4\n2. Nf3")


def test_fingerprint_ignores_trailing_whitespace():
    assert ingest.fingerprint("1. e4   \n2. Nf3") == ingest.fingerprint("1. e4\n2. Nf3")


def test_fingerprint_distinguishes_different_games():
    assert ingest.fingerprint("1. e4 e5") != ingest.fingerprint("1. d4 d5")


# --- player_view -----------------------------------------------------------

def test_player_view_detects_the_tracked_player_as_white():
    view = sources.player_view({"white": "Marco", "black": "Rival", "result": "1-0"}, "marco")
    assert view == {"player_color": "white", "player_result": "win"}


def test_player_view_detects_the_tracked_player_as_black():
    view = sources.player_view({"white": "Rival", "black": "Marco", "result": "1-0"}, "marco")
    assert view == {"player_color": "black", "player_result": "loss"}


def test_player_view_reads_a_draw_the_same_for_both_colors():
    for username in ("marco", "rival"):
        view = sources.player_view({"white": "Marco", "black": "Rival", "result": "1/2-1/2"}, username)
        assert view["player_result"] == "draw"


def test_player_view_is_case_insensitive():
    view = sources.player_view({"white": "MaRcO", "black": "Rival", "result": "1-0"}, "marco")
    assert view["player_color"] == "white"


def test_player_view_falls_back_to_white_when_the_name_matches_neither_side():
    view = sources.player_view({"white": "A", "black": "B", "result": "1-0"}, "someone-else")
    assert view["player_color"] == "white"
    assert view["player_result"] == "win"


def test_player_view_handles_a_missing_result():
    view = sources.player_view({"white": "Marco", "black": "Rival", "result": None}, "marco")
    assert view["player_result"] is None


# --- timestamps ------------------------------------------------------------

def test_epoch_milliseconds_are_converted_to_iso():
    assert sources._epoch_to_iso(1_700_000_000_000, "ms").startswith("2023-11-14")


def test_epoch_seconds_are_converted_to_iso():
    assert sources._epoch_to_iso(1_700_000_000, "s").startswith("2023-11-14")


def test_missing_timestamps_stay_none():
    assert sources._epoch_to_iso(None, "s") is None
    assert sources._epoch_to_iso(0, "s") is None


def test_out_of_range_timestamps_do_not_raise():
    assert sources._epoch_to_iso(1e30, "s") is None


# --- platform dispatch -----------------------------------------------------

def test_unknown_platform_is_rejected():
    with pytest.raises(sources.SourceError):
        sources.fetch("myspace-chess", "marco", 10)


def test_platform_aliases_route_to_the_right_fetcher(monkeypatch):
    seen = []
    monkeypatch.setattr(sources, "fetch_lichess", lambda u, c: seen.append("lichess") or [])
    monkeypatch.setattr(sources, "fetch_chesscom", lambda u, c: seen.append("chesscom") or [])

    for alias in ("lichess", "li", "LICHESS"):
        sources.fetch(alias, "marco", 1)
    for alias in ("chesscom", "chess.com", "cc"):
        sources.fetch(alias, "marco", 1)

    assert seen == ["lichess"] * 3 + ["chesscom"] * 3


# --- lichess parsing -------------------------------------------------------

def _ndjson(*objects):
    return ("\n".join(json.dumps(o) for o in objects)).encode()


def test_lichess_records_are_normalized(monkeypatch):
    payload = _ndjson({
        "id": "abc123",
        "pgn": "1. e4 e5",
        "winner": "white",
        "speed": "blitz",
        "createdAt": 1_700_000_000_000,
        "players": {
            "white": {"user": {"name": "Marco"}},
            "black": {"user": {"name": "Rival"}},
        },
    })
    monkeypatch.setattr(sources, "_get", lambda *a, **k: payload)

    (record,) = sources.fetch_lichess("marco", 1)
    assert record["source"] == "lichess"
    assert record["white"] == "Marco"
    assert record["result"] == "1-0"
    assert record["time_class"] == "blitz"
    assert record["url"] == "https://lichess.org/abc123"


def test_lichess_games_without_a_winner_are_draws(monkeypatch):
    monkeypatch.setattr(sources, "_get", lambda *a, **k: _ndjson({"id": "x", "pgn": "1. e4", "players": {}}))
    (record,) = sources.fetch_lichess("marco", 1)
    assert record["result"] == "1/2-1/2"


def test_lichess_anonymous_players_get_a_placeholder_name(monkeypatch):
    monkeypatch.setattr(sources, "_get", lambda *a, **k: _ndjson({"id": "x", "pgn": "1. e4", "players": {}}))
    (record,) = sources.fetch_lichess("marco", 1)
    assert record["white"] == "Anonymous"


def test_malformed_lichess_lines_are_skipped(monkeypatch):
    payload = b'{"id": "ok", "pgn": "1. e4", "players": {}}\nnot-json\n\n'
    monkeypatch.setattr(sources, "_get", lambda *a, **k: payload)
    assert len(sources.fetch_lichess("marco", 5)) == 1


# --- chess.com parsing -----------------------------------------------------

def test_chesscom_walks_archives_newest_first_and_respects_count(monkeypatch):
    archives = {"archives": ["…/2023/10", "…/2023/11"]}
    months = {
        "…/2023/11": {"games": [
            {"pgn": "1. e4", "uuid": "n1", "url": "u1", "time_class": "blitz",
             "white": {"username": "Marco", "result": "win"}, "black": {"username": "R", "result": "loss"}},
            {"pgn": "1. d4", "uuid": "n2", "url": "u2", "time_class": "rapid",
             "white": {"username": "Marco", "result": "loss"}, "black": {"username": "R", "result": "win"}},
        ]},
        "…/2023/10": {"games": [{"pgn": "1. c4", "uuid": "old", "url": "u3",
                                 "white": {"username": "Marco"}, "black": {"username": "R"}}]},
    }

    def fake_get(url, *a, **k):
        if url.endswith("/archives"):
            return json.dumps(archives).encode()
        return json.dumps(months[url]).encode()

    monkeypatch.setattr(sources, "_get", fake_get)

    records = sources.fetch_chesscom("marco", 1)
    assert len(records) == 1
    assert records[0]["external_id"] == "n2"   # newest game of the newest month
    assert records[0]["result"] == "0-1"


def test_chesscom_games_without_pgn_are_skipped(monkeypatch):
    def fake_get(url, *a, **k):
        if url.endswith("/archives"):
            return json.dumps({"archives": ["…/2023/11"]}).encode()
        return json.dumps({"games": [{"uuid": "no-pgn", "white": {}, "black": {}}]}).encode()

    monkeypatch.setattr(sources, "_get", fake_get)
    assert sources.fetch_chesscom("marco", 5) == []


def test_a_malformed_archive_list_raises_a_source_error(monkeypatch):
    monkeypatch.setattr(sources, "_get", lambda *a, **k: b"<html>nope</html>")
    with pytest.raises(sources.SourceError):
        sources.fetch_chesscom("marco", 5)
