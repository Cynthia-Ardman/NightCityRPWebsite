"""
psychosis_bridge.py — CyberPsycho Mode for VRChat

Local Flask bridge that talks to the VRChat web API to mass-block everyone
in your current instance except a hand-picked allowlist, then cleanly
restore only the blocks *it* created.

While psycho mode is active a background patrol thread re-polls the
instance at a safe interval and auto-blocks newcomers who aren't on the
allowlist.  The patrol is conservative: one instance poll per cycle, one
block call per newcomer, with jitter and backoff throughout.

Also runs an OSC listener so an avatar bool parameter like
/avatar/parameters/CyberPsychoMode can trigger isolate/restore directly
from inside VR.

Authentication
--------------
Instead of prompting for credentials, this tool reads the auth cookie
directly from VRCX's local SQLite database.  This means:
  - No separate login / 2FA prompt on every launch.
  - No extra session counting against VRChat's session limit.
  - VRChat sees one client (VRCX's session), not two.
Requires VRCX to be installed and logged in.

Usage:
    pip install flask requests python-osc
    python psychosis_bridge.py

Then open http://127.0.0.1:5005/ or hit the endpoints from Stream Deck /
AutoHotkey / TouchOSC / whatever:
    curl -X POST http://127.0.0.1:5005/isolate
    curl -X POST http://127.0.0.1:5005/restore

API-safety model
----------------
VRChat's Creator Guidelines say:
  - Use a real User-Agent in the form  applicationName/Version contactInfo
  - Do not make repeated unmetered requests
  - 429s can happen at any time; back off exponentially
  - API usage is unsupported and may change without notice

This tool's mitigations:
  1. Every API call sleeps 0.15-0.4 s of jitter BEFORE firing.
  2. 429 responses trigger exponential backoff (1.5x base) up to 60 s,
     respecting the Retry-After header when present.
  3. A sliding-window request budget caps total calls to <=60 per 60 s.
     If the budget is exhausted, calls block until a slot opens.
  4. The patrol loop runs once per PATROL_INTERVAL (default 45 s) and
     only fires when psycho mode is active.  That means the steady-state
     cost of "keeping the door locked" is ~2 API calls per cycle (one
     GET /auth/user for your location, one GET /instances for the user
     list) plus one POST per newcomer.
  5. Auth cookie is read from VRCX's database (read-only) — no
     credentials are prompted, stored, or written to disk by this tool.

None of this can *guarantee* VRChat won't change the API or decide they
don't like your usage.  This is as conservative as the documented API
surface allows.
"""

import collections
import json
import logging
import os
import platform
import random
import re as _re
import sqlite3
import sys
import threading
import time
from pathlib import Path

import requests
from flask import Flask, jsonify, request as flask_request, Response

# ---------------------------------------------------------------------------
# CONFIGURATION — edit these
# ---------------------------------------------------------------------------

APP_NAME = "PsychosisBridge"
APP_VERSION = "2.0.0"
CONTACT = "cynderardman@gmail.com"  # VRChat requires real contact info

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 5005

OSC_LISTEN_IP = "127.0.0.1"
OSC_LISTEN_PORT = 9001
OSC_PARAM_NAME = "/avatar/parameters/CyberPsychoMode"

# Rate-limit tunables
MIN_DELAY = 0.15          # seconds — minimum jitter sleep before every call
MAX_DELAY = 0.40          # seconds — maximum jitter sleep before every call
BACKOFF_BASE = 1.5        # exponential backoff multiplier on 429
BACKOFF_MAX = 60.0        # ceiling for backoff wait
MAX_RETRIES = 8           # per-request retry limit on 429

REQUEST_BUDGET = 60       # max API calls allowed per BUDGET_WINDOW
BUDGET_WINDOW = 60.0      # seconds — sliding window for budget

PATROL_INTERVAL = 45.0    # seconds between background instance polls

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("psychosis")

# ---------------------------------------------------------------------------
# VRChat API client
# ---------------------------------------------------------------------------

API_BASE = "https://api.vrchat.cloud/api/1"

_session = requests.Session()
_session.headers.update({
    "User-Agent": f"{APP_NAME}/{APP_VERSION} {CONTACT}",
    "Accept": "application/json",
})

_current_user: dict | None = None
_lock = threading.Lock()

# Sliding-window budget: deque of timestamps for recent API calls
_call_timestamps: collections.deque[float] = collections.deque()
_budget_lock = threading.Lock()


def _wait_for_budget():
    """Block until we have a slot in the request budget window."""
    while True:
        now = time.monotonic()
        with _budget_lock:
            while _call_timestamps and _call_timestamps[0] < now - BUDGET_WINDOW:
                _call_timestamps.popleft()
            if len(_call_timestamps) < REQUEST_BUDGET:
                _call_timestamps.append(now)
                return
            wait_until = _call_timestamps[0] + BUDGET_WINDOW
        sleep_for = max(wait_until - now + 0.1, 0.5)
        log.info("Budget exhausted (%d/%d in last %ds), waiting %.1fs",
                 REQUEST_BUDGET, REQUEST_BUDGET, int(BUDGET_WINDOW), sleep_for)
        time.sleep(sleep_for)


def _jitter_sleep():
    time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))


def _try_refresh_cookie() -> bool:
    """Attempt to re-read the auth cookie from VRCX (it may have auto-refreshed)."""
    db_path = _find_vrcx_database()
    if db_path is None:
        return False
    new_cookie = _extract_auth_cookie(db_path)
    if new_cookie is None:
        return False
    _session.cookies.set("auth", new_cookie, domain="api.vrchat.cloud", path="/")
    log.info("Refreshed auth cookie from VRCX.")
    return True


_last_401_refresh: float = 0.0
_401_REFRESH_COOLDOWN = 30.0


