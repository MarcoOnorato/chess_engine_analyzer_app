import threading

import pytest

from player_db import db


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    """A fresh, isolated SQLite file with the schema applied.

    `db` keeps one connection per thread in a module-level `threading.local`,
    so the fixture swaps in a clean one and restores it afterwards — otherwise
    tests would leak the previous test's connection (and its file).
    """
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "test.sqlite"))
    monkeypatch.setattr(db, "_local", threading.local())
    db.init_db()
    yield db
    conn = getattr(db._local, "conn", None)
    if conn is not None:
        conn.close()
