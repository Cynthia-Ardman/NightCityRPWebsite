// Static text assets handed to staffers as the local VRChat agent download.
//
// IMPORTANT: build.mjs bundles ONLY .ts source — non-TS files are not copied to
// dist. So the Python agent lives here as a string constant (String.raw keeps
// every backslash in the Python source intact; the Python contains no backticks
// and no ${ sequences, so a raw template is safe). buildAgentScript() bakes the
// per-staffer base URL + token into the placeholders at download time.

const TOKEN_PLACEHOLDER = "__AGENT_TOKEN__";
const BASE_URL_PLACEHOLDER = "__AGENT_BASE_URL__";

export const AGENT_PY: string = String.raw`"""
psychosis_agent.py — CyberPsycho Mode for VRChat (portal-controlled agent)

This is a small local agent that runs on YOUR PC and acts on YOUR VRChat
account. It is driven remotely by the Night City RP portal: the portal is the
control panel, this agent does the actual work (reading your VRCX auth cookie,
parsing your VRChat log, mass-blocking / unblocking via the playermoderations
API). Nothing about your VRChat account ever touches the portal server — the
portal only sends commands (isolate / restore / refresh / snapshot) and receives
status, all scoped to a private token baked into this file.

Just run it: it auto-installs its two dependencies (requests, python-osc) on
first launch, reads your VRChat session from VRCX, then connects to the portal
and waits for commands. Leave it running in the background while you play.

Requires VRCX to be installed and logged in (so VRChat sees one session, not
two, and you never get an extra 2FA prompt).
"""

import importlib
import subprocess
import sys


def _ensure(pip_name, import_name=None):
    """Install a dependency on first run so non-technical staff can just run the file."""
    try:
        importlib.import_module(import_name or pip_name)
    except ImportError:
        print("Installing dependency: " + pip_name + " ...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", pip_name])


_ensure("requests")
_ensure("python-osc", "pythonosc")

import collections
import json
import logging
import os
import platform
import random
import re as _re
import sqlite3
import threading
import time
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Portal connection — baked in at download time, do not edit
# ---------------------------------------------------------------------------

PORTAL_BASE_URL = "${BASE_URL_PLACEHOLDER}"
AGENT_TOKEN = "${TOKEN_PLACEHOLDER}"
POLL_INTERVAL = 4.0  # seconds between control-panel polls

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

APP_NAME = "PsychosisBridge"
APP_VERSION = "3.0.0"
CONTACT = "cynderardman@gmail.com"  # VRChat requires real contact info

OSC_LISTEN_IP = "127.0.0.1"
OSC_LISTEN_PORT = 9001
OSC_PARAM_NAME = "/avatar/parameters/CyberPsychoMode"

# Rate-limit tunables
MIN_DELAY = 0.15
MAX_DELAY = 0.40
BACKOFF_BASE = 1.5
BACKOFF_MAX = 60.0
MAX_RETRIES = 8

REQUEST_BUDGET = 60
BUDGET_WINDOW = 60.0

PATROL_INTERVAL = 45.0

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

_current_user = None
_lock = threading.Lock()

_call_timestamps = collections.deque()
_budget_lock = threading.Lock()


def _wait_for_budget():
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
        log.info("Budget exhausted, waiting %.1fs", sleep_for)
        time.sleep(sleep_for)


def _jitter_sleep():
    time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))


def _try_refresh_cookie():
    db_path = _find_vrcx_database()
    if db_path is None:
        return False
    new_cookie = _extract_auth_cookie(db_path)
    if new_cookie is None:
        return False
    _session.cookies.set("auth", new_cookie, domain="api.vrchat.cloud", path="/")
    log.info("Refreshed auth cookie from VRCX.")
    return True


_last_401_refresh = 0.0
_401_REFRESH_COOLDOWN = 30.0
_session_expired = False


def _api_call(method, path, retries=MAX_RETRIES, **kwargs):
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
                log.error("Session expired and could not be refreshed. Re-login in VRCX.")
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
    return resp


# ---------------------------------------------------------------------------
# Authentication — reads auth cookie from VRCX's SQLite database
# ---------------------------------------------------------------------------

_VRCX_DB_FILENAME = "VRCX.sqlite3"


def _find_vrcx_database():
    env_path = os.environ.get("VRCX_DB_PATH")
    if env_path:
        p = Path(env_path)
        if p.is_file():
            return p
        log.warning("VRCX_DB_PATH set to %s but file not found.", env_path)

    system = platform.system()
    default_dir = None
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


def _extract_auth_cookie(db_path):
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
    global _current_user

    print("\n-- VRCX Session Import --")
    db_path = _find_vrcx_database()
    if db_path is None:
        log.error("Could not find VRCX database.")
        log.error("Make sure VRCX is installed and you've logged in at least once.")
        log.error("You can also set VRCX_DB_PATH=/path/to/VRCX.sqlite3 as an env var.")
        return False

    log.info("Found VRCX database: %s", db_path)

    auth_value = _extract_auth_cookie(db_path)
    if auth_value is None:
        return False

    _session.cookies.set("auth", auth_value, domain="api.vrchat.cloud", path="/")

    log.info("Auth cookie loaded, validating session...")
    resp = _session.get(f"{API_BASE}/auth/user")

    if resp.status_code == 401:
        log.error("Session invalid or expired. Please re-login in VRCX and try again.")
        return False

    if resp.status_code != 200:
        log.error("Unexpected response (%d): %s", resp.status_code, resp.text)
        return False

    data = resp.json()
    if "requiresTwoFactorAuth" in data:
        log.error("VRCX session requires 2FA completion. Open VRCX and finish logging in.")
        return False

    _current_user = data
    log.info("Authenticated as %s (%s) via VRCX session.", data.get("displayName"), data.get("id"))
    return True


# ---------------------------------------------------------------------------
# VRChat log-file parsing — location + player list (same method VRCX uses)
# ---------------------------------------------------------------------------

_CLEAN_ID = _re.compile(r"[^a-zA-Z0-9_\-~:()]")


def _find_vrchat_log_dir():
    system = platform.system()
    if system == "Windows":
        local = os.environ.get("LOCALAPPDATA")
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


def _get_latest_log():
    log_dir = _find_vrchat_log_dir()
    if log_dir is None:
        return None
    log_files = sorted(log_dir.glob("output_log_*.txt"), key=lambda p: p.name, reverse=True)
    return log_files[0] if log_files else None


def _parse_user_info(raw):
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


def _parse_log_full():
    latest = _get_latest_log()
    if latest is None:
        return None, {}

    last_location = None
    left_room = False
    players = {}

    try:
        with open(latest, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if "[Behaviour] Joining " in line and "] Joining or Creating Room:" not in line and "] Joining friend:" not in line:
                    idx = line.rfind("] Joining ")
                    if idx >= 0:
                        loc = line[idx + 10:].strip().replace("/", "")
                        if loc.startswith("wrld_"):
                            last_location = loc
                            left_room = False
                            players.clear()

                elif "[Behaviour] OnPlayerJoined" in line and "] OnPlayerJoined:" not in line:
                    idx = line.rfind("] OnPlayerJoined")
                    if idx >= 0:
                        raw = line[idx + 17:].strip()
                        display_name, user_id = _parse_user_info(raw)
                        if user_id:
                            players[user_id] = display_name
                        elif display_name:
                            players[f"name:{display_name}"] = display_name

                elif "[Behaviour] OnPlayerLeft" in line and "] OnPlayerLeftRoom" not in line and "] OnPlayerLeft:" not in line:
                    idx = line.rfind("] OnPlayerLeft")
                    if idx >= 0:
                        raw = line[idx + 15:].strip()
                        display_name, user_id = _parse_user_info(raw)
                        if user_id:
                            players.pop(user_id, None)
                        elif display_name:
                            players.pop(f"name:{display_name}", None)

                elif "[Behaviour] OnLeftRoom" in line or "[Behaviour] OnApplicationQuit" in line:
                    left_room = True
                    players.clear()

    except OSError as exc:
        log.warning("Failed to read VRChat log: %s", exc)
        return None, {}

    if left_room:
        return None, {}
    return last_location, players


def _parse_location_string(location):
    if ":" not in location:
        return None
    world_id, instance_id = location.split(":", 1)
    if not world_id.startswith("wrld_") or not instance_id:
        return None
    return world_id, instance_id


def _get_location_and_users_from_log():
    location_str, log_players = _parse_log_full()

    parsed_loc = None
    if location_str:
        parsed_loc = _parse_location_string(location_str)

    users = []
    if log_players:
        for uid, name in log_players.items():
            if not uid.startswith("name:"):
                users.append({"id": uid, "displayName": name})

    return parsed_loc, users


_log_cache = None


def _refresh_log_cache():
    global _log_cache
    _log_cache = _get_location_and_users_from_log()


def _clear_log_cache():
    global _log_cache
    _log_cache = None


def get_current_location():
    loc = _log_cache[0] if _log_cache else None
    if loc:
        return loc

    resp = _api_call("GET", "/auth/user")
    if resp.status_code != 200:
        log.error("Failed to refresh user: %s", resp.text)
        return None
    data = resp.json()

    presence = data.get("presence") or {}
    world = presence.get("world", "") or ""
    instance = presence.get("instance", "") or ""

    if not world or world == "offline" or not instance:
        log.warning("Could not determine current location from log or API.")
        return None
    return world, instance


def get_instance_users(world_id, instance_id):
    log_users = _log_cache[1] if _log_cache else []
    if log_users:
        log.info("Player list from log: %d users with IDs.", len(log_users))
        return log_users

    resp = _api_call("GET", f"/instances/{world_id}:{instance_id}")
    if resp.status_code != 200:
        log.error("Instance fetch failed (%d): %s", resp.status_code, resp.text)
        return []
    api_users = resp.json().get("users", [])
    return api_users


def get_my_blocks():
    resp = _api_call("GET", "/auth/user/playermoderations", params={"type": "block"})
    if resp.status_code != 200:
        log.error("Failed to fetch moderations: %s", resp.text)
        return []
    data = resp.json()
    if not isinstance(data, list):
        return []
    return data


def block_user(user_id):
    resp = _api_call("POST", "/auth/user/playermoderations", json={
        "moderated": user_id, "type": "block",
    })
    if resp.status_code != 200:
        log.error("Block %s failed (%d): %s", user_id, resp.status_code, resp.text)
        return False
    try:
        data = resp.json()
    except (ValueError, requests.exceptions.JSONDecodeError):
        return True
    mod_type = data.get("type", "")
    if mod_type and mod_type != "block":
        return False
    return True


def unblock_user(user_id):
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

_allowlist = set()
_allowlist_names = {}
_blocked_by_us = {}
_instance_users = []
_psycho_active = False
_patrol_event = threading.Event()
_last_known_location = None
_operation_status = ""


def _save_state():
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
        log.info("Loaded %d block(s) from previous session.", len(saved_blocks))
    if saved_allowlist:
        _allowlist.update(saved_allowlist)
        _allowlist_names.update(saved_names)
        log.info("Loaded allowlist of %d user(s) from previous session.", len(saved_allowlist))


def _clear_state_file():
    try:
        _STATE_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def refresh_instance():
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


def _build_targets(users, existing_block_ids):
    my_id = (_current_user or {}).get("id", "")
    return [
        u for u in users
        if u["id"] != my_id
        and u["id"] not in _allowlist
        and u["id"] not in existing_block_ids
        and u["id"] not in _blocked_by_us
    ]


def do_isolate():
    global _psycho_active, _operation_status
    my_id = (_current_user or {}).get("id", "")
    non_self_allowlist = {uid for uid in _allowlist if uid != my_id}
    if not non_self_allowlist:
        msg = "No one on the allowlist. Refresh, check the people to keep, save, then Isolate again."
        log.warning(msg)
        return {"status": "error", "message": msg}

    try:
        _operation_status = "Refreshing instance..."
        users = refresh_instance()
        if not users:
            return {"status": "error", "message": "No instance / no users found."}

        _operation_status = "Fetching existing blocks..."
        existing_block_ids = {m["targetUserId"] for m in get_my_blocks()}

        targets = _build_targets(users, existing_block_ids)
        log.info("Isolate: %d target(s) to block.", len(targets))

        blocked, failed = 0, 0
        total = len(targets)
        for i, u in enumerate(targets, 1):
            name = u.get("displayName", u["id"])
            _operation_status = f"Blocking {i}/{total}: {name}"
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

        _psycho_active = True
        _patrol_event.set()
        _save_state()

        if not targets:
            msg = "Isolate active. Everyone is allowlisted or already blocked. 0 new blocks."
        else:
            msg = f"Isolated. Blocked {blocked}/{total}. Verified {verified}/{len(_blocked_by_us)} on server."
            if failed:
                msg += f" {failed} failed."
        msg += f" Patrol active (~{int(PATROL_INTERVAL)}s). REJOIN the world for blocks to take visual effect."
        log.info(msg)
        return {"status": "ok", "blocked": blocked, "failed": failed, "verified": verified, "message": msg}
    finally:
        _operation_status = ""


def do_restore():
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


def do_snapshot_allowlist():
    """Set the allowlist to everyone currently in the instance (plus you)."""
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
    return {"status": "ok", "count": len(_allowlist),
            "message": f"Allowlisted all {len(_allowlist)} current occupant(s) (including you)."}


def do_save_allowlist(params):
    """Replace the allowlist. Accepts params {allowlist:[{id,name}]} or {ids:[...]}."""
    entries = []
    if isinstance(params, dict):
        if isinstance(params.get("allowlist"), list):
            for e in params["allowlist"]:
                if isinstance(e, dict) and e.get("id"):
                    entries.append((e["id"], e.get("name") or e["id"]))
        elif isinstance(params.get("ids"), list):
            name_map = {u["id"]: u.get("displayName", u["id"]) for u in _instance_users}
            for uid in params["ids"]:
                entries.append((uid, name_map.get(uid, uid)))

    my_id = (_current_user or {}).get("id", "")
    my_name = (_current_user or {}).get("displayName", my_id)
    ids = {uid for uid, _ in entries}
    if my_id:
        ids.add(my_id)

    _allowlist.clear()
    _allowlist_names.clear()
    _allowlist.update(ids)
    for uid, name in entries:
        _allowlist_names[uid] = name
    if my_id:
        _allowlist_names[my_id] = my_name
    _save_state()
    log.info("Allowlist saved: %d user(s).", len(_allowlist))
    return {"status": "ok", "count": len(_allowlist),
            "message": f"Allowlist saved: {len(_allowlist)} user(s) (you are always included)."}


# ---------------------------------------------------------------------------
# Patrol thread — auto-blocks newcomers while psycho mode is active
# ---------------------------------------------------------------------------

def _patrol_loop():
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
                    continue

                _refresh_log_cache()
                current_parsed = _log_cache[0] if _log_cache else None
                if current_parsed and current_parsed != saved_loc:
                    log.warning("[patrol] World changed. Pausing patrol — re-isolate in the new world.")
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
                    continue

                log.info("[patrol] %d newcomer(s) detected, blocking...", len(targets))
                for u in targets:
                    name = u.get("displayName", u["id"])
                    if block_user(u["id"]):
                        _blocked_by_us[u["id"]] = name
                        _save_state()


# ---------------------------------------------------------------------------
# OSC listener — maps avatar parameter to isolate / restore
# ---------------------------------------------------------------------------

def start_osc_listener():
    try:
        from pythonosc.dispatcher import Dispatcher
        from pythonosc.osc_server import ThreadingOSCUDPServer
    except ImportError:
        log.warning("python-osc not installed — OSC listener disabled.")
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

    try:
        server = ThreadingOSCUDPServer((OSC_LISTEN_IP, OSC_LISTEN_PORT), dispatcher)
    except OSError as exc:
        log.warning("Could not start OSC listener (%s). Continuing without it.", exc)
        return
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log.info("OSC listener on %s:%d for %s", OSC_LISTEN_IP, OSC_LISTEN_PORT, OSC_PARAM_NAME)


# ---------------------------------------------------------------------------
# Portal poll loop — replaces the old local Flask UI
# ---------------------------------------------------------------------------

_poll_url = PORTAL_BASE_URL.rstrip("/") + "/vrchat/agent/poll"
_poll_session = requests.Session()
_poll_session.headers.update({
    "Authorization": f"Bearer {AGENT_TOKEN}",
    "Content-Type": "application/json",
})

_results = []
_results_lock = threading.Lock()
_inflight = set()
_done_ids = set()
_cmd_queue = collections.deque()
_cmd_event = threading.Event()


def _build_status():
    my_id = (_current_user or {}).get("id", "")
    my_name = (_current_user or {}).get("displayName", "")
    loc = None
    if _last_known_location:
        loc = f"{_last_known_location[0]}:{_last_known_location[1]}"
    return {
        "psycho_active": _psycho_active,
        "operation": _operation_status,
        "session_expired": _session_expired,
        "my_id": my_id,
        "my_name": my_name,
        "location": loc,
        "patrol_interval": int(PATROL_INTERVAL),
        "agent_version": APP_VERSION,
        "blocked_count": len(_blocked_by_us),
        "blocked": [{"id": uid, "name": name} for uid, name in sorted(_blocked_by_us.items(), key=lambda x: x[1].lower())],
        "allowlist_count": len(_allowlist),
        "allowlist": [{"id": uid, "name": _allowlist_names.get(uid, uid)} for uid in sorted(_allowlist)],
        "users": [{"id": u["id"], "displayName": u.get("displayName", u["id"])} for u in _instance_users],
    }


def _run_command(cmd):
    kind = cmd.get("kind")
    params = cmd.get("params") or {}
    try:
        if kind == "isolate":
            with _lock:
                return do_isolate()
        if kind == "restore":
            with _lock:
                return do_restore()
        if kind == "snapshot":
            with _lock:
                return do_snapshot_allowlist()
        if kind == "save_allowlist":
            with _lock:
                return do_save_allowlist(params)
        if kind == "refresh":
            with _lock:
                users = refresh_instance()
            return {"status": "ok", "count": len(users), "message": f"Refreshed: {len(users)} occupant(s)."}
        return {"status": "error", "message": f"Unknown command: {kind}"}
    except Exception as exc:  # noqa: BLE001
        log.exception("Command %s failed", kind)
        return {"status": "error", "message": str(exc)}


def _command_worker():
    while True:
        _cmd_event.wait()
        while _cmd_queue:
            cmd = _cmd_queue.popleft()
            cmd_id = cmd.get("id")
            result = _run_command(cmd)
            ok = result.get("status") == "ok"
            with _results_lock:
                _results.append({
                    "id": cmd_id,
                    "ok": ok,
                    "message": result.get("message", ""),
                    "result": result,
                })
                _inflight.discard(cmd_id)
                _done_ids.add(cmd_id)
        _cmd_event.clear()


def poll_loop():
    log.info("Connecting to portal control panel at %s", _poll_url)
    backoff = POLL_INTERVAL
    while True:
        with _results_lock:
            to_report = list(_results)
        payload = {"status": _build_status(), "results": to_report}
        try:
            resp = _poll_session.post(_poll_url, data=json.dumps(payload), timeout=20)
        except requests.RequestException as exc:
            log.warning("Poll failed (%s). Retrying in %.0fs.", exc, backoff)
            time.sleep(backoff)
            backoff = min(backoff * 1.5, 30.0)
            continue

        if resp.status_code == 401:
            log.error("Portal rejected our token (401). This agent has been revoked — "
                      "download a fresh agent from the portal.")
            time.sleep(30)
            continue
        if resp.status_code != 200:
            log.warning("Poll got %d. Retrying.", resp.status_code)
            time.sleep(backoff)
            backoff = min(backoff * 1.5, 30.0)
            continue

        backoff = POLL_INTERVAL

        # Successfully reported — drop those results and forget their ids.
        if to_report:
            reported_ids = {r["id"] for r in to_report}
            with _results_lock:
                _results[:] = [r for r in _results if r["id"] not in reported_ids]
                _done_ids.difference_update(reported_ids)

        try:
            body = resp.json()
        except ValueError:
            body = {}
        commands = body.get("commands") or []
        new_cmds = 0
        for cmd in commands:
            cmd_id = cmd.get("id")
            if cmd_id is None or cmd_id in _inflight or cmd_id in _done_ids:
                continue
            _inflight.add(cmd_id)
            _cmd_queue.append(cmd)
            new_cmds += 1
        if new_cmds:
            log.info("Received %d new command(s).", new_cmds)
            _cmd_event.set()

        time.sleep(POLL_INTERVAL)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not PORTAL_BASE_URL or "AGENT_BASE_URL" in PORTAL_BASE_URL or "AGENT_TOKEN" in AGENT_TOKEN:
        print("ERROR: This agent file was not personalized. Re-download it from the portal.")
        sys.exit(1)

    while not login_from_vrcx():
        log.error("Could not authenticate via VRCX. Retrying in 30s — make sure VRCX is open and logged in.")
        time.sleep(30)

    _load_state()
    if _blocked_by_us:
        log.info("=== %d block(s) from a previous session still active. Use Restore to clear them. ===", len(_blocked_by_us))

    threading.Thread(target=_patrol_loop, daemon=True).start()
    threading.Thread(target=_command_worker, daemon=True).start()
    start_osc_listener()

    log.info("Agent ready. Keep this window open while you play. Control it from the portal.")
    try:
        poll_loop()
    except KeyboardInterrupt:
        log.info("Shutting down.")


if __name__ == "__main__":
    main()
`;