def _api_call(method: str, path: str, retries: int = MAX_RETRIES, **kwargs) -> requests.Response:
    """Fire an API request with budget gating, jitter, backoff on 429s, and auto-refresh on 401."""
    global _session_expired, _last_401_refresh
    url = f"{API_BASE}{path}"
    resp = None
    for attempt in range(retries + 1):
        _wait_for_budget()
        _jitter_sleep()
        resp = _session.request(method, url, **kwargs)

        if resp.status_code == 401:
            now = time.monotonic()
            if now - _last_401_refresh > _401_REFRESH_COOLDOWN:
                _last_401_refresh = now
                log.warning("401 Unauthorized — attempting to refresh cookie from VRCX...")
                if _try_refresh_cookie():
                    _wait_for_budget()
                    _jitter_sleep()
                    resp = _session.request(method, url, **kwargs)
                    if resp.status_code != 401:
                        _session_expired = False
                        return resp
                log.error("Session expired and could not be refreshed. Re-login in VRCX and restart.")
            _session_expired = True
            return resp

        _session_expired = False

        if resp.status_code != 429:
            return resp

        retry_after = resp.headers.get("Retry-After")
        if retry_after:
            try:
                wait = float(retry_after) + random.uniform(0.5, 2.0)
            except ValueError:
                wait = BACKOFF_BASE ** (attempt + 1) + random.uniform(0, 1)
        else:
            wait = BACKOFF_BASE ** (attempt + 1) + random.uniform(0, 1)
        wait = min(wait, BACKOFF_MAX)
        log.warning("429 rate-limited, backing off %.1fs (attempt %d/%d)", wait, attempt + 1, retries)
        time.sleep(wait)
    return resp  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Authentication — reads auth cookie from VRCX's SQLite database
# ---------------------------------------------------------------------------

_VRCX_DB_FILENAME = "VRCX.sqlite3"


def _find_vrcx_database() -> Path | None:
    """Locate VRCX's SQLite database using platform-appropriate paths.

    Search order:
      1. VRCX_DB_PATH env var (explicit override)
      2. Default OS-specific location
      3. Custom path from VRCX.json config (VRCX_DatabaseLocation key)
    """
    # 1. Explicit override
    env_path = os.environ.get("VRCX_DB_PATH")
    if env_path:
        p = Path(env_path)
        if p.is_file():
            return p
        log.warning("VRCX_DB_PATH set to %s but file not found.", env_path)

    # 2. Platform defaults
    system = platform.system()
    default_dir: Path | None = None
    if system == "Windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            default_dir = Path(appdata) / "VRCX"
    elif system == "Darwin":
        default_dir = Path.home() / "Library" / "Application Support" / "VRCX"
    else:
        default_dir = Path.home() / ".config" / "VRCX"

    if default_dir:
        candidate = default_dir / _VRCX_DB_FILENAME
        if candidate.is_file():
            return candidate

    # 3. Check VRCX.json for a custom database location
    if default_dir:
        config_file = default_dir / "VRCX.json"
        if config_file.is_file():
            try:
                with open(config_file, encoding="utf-8") as f:
                    cfg = json.load(f)
                custom = cfg.get("VRCX_DatabaseLocation")
                if custom:
                    p = Path(custom)
                    if p.is_file():
                        return p
                    alt = p / _VRCX_DB_FILENAME
                    if alt.is_file():
                        return alt
            except (json.JSONDecodeError, OSError) as exc:
                log.warning("Could not read VRCX.json: %s", exc)

    return None


def _extract_auth_cookie(db_path: Path) -> str | None:
    """Read the VRChat auth cookie value from VRCX's cookies table.

    VRCX stores cookies as:
      table cookies(key TEXT PRIMARY KEY, value TEXT)
      row key='default', value = base64(JSON array of .NET Cookie objects)

    Each cookie object has at minimum: Name, Value, Domain.
    We want the one where Name == 'auth' and Domain contains 'vrchat.cloud'.
    """
    try:
        uri = f"file:{db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        cursor = conn.execute("SELECT value FROM cookies WHERE key = 'default'")
        row = cursor.fetchone()
        conn.close()
    except sqlite3.Error as exc:
        log.error("Failed to read VRCX database: %s", exc)
        return None

    if not row or not row[0]:
        log.error("No cookie data found in VRCX database.")
        return None

    try:
        import base64 as _b64
        raw = _b64.b64decode(row[0])
        cookies = json.loads(raw)
    except Exception as exc:
        log.error("Failed to decode VRCX cookie blob: %s", exc)
        return None

    for cookie in cookies:
        name = cookie.get("Name") or cookie.get("name") or ""
        domain = cookie.get("Domain") or cookie.get("domain") or ""
        value = cookie.get("Value") or cookie.get("value") or ""
        if name == "auth" and "vrchat.cloud" in domain and value:
            return value

    log.error("Auth cookie not found in VRCX cookie jar. Are you logged in to VRCX?")
    return None


def login_from_vrcx():
    """Authenticate by reading the auth cookie from VRCX's local database."""
    global _current_user

    print("\n── VRCX Session Import ──")
    db_path = _find_vrcx_database()
    if db_path is None:
        log.error("Could not find VRCX database.")
        log.error("Make sure VRCX is installed and you've logged in at least once.")
        log.error("Searched: %%APPDATA%%/VRCX (Win), ~/Library/Application Support/VRCX (macOS), ~/.config/VRCX (Linux)")
        log.error("You can also set VRCX_DB_PATH=/path/to/VRCX.sqlite3 as an env var.")
        sys.exit(1)

    log.info("Found VRCX database: %s", db_path)

    auth_value = _extract_auth_cookie(db_path)
    if auth_value is None:
        sys.exit(1)

    _session.cookies.set("auth", auth_value, domain="api.vrchat.cloud", path="/")

    log.info("Auth cookie loaded, validating session...")
    resp = _session.get(f"{API_BASE}/auth/user")

    if resp.status_code == 401:
        log.error("Session invalid or expired. Please re-login in VRCX and try again.")
        sys.exit(1)

    if resp.status_code != 200:
        log.error("Unexpected response (%d): %s", resp.status_code, resp.text)
        sys.exit(1)

    data = resp.json()
    if "requiresTwoFactorAuth" in data:
        log.error("VRCX session requires 2FA completion. Open VRCX and finish logging in.")
        sys.exit(1)

    _current_user = data
    log.info("Authenticated as %s (%s) via VRCX session.", data.get("displayName"), data.get("id"))


