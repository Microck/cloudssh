import base64
import json
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

MAX_REQUEST = 64 * 1024 * 1024
MAX_FILE = 32 * 1024 * 1024


def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def require_path(path):
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        raise ValueError("expected an absolute POSIX path without NUL")
    return path


def file_info(path):
    item = os.lstat(require_path(path))
    if stat.S_ISLNK(item.st_mode):
        kind = "symlink"
    elif stat.S_ISDIR(item.st_mode):
        kind = "directory"
    elif stat.S_ISREG(item.st_mode):
        kind = "file"
    else:
        raise ValueError("special files are not supported")
    return {"path": path, "type": kind, "size": item.st_size, "modifiedAt": int(item.st_mtime * 1000)}


def file_operation(request):
    op = request["op"]
    path = require_path(request["path"])
    if op == "read":
        if file_info(path)["type"] == "directory":
            raise IsADirectoryError(path)
        with open(path, "rb") as stream:
            data = stream.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise ValueError("file exceeds 32 MiB transfer limit")
        send({"ok": True, "data": base64.b64encode(data).decode("ascii")})
    elif op == "write":
        data = base64.b64decode(request["data"], validate=True)
        if len(data) > MAX_FILE:
            raise ValueError("file exceeds 32 MiB transfer limit")
        fd, temporary = tempfile.mkstemp(prefix=".cloudssh-", dir=os.path.dirname(path))
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                if request.get("mode") is not None:
                    mode = request["mode"]
                    if not isinstance(mode, int) or mode < 0 or mode > 0o7777:
                        raise ValueError("invalid POSIX file mode")
                    os.fchmod(stream.fileno(), mode)
            os.replace(temporary, path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
        send({"ok": True})
    elif op == "list":
        send({"ok": True, "items": [file_info(os.path.join(path, name)) for name in sorted(os.listdir(path))]})
    elif op == "stat":
        send({"ok": True, "item": file_info(path)})
    elif op == "remove":
        if request["recursive"] and os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        elif os.path.isdir(path) and not os.path.islink(path):
            os.rmdir(path)
        else:
            os.unlink(path)
        send({"ok": True})
    elif op == "mkdir":
        os.makedirs(path, exist_ok=True)
        send({"ok": True})
    else:
        raise ValueError("unknown file operation")


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    # A dead orphan can remain a zombie until PID 1 reaps it. It cannot execute
    # or retain pipes; do not mistake that for a survivor and hang cancellation.
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            with open(entry.path + "/stat", encoding="utf-8") as stream:
                value = stream.read()
            fields = value[value.rfind(")") + 2:].split()
            if int(fields[2]) == pgid and fields[0] not in ("Z", "X"):
                return True
        except (FileNotFoundError, ProcessLookupError):
            continue
    return False


def terminate_group(pgid):
    for number, grace in ((signal.SIGTERM, 0.5), (signal.SIGKILL, 1.5)):
        try:
            os.killpg(pgid, number)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            if not group_alive(pgid):
                return
            time.sleep(0.02)
    if group_alive(pgid):
        raise RuntimeError("remote process-group termination was not confirmed")


def marker_paths(request):
    value = request["id"]
    if not isinstance(value, str) or len(value) != 32 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("invalid execution ID")
    directory = require_path(request["markerDir"])
    os.makedirs(directory, mode=0o700, exist_ok=True)
    base = os.path.join(directory, value)
    return base + ".pid", base + ".cancel", base + ".done"


class Interrupted(BaseException):
    pass


def interrupt(_number, _frame):
    raise Interrupted()


def run_exec(request):
    marker, cancelled, done = marker_paths(request)
    if os.path.exists(cancelled):
        with open(done, "w", encoding="ascii") as stream:
            stream.write("done")
        send({"type": "done", "exitCode": None, "timedOut": False})
        return
    child = None
    selector = selectors.DefaultSelector()
    timed_out = False
    result = None
    cancellation_signals = {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
    for number in cancellation_signals:
        signal.signal(number, interrupt)
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, cancellation_signals)
    try:
        # Publish the child under a protected parent transition. The single-threaded
        # child's pre-exec hook restores its mask so it never inherits blocked TERM.
        def child_signals():
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        try:
            child = subprocess.Popen(
                ["/bin/bash", "-lc", request["command"]], cwd=require_path(request["cwd"]),
                env={**os.environ, **request["env"]}, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True, preexec_fn=child_signals,
            )
            with open(marker, "w", encoding="ascii") as stream:
                stream.write(str(child.pid))
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        if os.path.exists(cancelled):
            terminate_group(child.pid)
        input_bytes = memoryview(base64.b64decode(request["stdin"], validate=True))
        offset = 0
        for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        os.set_blocking(child.stdin.fileno(), False)
        selector.register(child.stdin, selectors.EVENT_WRITE, "stdin")
        deadline = time.monotonic() + request["timeoutMs"] / 1000
        group_stopped = False
        while selector.get_map() or child.poll() is None:
            if time.monotonic() >= deadline and not group_stopped:
                timed_out = True
                terminate_group(child.pid)
                group_stopped = True
            if child.poll() is not None and not group_stopped:
                # A shell that exited can leave descendants holding its pipes open.
                terminate_group(child.pid)
                group_stopped = True
            for key, _ in selector.select(0.05):
                stream = key.fileobj
                if key.data == "stdin":
                    if offset == len(input_bytes):
                        selector.unregister(stream)
                        stream.close()
                    else:
                        try:
                            offset += os.write(stream.fileno(), input_bytes[offset:offset + 65536])
                        except BrokenPipeError:
                            selector.unregister(stream)
                            stream.close()
                else:
                    block = os.read(stream.fileno(), 65536)
                    if block:
                        send({"type": "chunk", "stream": key.data, "data": base64.b64encode(block).decode("ascii")})
                    else:
                        selector.unregister(stream)
                        stream.close()
        code = child.wait()
        result = None if timed_out or code < 0 else code
    finally:
        # A lost SSH channel may deliver another signal during cleanup. Cleanup
        # owns only this command's new process group, never the SSH server or VM.
        for number in cancellation_signals:
            signal.signal(number, signal.SIG_IGN)
        signal.pthread_sigmask(signal.SIG_UNBLOCK, cancellation_signals)
        try:
            if child is not None:
                terminate_group(child.pid)
                child.wait(timeout=2)
        finally:
            selector.close()
            if child is not None:
                for stream in (child.stdin, child.stdout, child.stderr):
                    if stream is not None and not stream.closed:
                        stream.close()
            with open(done, "w", encoding="ascii") as stream:
                stream.write("done")
            try:
                os.unlink(marker)
            except FileNotFoundError:
                pass
    send({"type": "done", "exitCode": result, "timedOut": timed_out})


def kill_operation(request):
    marker, cancelled, done = marker_paths(request)
    # A cancellation tombstone also covers the race before PID publication.
    with open(cancelled, "w", encoding="ascii") as stream:
        stream.write("cancel")
    deadline = time.monotonic() + 2.5
    while time.monotonic() < deadline:
        if os.path.exists(done):
            send({"ok": True})
            return
        try:
            with open(marker, encoding="ascii") as stream:
                content = stream.read().strip()
            if content:
                terminate_group(int(content))
                send({"ok": True})
                return
        except FileNotFoundError:
            pass
        time.sleep(0.02)
    raise RuntimeError("cancellation raced remote startup; termination is not confirmed")


def main():
    try:
        raw = sys.stdin.buffer.readline(MAX_REQUEST + 1)
        if not raw or len(raw) > MAX_REQUEST or not raw.endswith(b"\n"):
            raise ValueError("invalid request size")
        request = json.loads(raw)
        if request["op"] == "exec":
            run_exec(request)
        elif request["op"] == "kill":
            kill_operation(request)
        else:
            file_operation(request)
    except OSError as cause:
        send({"ok": False, "error": cause.strerror or str(cause), "errno": cause.errno})
    except (ValueError, KeyError) as cause:
        send({"ok": False, "error": str(cause), "errno": 22})
    except Interrupted:
        send({"ok": False, "error": "SSH channel was interrupted"})
    except Exception as cause:
        send({"ok": False, "error": str(cause)})


if __name__ == "__main__":
    main()