export const AGENT_README: string = String.raw`Night City RP — VRChat CyberPsycho Agent
=========================================

WHAT THIS IS
  A small program that runs on YOUR PC and acts on YOUR VRChat account. The
  portal is the control panel; this agent does the work. It reads your VRChat
  session from VRCX, and when you press Isolate/Restore in the portal it
  blocks/unblocks everyone in your current instance who isn't on your allowlist.

  Nothing about your VRChat login is sent to the portal. The portal only sends
  commands and shows status. The agent file you downloaded contains a private
  token unique to you — don't share it.

REQUIREMENTS
  1. Python 3.9+ installed (https://www.python.org/downloads/ — on Windows,
     tick "Add Python to PATH" during install).
  2. VRCX installed and logged in to your VRChat account.

HOW TO RUN
  Windows:  double-click psychosis_agent.py  (or: right-click > Open with > Python)
            If double-click doesn't work, open a terminal in this folder and run:
              python psychosis_agent.py
  macOS/Linux:
              python3 psychosis_agent.py

  On first launch it installs two small dependencies automatically, reads your
  VRCX session, then connects to the portal. Leave the window open while you
  play. Go to the portal's CyberPsycho page to control it.

NOTES
  - API blocks are server-side: people already loaded in your instance won't
    visually disappear until you REJOIN the world.
  - If you ever think your token leaked, hit "Revoke & re-download" on the portal
    page — the old file stops working immediately.
`;