# ---------------------------------------------------------------------------
# VRChat log-file parsing — location + player list (same method VRCX uses)
# ---------------------------------------------------------------------------

_CLEAN_ID = _re.compile(r"[^a-zA-Z0-9_\-~:()]")


def _find_vrchat_log_dir() -> Path | None:
    """Locate VRChat's log directory."""
    system = platform.system()
    if system == "Windows":
        local = os.environ.get("LOCALAPPDATA")  # %LOCALAPPDATA% = ...\Local
        if local:
            candidate = Path(local).parent / "LocalLow" / "VRChat" / "VRChat"
            if candidate.is_dir():
                return candidate
        home = os.environ.get("USERPROFILE") or Path.home()
        candidate = Path(home) / "AppData" / "LocalLow" / "VRChat" / "VRChat"
        if candidate.is_dir():
            return candidate
    elif system == "Darwin":
        candidate = Path.home() / "Library" / "Application Support" / "com.vrchat.VRChat"
        if candidate.is_dir():
            return candidate
    else:
        candidate = Path.home() / ".local" / "share" / "Steam" / "steamapps" / "compatdata" / "438100" / "pfx" / "drive_c" / "users" / "steamuser" / "AppData" / "LocalLow" / "VRChat" / "VRChat"
        if candidate.is_dir():
            return candidate
    return None


def _get_latest_log() -> Path | None:
    log_dir = _find_vrchat_log_dir()
    if log_dir is None:
        return None
    log_files = sorted(log_dir.glob("output_log_*.txt"), key=lambda p: p.name, reverse=True)
    return log_files[0] if log_files else None


def _parse_user_info(raw: str) -> tuple[str, str]:
    """Extract (displayName, userId) from 'DisplayName (usr_xxx)'.

    Mirrors VRCX's LogWatcher.ParseUserInfo — splits on the last ' (' to
    separate the display name from the parenthesized user ID.
    Only treats the parenthesized part as a user ID if it starts with 'usr_',
    otherwise names like 'Cool Guy (TTV)' would produce a garbage ID.
    """
    pos = raw.rfind(" (")
    if pos >= 0:
        display_name = raw[:pos]
        user_id = raw[pos + 2:]
        if user_id.endswith(")"):
            user_id = user_id[:-1]
        user_id = _CLEAN_ID.sub("", user_id)
        if user_id.startswith("usr_"):
            return display_name, user_id
    return raw.strip(), ""


