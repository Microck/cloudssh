import base64
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

LIMIT = 1024 * 1024
JOB_ID = re.compile(r"^rfcmd-[a-f0-9]{32}$")
BOX_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*:[a-f0-9]{32}$")
TERMINAL = {"completed", "cancelled", "interrupted", "failed"}
PUBLIC = ("job", "box", "state", "exitCode", "startedAt", "finishedAt", "droppedBytes", "error")


def private_directory(path, create=False):
    if create:
        os.makedirs(path, mode=0o700, exist_ok=True)
    item = os.lstat(path)
    if not stat.S_ISDIR(item.st_mode) or stat.S_IMODE(item.st_mode) != 0o700 or item.st_uid != os.geteuid():
        raise ValueError("job directory is not private and owned")


def load(path):
    item = os.lstat(path)
    if not stat.S_ISREG(item.st_mode) or stat.S_IMODE(item.st_mode) != 0o600 or item.st_uid != os.geteuid():
        raise ValueError("job metadata is not private and owned")
    with open(path, encoding="utf8") as stream:
        return json.load(stream)


def save(path, value):
    temporary = path + ".tmp-" + str(os.getpid())
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def identity(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="utf8") as stream:
            value = stream.read()
        fields = value[value.rfind(")") + 2:].split()
        return fields[0], int(fields[2]), fields[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    for entry in os.scandir("/proc"):
        if entry.name.isdigit():
            member = identity(int(entry.name))
            if member and member[1] == pgid and member[0] not in ("Z", "X"):
                return True
    return False


def terminate_group(pgid):
    for number, grace in ((signal.SIGTERM, 0.5), (signal.SIGKILL, 1.5)):
        try:
            os.killpg(pgid, number)
        except ProcessLookupError:
            return
        end = time.monotonic() + grace
        while time.monotonic() < end:
            if not group_alive(pgid):
                return
            time.sleep(0.02)
    if group_alive(pgid):
        raise RuntimeError("job process-group termination was not confirmed")


def worker(directory, state, argv, env, deadline):
    # This detached worker remains the command's parent, so wait() retains the
    # real exit status. A separate non-parent guardian cannot recover that status.
    path = os.path.join(directory, "result.json")
    cancelled = os.path.join(directory, "cancel")
    child = None
    selector = selectors.DefaultSelector()
    stopping = False
    def stop(_number, _frame):
        nonlocal stopping
        stopping = True
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(number, stop)
    state.update(workerPid=os.getpid(), workerStart=identity(os.getpid())[2])
    try:
        save(path, state)
        if os.path.exists(cancelled):
            state.update(state="cancelled")
            return
        child = subprocess.Popen(argv, cwd="/workspace", env={**os.environ, **env},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 start_new_session=True, close_fds=True)
        state.update(state="running", startedAt=int(time.time()))
        save(path, state)
        os.set_blocking(child.stdout.fileno(), False)
        selector.register(child.stdout, selectors.EVENT_READ)
        reason = None
        stopped = False
        kept = 0
        dirty = False
        last_save = time.monotonic()
        with open(os.path.join(directory, "output"), "wb", buffering=0) as output:
            while selector.get_map() or child.poll() is None:
                if not stopped and (stopping or os.path.exists(cancelled) or time.time() >= deadline):
                    reason = "cancelled" if stopping or os.path.exists(cancelled) else "failed"
                    if reason == "failed":
                        state["error"] = "Job deadline exceeded"
                    terminate_group(child.pid)
                    stopped = True
                if child.poll() is not None and not stopped:
                    # Descendants can retain the output pipe after their shell exits.
                    terminate_group(child.pid)
                    stopped = True
                for key, _ in selector.select(0.05):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                        continue
                    retained = block[:max(0, LIMIT - kept)]
                    if retained:
                        output.write(retained)
                        kept += len(retained)
                    state["droppedBytes"] += len(block) - len(retained)
                    dirty = True
                if dirty and time.monotonic() - last_save >= 0.25:
                    save(path, state)
                    last_save = time.monotonic()
                    dirty = False
            code = child.wait()
            terminate_group(child.pid)
            os.fsync(output.fileno())
        state.update(state=reason or "completed", exitCode=None if reason else (code if code >= 0 else 128 - code))
    except BaseException as cause:
        state.update(state="failed", exitCode=None, error=str(cause))
    finally:
        if child is not None:
            try:
                terminate_group(child.pid)
                child.wait(timeout=2)
            except BaseException as cause:
                state.update(state="interrupted", exitCode=None, error=str(cause))
            child.stdout.close()
        selector.close()
        state["finishedAt"] = int(time.time())
        save(path, state)


def snapshot(directory, job, box):
    path = os.path.join(directory, "result.json")
    state = load(path)
    if state.get("job") != job or state.get("box") != box:
        raise ValueError("job identity mismatch")
    if state["state"] not in TERMINAL:
        member = identity(state["workerPid"]) if state.get("workerPid") else None
        if not member or member[0] in ("Z", "X") or member[2] != state.get("workerStart"):
            state.update(state="interrupted", exitCode=None, finishedAt=int(time.time()), error="Guest worker disappeared; command outcome is unknown")
            save(path, state)
    with open(os.path.join(directory, "output"), "rb") as stream:
        output = stream.read(LIMIT + 1)
    if len(output) > LIMIT:
        raise ValueError("job log exceeds retention bound")
    return {"ok": True, "status": {key: state[key] for key in PUBLIC if key in state}, "output": base64.b64encode(output).decode("ascii")}


def main():
    request = json.load(sys.stdin)
    job, box, operation = request["job"], request["box"], request["op"]
    if not JOB_ID.fullmatch(job) or not BOX_ID.fullmatch(box):
        raise ValueError("invalid job or box identity")
    scratch = request["scratch"]
    if not isinstance(scratch, str) or not scratch.startswith("/") or "\0" in scratch:
        raise ValueError("invalid scratch directory")
    root = os.path.join(scratch, ".cloudssh-jobs")
    private_directory(root, create=operation == "start")
    directory = os.path.join(root, job)
    if operation == "start":
        argv, env, deadline = request["argv"], request["env"], request["deadline"]
        if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) or "\0" in arg for arg in argv):
            raise ValueError("invalid job argv")
        if not isinstance(env, dict) or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or not isinstance(value, str) or "\0" in value for key, value in env.items()):
            raise ValueError("invalid environment")
        if not isinstance(deadline, (int, float)) or deadline <= time.time() or deadline > time.time() + 7200:
            raise ValueError("invalid or expired job deadline")
        os.mkdir(directory, mode=0o700)
        state = {"job": job, "box": box, "state": "starting", "exitCode": None, "startedAt": None, "finishedAt": None, "droppedBytes": 0}
        save(os.path.join(directory, "result.json"), state)
        fd = os.open(os.path.join(directory, "output"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        pid = os.fork()
        if pid == 0:
            try:
                os.setsid()
                null = os.open(os.devnull, os.O_RDWR)
                for descriptor in (0, 1, 2):
                    os.dup2(null, descriptor)
                if null > 2:
                    os.close(null)
                worker(directory, state, argv, env, deadline)
            finally:
                os._exit(0)
        # Wait for the protected worker identity/start transition before acknowledging.
        end = time.monotonic() + 3
        while time.monotonic() < end:
            state = load(os.path.join(directory, "result.json"))
            if state["state"] != "starting":
                print(json.dumps(snapshot(directory, job, box), separators=(",", ":")))
                return
            time.sleep(0.02)
        raise RuntimeError("job startup was not confirmed; inspect the retained ID")
    private_directory(directory)
    if operation == "cancel":
        current = snapshot(directory, job, box)
        if current["status"]["state"] not in TERMINAL:
            fd = os.open(os.path.join(directory, "cancel"), os.O_WRONLY | os.O_CREAT, 0o600)
            os.close(fd)
            end = time.monotonic() + 4
            while time.monotonic() < end:
                current = snapshot(directory, job, box)
                if current["status"]["state"] in TERMINAL:
                    break
                time.sleep(0.02)
            if current["status"]["state"] not in ("completed", "cancelled", "failed"):
                raise RuntimeError("job cancellation was not confirmed")
    elif operation != "status":
        raise ValueError("unknown jobs operation")
    print(json.dumps(snapshot(directory, job, box), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as cause:
        print(json.dumps({"ok": False, "error": str(cause)}, separators=(",", ":")))
        sys.exit(1)