// Windows launcher — double-click convenience so staff never touch a terminal.
export const RUN_AGENT_BAT: string = "@echo off\r\ncd /d \"%~dp0\"\r\npython psychosis_agent.py\r\npause\r\n";

// macOS / Linux launcher.
export const RUN_AGENT_SH: string = String.raw`#!/usr/bin/env bash
cd "$(dirname "$0")"
python3 psychosis_agent.py
`;

// Bake the per-staffer portal base URL + token into the agent script.
export function buildAgentScript(baseUrl: string, token: string): string {
  return AGENT_PY.replace(BASE_URL_PLACEHOLDER, baseUrl).replace(TOKEN_PLACEHOLDER, token);
}

export type AgentBundleFile = { name: string; data: Buffer };

// The full set of files a staffer downloads: personalized agent + launchers +
// README. Returned as in-memory buffers ready to zip.
export function buildAgentBundle(baseUrl: string, token: string): AgentBundleFile[] {
  return [
    { name: "psychosis_agent.py", data: Buffer.from(buildAgentScript(baseUrl, token), "utf-8") },
    { name: "run_agent.bat", data: Buffer.from(RUN_AGENT_BAT, "utf-8") },
    { name: "run_agent.sh", data: Buffer.from(RUN_AGENT_SH, "utf-8") },
    { name: "README.txt", data: Buffer.from(AGENT_README, "utf-8") },
  ];
}