def _parse_log_full() -> tuple[str | None, dict[str, str]]:
    """Parse the most recent VRChat log for location AND current player list.

    Returns:
        (location_string or None, {user_id: displayName} dict of current occupants)

    Log format reference (from VRCX LogWatcher.cs):
        [Behaviour] Joining wrld_xxx:instanceId~nonce(...)
        [Behaviour] OnPlayerJoined DisplayName (usr_xxx)
        [Behaviour] OnPlayerLeft DisplayName (usr_xxx)
        [Behaviour] OnLeftRoom
    """
    latest = _get_latest_log()
    if latest is None:
        return None, {}

    last_location: str | None = None
    left_room = False
    players: dict[str, str] = {}  # user_id -> displayName

    try:
        with open(latest, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                # Room join — resets the player list
                if "[Behaviour] Joining " in line and "] Joining or Creating Room:" not in line and "] Joining friend:" not in line:
                    idx = line.rfind("] Joining ")
                    if idx >= 0:
                        loc = line[idx + 10:].strip().replace("/", "")
                        if loc.startswith("wrld_"):
                            last_location = loc
                            left_room = False
                            players.clear()

                # Player joined
                elif "[Behaviour] OnPlayerJoined" in line and "] OnPlayerJoined:" not in line:
                    idx = line.rfind("] OnPlayerJoined")
                    if idx >= 0:
                        raw = line[idx + 17:].strip()
                        display_name, user_id = _parse_user_info(raw)
                        if user_id:
                            players[user_id] = display_name
                        elif display_name:
                            players[f"name:{display_name}"] = display_name

                # Player left
                elif "[Behaviour] OnPlayerLeft" in line and "] OnPlayerLeftRoom" not in line and "] OnPlayerLeft:" not in line:
                    idx = line.rfind("] OnPlayerLeft")
                    if idx >= 0:
                        raw = line[idx + 15:].strip()
                        display_name, user_id = _parse_user_info(raw)
                        if user_id:
                            players.pop(user_id, None)
                        elif display_name:
                            players.pop(f"name:{display_name}", None)

                # Left room entirely
                elif "[Behaviour] OnLeftRoom" in line or "[Behaviour] OnApplicationQuit" in line:
                    left_room = True
                    players.clear()

    except OSError as exc:
        log.warning("Failed to read VRChat log: %s", exc)
        return None, {}

    if left_room:
        return None, {}
    return last_location, players


def _parse_location_string(location: str) -> tuple[str, str] | None:
    """Split 'wrld_xxx:instanceId' into (worldId, instanceId)."""
    if ":" not in location:
        return None
    world_id, instance_id = location.split(":", 1)
    if not world_id.startswith("wrld_") or not instance_id:
        return None
    return world_id, instance_id


# ---------------------------------------------------------------------------
# VRChat API helpers
# ---------------------------------------------------------------------------

def _get_location_and_users_from_log() -> tuple[tuple[str, str] | None, list[dict]]:
    """Single log parse that returns both location and user list.

    Avoids re-reading the entire log file multiple times per operation.
    """
    location_str, log_players = _parse_log_full()

    parsed_loc = None
    if location_str:
        parsed_loc = _parse_location_string(location_str)

    users: list[dict] = []
    if log_players:
        for uid, name in log_players.items():
            if not uid.startswith("name:"):
                users.append({"id": uid, "displayName": name})
        nameless = [n for k, n in log_players.items() if k.startswith("name:")]
        if nameless:
            log.warning("%d player(s) in log without user IDs (older log format): %s",
                        len(nameless), ", ".join(nameless))

    return parsed_loc, users


# Cached result from latest log parse, used within a single refresh cycle
_log_cache: tuple[tuple[str, str] | None, list[dict]] | None = None


def _refresh_log_cache():
    """Parse the log once and cache the result for the current operation cycle."""
    global _log_cache
    _log_cache = _get_location_and_users_from_log()


def _clear_log_cache():
    global _log_cache
    _log_cache = None


def get_current_location() -> tuple[str, str] | None:
    """Return (worldId, instanceId) — uses cached log data, API presence as fallback."""
    loc = _log_cache[0] if _log_cache else None
    if loc:
        log.debug("Location from log: %s:%s", loc[0], loc[1])
        return loc

    log.debug("Log-file location not available, trying API presence...")
    resp = _api_call("GET", "/auth/user")
    if resp.status_code != 200:
        log.error("Failed to refresh user: %s", resp.text)
        return None
    data = resp.json()

    presence = data.get("presence") or {}
    world = presence.get("world", "") or ""
    instance = presence.get("instance", "") or ""

    log.debug("API presence — world=%r, instance=%r", world, instance)

    if not world or world == "offline" or not instance:
        log.warning("Could not determine current location from log or API.")
        return None
    return world, instance


def get_instance_users(world_id: str, instance_id: str) -> list[dict]:
    """Get users in the instance — uses cached log data, API as fallback."""
    log_users = _log_cache[1] if _log_cache else []
    if log_users:
        log.info("Player list from log: %d users with IDs.", len(log_users))
        return log_users

    resp = _api_call("GET", f"/instances/{world_id}:{instance_id}")
    if resp.status_code != 200:
        log.error("Instance fetch failed (%d): %s", resp.status_code, resp.text)
        return []
    api_users = resp.json().get("users", [])
    if api_users:
        log.info("Player list from API: %d users.", len(api_users))
    else:
        log.warning("API returned 0 users (common for group instances). "
                     "Log file also had no usable entries.")
    return api_users


def get_my_blocks() -> list[dict]:
    resp = _api_call("GET", "/auth/user/playermoderations", params={"type": "block"})
    if resp.status_code != 200:
        log.error("Failed to fetch moderations: %s", resp.text)
        return []
    data = resp.json()
    if not isinstance(data, list):
        log.error("Expected list from playermoderations, got %s", type(data).__name__)
        return []
    return data


def block_user(user_id: str) -> bool:
    resp = _api_call("POST", "/auth/user/playermoderations", json={
        "moderated": user_id, "type": "block",
    })
    if resp.status_code != 200:
        log.error("Block %s failed (%d): %s", user_id, resp.status_code, resp.text)
        return False
    try:
        data = resp.json()
    except (ValueError, requests.exceptions.JSONDecodeError):
        log.warning("Block %s got 200 but non-JSON response — treating as success.", user_id)
        return True
    returned_id = data.get("targetUserId") or data.get("moderated") or ""
    if returned_id and returned_id != user_id:
        log.warning("Block response targetUserId mismatch: sent %s, got %s", user_id, returned_id)
    mod_type = data.get("type", "")
    if mod_type and mod_type != "block":
        log.warning("Block response type mismatch: expected 'block', got %r", mod_type)
        return False
    return True


def unblock_user(user_id: str) -> bool:
    resp = _api_call("PUT", "/auth/user/unplayermoderate", json={
        "moderated": user_id, "type": "block",
    })
    if resp.status_code != 200:
        log.error("Unblock %s failed (%d): %s", user_id, resp.status_code, resp.text)
        return False
    return True


# ---------------------------------------------------------------------------
# State — persisted to disk so a crash/restart can still restore
# ---------------------------------------------------------------------------

_STATE_FILE = Path(__file__).resolve().parent / "psychosis_state.json"

_allowlist: set[str] = set()                   # user IDs to spare
_allowlist_names: dict[str, str] = {}          # id -> displayName at time of save
_blocked_by_us: dict[str, str] = {}            # id -> displayName we blocked
_instance_users: list[dict] = []               # most recent snapshot
_psycho_active = False
_patrol_event = threading.Event()              # wakes patrol loop on mode change
_last_known_location: tuple[str, str] | None = None
_operation_status: str = ""                    # live progress string for the UI
_session_expired = False


def _save_state():
    """Write blocked_by_us and allowlist to disk so Restore works after a crash."""
    try:
        data = {
            "blocked_by_us": _blocked_by_us,
            "allowlist": sorted(_allowlist),
            "allowlist_names": _allowlist_names,
            "psycho_active": _psycho_active,
        }
        tmp = _STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(_STATE_FILE)
    except OSError as exc:
        log.warning("Failed to save state: %s", exc)


def _load_state():
    """Load persisted state on startup. Blocks and allowlist are restored,
    but psycho_active is always set to False — the user must explicitly
    re-isolate or restore after a restart."""
    if not _STATE_FILE.is_file():
        return

    try:
        data = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("Failed to load state file: %s", exc)
        return

    saved_blocks = data.get("blocked_by_us", {})
    saved_allowlist = data.get("allowlist", [])
    saved_names = data.get("allowlist_names", {})

    if saved_blocks:
        _blocked_by_us.update(saved_blocks)
        log.info("Loaded %d block(s) from previous session (state file).", len(saved_blocks))
    if saved_allowlist:
        _allowlist.update(saved_allowlist)
        _allowlist_names.update(saved_names)
        log.info("Loaded allowlist of %d user(s) from previous session.", len(saved_allowlist))


def _clear_state_file():
    """Remove the state file after a clean restore."""
    try:
        _STATE_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def refresh_instance() -> list[dict]:
    global _instance_users, _last_known_location
    _refresh_log_cache()
    loc = get_current_location()
    if loc is None:
        log.warning("Not in any instance right now.")
        _instance_users = []
        _last_known_location = None
        _clear_log_cache()
        return []
    _last_known_location = loc
    world_id, instance_id = loc
    users = get_instance_users(world_id, instance_id)
    _instance_users = users
    log.info("Instance has %d users.", len(users))
    _clear_log_cache()
    return users


def _build_targets(users: list[dict], existing_block_ids: set[str]) -> list[dict]:
    """Filter the user list down to people who need to be blocked."""
    my_id = (_current_user or {}).get("id", "")
    return [
        u for u in users
        if u["id"] != my_id
        and u["id"] not in _allowlist
        and u["id"] not in existing_block_ids
        and u["id"] not in _blocked_by_us
    ]


def do_isolate() -> dict:
    """Block everyone in the instance who is NOT on the allowlist."""
    global _psycho_active, _operation_status
    my_id = (_current_user or {}).get("id", "")
    non_self_allowlist = {uid for uid in _allowlist if uid != my_id}
    if not non_self_allowlist:
        msg = "No friends on the allowlist. Check the people you want to keep, then click Isolate again."
        log.warning(msg)
        return {"status": "error", "message": msg}

    try:
        _operation_status = "Refreshing instance..."
        users = refresh_instance()
        if not users:
            return {"status": "error", "message": "No instance / no users found."}

        log.info("Isolate: %d users in instance, %d in allowlist, %d already blocked by us.",
                 len(users), len(_allowlist), len(_blocked_by_us))

        _operation_status = "Fetching existing blocks..."
        existing_block_ids = {m["targetUserId"] for m in get_my_blocks()}
        log.info("Isolate: %d pre-existing blocks on your account.", len(existing_block_ids))

        targets = _build_targets(users, existing_block_ids)
        log.info("Isolate: %d target(s) to block.", len(targets))

        blocked, failed = 0, 0
        total = len(targets)
        for i, u in enumerate(targets, 1):
            name = u.get("displayName", u["id"])
            _operation_status = f"Blocking {i}/{total}: {name}"
            log.info("[%d/%d] Blocking %s (%s)...", i, total, name, u["id"])
            if block_user(u["id"]):
                _blocked_by_us[u["id"]] = name
                blocked += 1
                _save_state()
            else:
                failed += 1

        verified = 0
        if _blocked_by_us:
            _operation_status = "Verifying blocks on server..."
            server_blocks = {m["targetUserId"] for m in get_my_blocks()}
            verified = sum(1 for uid in _blocked_by_us if uid in server_blocks)
            missing = [f"{_blocked_by_us[uid]} ({uid})" for uid in _blocked_by_us if uid not in server_blocks]
            log.info("Verification: %d/%d of our blocks confirmed on server.", verified, len(_blocked_by_us))
            if missing:
                log.warning("NOT confirmed on server: %s", ", ".join(missing[:10]))

        _psycho_active = True
        _patrol_event.set()
        _save_state()

        if not targets:
            msg = f"Isolate active. Everyone is either allowlisted or already blocked. 0 new blocks needed."
        else:
            msg = f"Isolated. Blocked {blocked}/{total}. Verified {verified}/{len(_blocked_by_us)} on server."
            if failed:
                msg += f" {failed} failed."
        msg += f" Patrol active (~{int(PATROL_INTERVAL)}s)."
        msg += " REJOIN the world for blocks to take visual effect."
        log.info(msg)
        return {"status": "ok", "blocked": blocked, "failed": failed, "verified": verified, "message": msg}
    finally:
        _operation_status = ""


def do_restore() -> dict:
    """Unblock only the users that *this tool* blocked."""
    global _psycho_active, _operation_status
    _psycho_active = False
    _patrol_event.set()
    _save_state()

    if not _blocked_by_us:
        _clear_state_file()
        return {"status": "ok", "unblocked": 0, "message": "Nothing to restore. Patrol stopped."}

    try:
        total = len(_blocked_by_us)
        unblocked, failed = 0, 0
        for i, uid in enumerate(list(_blocked_by_us), 1):
            name = _blocked_by_us.get(uid, uid)
            _operation_status = f"Unblocking {i}/{total}: {name}"
            log.info("[%d/%d] Unblocking %s (%s)...", i, total, name, uid)
            if unblock_user(uid):
                _blocked_by_us.pop(uid, None)
                unblocked += 1
                _save_state()
            else:
                failed += 1

        if not _blocked_by_us:
            _clear_state_file()

        msg = f"Restored. Unblocked {unblocked}/{total} user(s). Patrol stopped."
        if failed:
            msg += f" {failed} failed — still tracked, run Restore again to retry."
        log.info(msg)
        return {"status": "ok", "unblocked": unblocked, "failed": failed, "message": msg}
    finally:
        _operation_status = ""


# ---------------------------------------------------------------------------
# Patrol thread — auto-blocks newcomers while psycho mode is active
# ---------------------------------------------------------------------------

def _patrol_loop():
    """Background thread that re-polls the instance and blocks newcomers."""
    global _psycho_active
    while True:
        _patrol_event.wait()
        _patrol_event.clear()

        while _psycho_active:
            time.sleep(PATROL_INTERVAL + random.uniform(0, 5))
            if not _psycho_active:
                break

            with _lock:
                saved_loc = _last_known_location
                if saved_loc is None:
                    log.info("[patrol] No known location, skipping cycle.")
                    continue

                _refresh_log_cache()

                current_parsed = _log_cache[0] if _log_cache else None
                if current_parsed and current_parsed != saved_loc:
                    log.warning("[patrol] World changed (%s:%s -> %s:%s). Pausing patrol — re-isolate in the new world.",
                                saved_loc[0], saved_loc[1], current_parsed[0], current_parsed[1])
                    _clear_log_cache()
                    _psycho_active = False
                    _save_state()
                    break
                elif current_parsed is None:
                    _clear_log_cache()
                    log.info("[patrol] No longer in any instance. Pausing patrol.")
                    _psycho_active = False
                    _save_state()
                    break

                world_id, instance_id = saved_loc
                users = get_instance_users(world_id, instance_id)
                _clear_log_cache()
                if not users:
                    continue

                existing_block_ids = {m["targetUserId"] for m in get_my_blocks()}
                targets = _build_targets(users, existing_block_ids)

                if not targets:
                    log.info("[patrol] Instance clean — %d users, no new targets.", len(users))
                    continue

                log.info("[patrol] %d newcomer(s) detected, blocking...", len(targets))
                for u in targets:
                    name = u.get("displayName", u["id"])
                    log.info("[patrol] Blocking %s (%s)", name, u["id"])
                    if block_user(u["id"]):
                        _blocked_by_us[u["id"]] = name
                        _save_state()


# ---------------------------------------------------------------------------
# Flask web UI
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["JSONIFY_PRETTYPRINT_REGULAR"] = True

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Psychosis Bridge</title>
<style>
  :root {
    --bg: #0d0d0d; --surface: #1a1a2e; --accent: #e94560;
    --accent2: #0f3460; --text: #eaeaea; --dim: #888;
    --green: #16c784; --red: #ea3943; --yellow: #f5a623;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: var(--bg); color: var(--text);
    min-height: 100vh; padding: 1.5rem;
  }
  h1 { color: var(--accent); margin-bottom: .3rem; font-size: 1.6rem; }
  .subtitle { color: var(--dim); margin-bottom: 1.5rem; font-size: .85rem; }
  .status-bar {
    display: flex; gap: .6rem; align-items: center;
    margin-bottom: 1.2rem; flex-wrap: wrap;
  }
  .badge {
    padding: .25rem .7rem; border-radius: 4px;
    font-size: .8rem; font-weight: 600;
  }
  .badge-active { background: var(--red); color: #fff; animation: pulse 2s infinite; }
  .badge-off { background: var(--accent2); color: var(--dim); }
  .badge-ok { background: var(--green); color: #000; }
  .badge-warn { background: var(--yellow); color: #000; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.6} }
  .card {
    background: var(--surface); border-radius: 8px;
    padding: 1.2rem; margin-bottom: 1rem;
  }
  .card h2 { font-size: 1rem; margin-bottom: .8rem; color: var(--accent); }
  .user-list { list-style: none; max-height: 45vh; overflow-y: auto; }
  .user-list li {
    display: flex; align-items: center; gap: .6rem;
    padding: .4rem 0; border-bottom: 1px solid #ffffff0d;
  }
  .user-list li:last-child { border-bottom: none; }
  .user-list input[type=checkbox] { accent-color: var(--accent); width: 1.1rem; height: 1.1rem; }
  .user-name { flex: 1; }
  .user-id { color: var(--dim); font-size: .7rem; font-family: monospace; }
  .user-tag {
    font-size: .65rem; padding: .1rem .4rem; border-radius: 3px;
    font-weight: 600;
  }
  .tag-allowed { background: var(--green); color: #000; }
  .tag-blocked { background: var(--red); color: #fff; }
  .btn-row { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: .4rem; }
  button {
    padding: .55rem 1.2rem; border: none; border-radius: 6px;
    font-weight: 600; cursor: pointer; font-size: .85rem;
    transition: opacity .15s;
  }
  button:hover { opacity: .85; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-green { background: var(--green); color: #000; }
  .btn-secondary { background: var(--accent2); color: var(--text); }
  .blocked-list {
    list-style: none; max-height: 20vh; overflow-y: auto;
    margin-top: .5rem;
  }
  .blocked-list li {
    padding: .25rem 0; font-size: .82rem;
    border-bottom: 1px solid #ffffff0d;
    display: flex; justify-content: space-between;
  }
  .log-area {
    background: #111; border-radius: 6px; padding: .8rem;
    font-family: monospace; font-size: .78rem; color: var(--dim);
    max-height: 14rem; overflow-y: auto; margin-top: .8rem;
    white-space: pre-wrap; word-break: break-all;
  }
  .help-box {
    background: #111; border-left: 3px solid var(--accent2);
    padding: .8rem 1rem; font-size: .8rem; color: var(--dim);
    line-height: 1.5; margin-top: .6rem; border-radius: 4px;
  }
  .help-box strong { color: var(--text); }
</style>
</head>
<body>

<h1>&#x1F9E0; Psychosis Bridge</h1>
<p class="subtitle">CyberPsycho Mode — VRChat instance isolation tool</p>

<div class="status-bar">
  <span id="badge-status" class="badge badge-off">STANDBY</span>
  <span id="badge-patrol" class="badge badge-off">PATROL OFF</span>
  <span id="badge-user" class="badge badge-ok">{{USER_NAME}}</span>
  <span id="badge-blocked" class="badge badge-off">0 blocked</span>
  <span id="badge-allowlist" class="badge badge-off">0 allowlisted</span>
  <span id="badge-operation" class="badge badge-warn" style="display:none"></span>
</div>

<div id="session-expired-banner" style="display:none;background:#ea3943;color:#fff;padding:.8rem 1.2rem;border-radius:8px;margin-bottom:1rem;font-weight:600">
  SESSION EXPIRED &mdash; VRChat auth cookie is no longer valid. Re-login in VRCX and restart this tool.
</div>

<div class="card">
  <h2>Step 1 &mdash; Build Your Allowlist</h2>
  <div class="help-box">
    <strong>How it works:</strong> Refresh the instance to see everyone here right now.
    Check the people you want to <strong>keep</strong>, then hit Isolate.
    Everyone else gets blocked. The patrol auto-blocks newcomers every ~{{PATROL_INTERVAL}}s.
    <br><br>
    <strong>Important:</strong> API blocks are server-side — people already loaded in your
    instance won't visually disappear until you <strong>rejoin the world</strong>.
    After isolate finishes, leave and rejoin to see the effect.
  </div>
  <div class="btn-row" style="margin-top:.8rem">
    <button class="btn-secondary" onclick="doRefresh()">Refresh Instance</button>
    <button class="btn-secondary" onclick="selectAll(true)">Check All</button>
    <button class="btn-secondary" onclick="selectAll(false)">Uncheck All</button>
    <button class="btn-primary" onclick="doSave()">Save Allowlist</button>
    <button class="btn-green" onclick="doSnapshotAll()">Snapshot All (allowlist everyone here)</button>
  </div>
  <ul class="user-list" id="user-list">
    <li style="color:var(--dim)">Click Refresh to load instance occupants.</li>
  </ul>
</div>

<div class="card">
  <h2>Step 2 &mdash; Activate / Deactivate</h2>
  <div class="btn-row">
    <button class="btn-primary" id="btn-isolate" onclick="doAction('/isolate')">
      Isolate &mdash; block everyone else + start patrol
    </button>
    <button class="btn-green" id="btn-restore" onclick="doAction('/restore')">
      Restore &mdash; unblock our blocks + stop patrol
    </button>
  </div>
</div>

<div class="card">
  <h2>Blocked By Us (will be unblocked on Restore)</h2>
  <ul class="blocked-list" id="blocked-list">
    <li style="color:var(--dim)">None yet.</li>
  </ul>
</div>

<div class="card">
  <h2>Activity Log</h2>
  <div class="log-area" id="log">Ready.</div>
</div>

<script>
const $log = document.getElementById('log');
const $list = document.getElementById('user-list');
const $blist = document.getElementById('blocked-list');
const $badge = document.getElementById('badge-status');
const $badgePatrol = document.getElementById('badge-patrol');
const $badgeBlocked = document.getElementById('badge-blocked');
const $badgeAllowlist = document.getElementById('badge-allowlist');

function appendLog(msg) {
  const ts = new Date().toLocaleTimeString();
  $log.textContent += '\n[' + ts + '] ' + msg;
  $log.scrollTop = $log.scrollHeight;
}

let _myId = '';

async function doRefresh() {
  appendLog('Refreshing instance...');
  const r = await fetch('/api/refresh', {method:'POST'});
  const d = await r.json();
  _myId = d.my_id || '';
  renderUsers(d.users || [], d.allowlist || [], d.blocked_ids || []);
  appendLog('Found ' + (d.users||[]).length + ' users.');
  pollStatus();
}

function renderUsers(users, allowlist, blockedIds) {
  if (!users.length) {
    $list.innerHTML = '<li style="color:var(--dim)">No users / not in an instance.</li>';
    return;
  }
  $list.innerHTML = '';
  for (const u of users) {
    const isMe = u.id === _myId;
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = u.id;
    cb.checked = isMe || allowlist.includes(u.id);
    if (isMe) { cb.disabled = true; cb.title = 'You are always on the allowlist'; }
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = (u.displayName || u.id) + (isMe ? ' (you)' : '');
    const id = document.createElement('span');
    id.className = 'user-id'; id.textContent = u.id;
    li.append(cb, name);
    if (isMe || allowlist.includes(u.id)) {
      const tag = document.createElement('span');
      tag.className = 'user-tag tag-allowed'; tag.textContent = isMe ? 'YOU' : 'ALLOWED';
      li.append(tag);
    }
    if (blockedIds.includes(u.id)) {
      const tag = document.createElement('span');
      tag.className = 'user-tag tag-blocked'; tag.textContent = 'BLOCKED';
      li.append(tag);
    }
    li.append(id);
    $list.appendChild(li);
  }
}

function selectAll(state) {
  $list.querySelectorAll('input[type=checkbox]').forEach(cb => {
    if (!cb.disabled) cb.checked = state;
  });
}

async function doSave(silent) {
  const ids = [...$list.querySelectorAll('input:checked')].map(cb => cb.value);
  if (!ids.length && !silent) {
    if (!confirm('Allowlist is empty — that means EVERYONE gets blocked on Isolate. Continue?')) return;
  }
  const r = await fetch('/api/save_allowlist', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ids})
  });
  const d = await r.json();
  if (!silent) appendLog(d.message || 'Saved.');
  pollStatus();
}

async function doSnapshotAll() {
  appendLog('Snapshotting all current occupants as allowlist...');
  const r = await fetch('/api/snapshot_allowlist', {method:'POST'});
  const d = await r.json();
  appendLog(d.message || 'Done.');
  doRefresh();
}

function setActionButtons(enabled) {
  document.getElementById('btn-isolate').disabled = !enabled;
  document.getElementById('btn-restore').disabled = !enabled;
}

async function doAction(path) {
  setActionButtons(false);
  if (path === '/isolate') {
    appendLog('Auto-saving allowlist from current checkboxes...');
    await doSave(true);
  }
  appendLog('Calling ' + path + '...');
  try {
    const r = await fetch('/api' + path, {method:'POST'});
    const d = await r.json();
    appendLog(d.message || JSON.stringify(d));
  } catch(e) { appendLog('Error: ' + e); }
  setActionButtons(true);
  pollStatus();
}

async function pollStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    $badge.textContent = s.psycho_active ? 'PSYCHO ACTIVE' : 'STANDBY';
    $badge.className = 'badge ' + (s.psycho_active ? 'badge-active' : 'badge-off');
    $badgePatrol.textContent = s.psycho_active ? 'PATROL ON' : 'PATROL OFF';
    $badgePatrol.className = 'badge ' + (s.psycho_active ? 'badge-warn' : 'badge-off');
    $badgeBlocked.textContent = s.blocked_count + ' blocked by us';
    $badgeBlocked.className = 'badge ' + (s.blocked_count ? 'badge-active' : 'badge-off');
    $badgeAllowlist.textContent = s.allowlist_count + ' allowlisted';
    $badgeAllowlist.className = 'badge ' + (s.allowlist_count ? 'badge-ok' : 'badge-off');

    const $op = document.getElementById('badge-operation');
    if (s.operation) {
      $op.textContent = s.operation;
      $op.style.display = '';
      setActionButtons(false);
    } else {
      $op.style.display = 'none';
      setActionButtons(true);
    }

    const $exp = document.getElementById('session-expired-banner');
    if (s.session_expired) {
      $exp.style.display = '';
    } else {
      $exp.style.display = 'none';
    }

    if (s.blocked_names && s.blocked_names.length) {
      $blist.innerHTML = '';
      for (const b of s.blocked_names) {
        const li = document.createElement('li');
        const nameSpan = document.createElement('span');
        nameSpan.textContent = b.name;
        const idSpan = document.createElement('span');
        idSpan.style.cssText = 'color:var(--dim);font-size:.7rem;font-family:monospace';
        idSpan.textContent = b.id;
        li.append(nameSpan, idSpan);
        $blist.appendChild(li);
      }
    } else {
      $blist.innerHTML = '<li style="color:var(--dim)">None yet.</li>';
    }
  } catch(e) {}
}

pollStatus();
setInterval(pollStatus, 3000);
</script>
</body>
</html>"""


@app.route("/")
def index():
    name = (_current_user or {}).get("displayName", "not logged in")
    html = HTML_TEMPLATE.replace("{{USER_NAME}}", name)
    html = html.replace("{{PATROL_INTERVAL}}", str(int(PATROL_INTERVAL)))
    return Response(html, content_type="text/html")


@app.route("/api/status")
def api_status():
    return jsonify({
        "psycho_active": _psycho_active,
        "blocked_count": len(_blocked_by_us),
        "blocked_ids": sorted(_blocked_by_us.keys()),
        "blocked_names": [
            {"id": uid, "name": name} for uid, name in sorted(_blocked_by_us.items(), key=lambda x: x[1])
        ],
        "allowlist": sorted(_allowlist),
        "allowlist_count": len(_allowlist),
        "allowlist_names": [
            {"id": uid, "name": _allowlist_names.get(uid, uid)} for uid in sorted(_allowlist)
        ],
        "patrol_interval": PATROL_INTERVAL,
        "operation": _operation_status,
        "session_expired": _session_expired,
    })


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    users = refresh_instance()
    return jsonify({
        "users": [{"id": u["id"], "displayName": u.get("displayName", u["id"])} for u in users],
        "allowlist": sorted(_allowlist),
        "blocked_ids": sorted(_blocked_by_us.keys()),
        "my_id": (_current_user or {}).get("id", ""),
    })


@app.route("/api/save_allowlist", methods=["POST"])
def api_save_allowlist():
    data = flask_request.get_json(silent=True) or {}
    ids = data.get("ids", [])
    my_id = (_current_user or {}).get("id", "")
    if my_id and my_id not in ids:
        ids.append(my_id)
    _allowlist.clear()
    _allowlist_names.clear()
    _allowlist.update(ids)
    name_map = {u["id"]: u.get("displayName", u["id"]) for u in _instance_users}
    my_name = (_current_user or {}).get("displayName", my_id)
    for uid in ids:
        _allowlist_names[uid] = name_map.get(uid, my_name if uid == my_id else uid)
    log.info("Allowlist saved: %d users — %s",
             len(_allowlist),
             ", ".join(_allowlist_names.get(uid, uid) for uid in ids))
    _save_state()
    return jsonify({
        "status": "ok", "count": len(_allowlist),
        "message": f"Allowlist saved: {len(_allowlist)} user(s) (you are always included).",
    })


@app.route("/api/snapshot_allowlist", methods=["POST"])
def api_snapshot_allowlist():
    """One-click: set the allowlist to everyone currently in the instance."""
    users = refresh_instance()
    my_id = (_current_user or {}).get("id", "")
    my_name = (_current_user or {}).get("displayName", my_id)
    _allowlist.clear()
    _allowlist_names.clear()
    if my_id:
        _allowlist.add(my_id)
        _allowlist_names[my_id] = my_name
    for u in users:
        _allowlist.add(u["id"])
        _allowlist_names[u["id"]] = u.get("displayName", u["id"])
    _save_state()
    log.info("Snapshot allowlist: %d users.", len(_allowlist))
    return jsonify({
        "status": "ok", "count": len(_allowlist),
        "message": f"Allowlisted all {len(_allowlist)} current occupant(s) (including you).",
    })


@app.route("/api/isolate", methods=["POST"])
@app.route("/isolate", methods=["POST"])
def api_isolate():
    with _lock:
        return jsonify(do_isolate())


@app.route("/api/restore", methods=["POST"])
@app.route("/restore", methods=["POST"])
def api_restore():
    with _lock:
        return jsonify(do_restore())


# ---------------------------------------------------------------------------
# OSC listener — maps avatar parameter to isolate / restore
# ---------------------------------------------------------------------------

def start_osc_listener():
    try:
        from pythonosc.dispatcher import Dispatcher
        from pythonosc.osc_server import ThreadingOSCUDPServer
    except ImportError:
        log.warning("python-osc not installed — OSC listener disabled. pip install python-osc")
        return

    def on_psycho_mode(_addr, value):
        log.info("OSC %s = %s", _addr, value)
        with _lock:
            if value:
                do_isolate()
            else:
                do_restore()

    dispatcher = Dispatcher()
    dispatcher.map(OSC_PARAM_NAME, on_psycho_mode)

    server = ThreadingOSCUDPServer((OSC_LISTEN_IP, OSC_LISTEN_PORT), dispatcher)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log.info("OSC listener on %s:%d for %s", OSC_LISTEN_IP, OSC_LISTEN_PORT, OSC_PARAM_NAME)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if CONTACT == "YOUR_EMAIL_OR_URL_HERE":
        print("ERROR: Edit the CONTACT string near the top of the file first.")
        print("VRChat requires a real email or support URL in User-Agent.")
        sys.exit(1)

    login_from_vrcx()
    _load_state()

    if _blocked_by_us:
        log.info("=== %d block(s) from previous session still active. ===", len(_blocked_by_us))
        log.info("=== Hit Restore in the web UI to unblock them, or Isolate to continue. ===")

    patrol = threading.Thread(target=_patrol_loop, daemon=True)
    patrol.start()
    log.info("Patrol thread started (interval: %ds, idle until psycho mode activates).", int(PATROL_INTERVAL))

    start_osc_listener()

    log.info("Starting web UI on http://%s:%d/", LISTEN_HOST, LISTEN_PORT)
    app.run(host=LISTEN_HOST, port=LISTEN_PORT, debug=False)


if __name__ == "__main__":
    main()
