import argparse
import base64
import ctypes
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tarfile
import tempfile

CHUNK = 1024 * 1024


def publish(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(destination))


def safe_member(member, destination):
    if PurePosixPath(member.name).is_absolute():
        raise ValueError("Directory transfers reject absolute paths: " + member.name)
    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
        raise ValueError("Directory transfers reject special files: " + member.name)
    filtered = tarfile.data_filter(member, destination)
    if filtered is None:
        raise ValueError("Directory transfer member was rejected: " + member.name)
    return filtered


def pack_directory(source, stream):
    root = Path(source)
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError("Recursive transfer source must be a real directory")
    root = root.resolve(strict=True)
    seen = {}
    with tarfile.open(fileobj=stream, mode="w|", format=tarfile.PAX_FORMAT) as archive:
        def add(parent, entry, name):
            descriptor = os.open(entry, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent)
            try:
                info = os.fstat(descriptor)
                identity = (info.st_dev, info.st_ino)
                if stat.S_ISREG(info.st_mode) and info.st_nlink > 1 and identity in seen:
                    member = tarfile.TarInfo(name)
                    member.type = tarfile.LNKTYPE
                    member.mode = stat.S_IMODE(info.st_mode)
                    member.linkname = seen[identity]
                    archive.addfile(member)
                elif stat.S_ISLNK(info.st_mode):
                    member = tarfile.TarInfo(name)
                    member.type = tarfile.SYMTYPE
                    member.linkname = os.readlink("", dir_fd=descriptor)
                    safe_member(member, root)
                    archive.addfile(member)
                elif stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode):
                    opened = type("Pinned", (), {"name": name, "fileno": lambda self: descriptor})()
                    member = archive.gettarinfo(arcname=name, fileobj=opened)
                    safe_member(member, root)
                    if member.isfile():
                        seen[identity] = name
                        with open(f"/proc/self/fd/{descriptor}", "rb") as content:
                            archive.addfile(member, content)
                    else:
                        archive.addfile(member)
                    if member.isdir():
                        directory = os.open(".", os.O_RDONLY | os.O_DIRECTORY, dir_fd=descriptor)
                        try:
                            for child in sorted(os.listdir(directory)):
                                add(directory, child, name + "/" + child)
                        finally:
                            os.close(directory)
                else:
                    raise ValueError("Directory transfers reject special files: " + name)
            finally:
                os.close(descriptor)
        add(None, root, ".")


class TransferReader:
    def __init__(self, stream):
        self.stream = stream
        self.bytes_read = 0

    def read(self, size=-1):
        chunk = self.stream.read(size)
        self.bytes_read += len(chunk)
        return chunk


class ChunkReader:
    def __init__(self, directory, count):
        self.directory = Path(directory)
        self.count = count
        self.index = 0
        self.current = None
        self.bytes_read = 0

    def read(self, size):
        if size < 0:
            raise ValueError("Archive reads must have a bounded size")
        remaining = size
        pieces = []
        while remaining:
            if self.current is None:
                if self.index >= self.count:
                    break
                self.current = (self.directory / str(self.index)).open("rb")
                self.index += 1
            block = self.current.read(remaining)
            if block:
                pieces.append(block)
                remaining -= len(block)
            else:
                self.current.close()
                self.current = None
        chunk = b"".join(pieces)
        self.bytes_read += len(chunk)
        return chunk

    def close(self):
        if self.current is not None:
            self.current.close()


def unpack_directory(stream, destination, expected_size=None):
    destination = Path(destination)
    if not destination.is_absolute() or not destination.name or ".." in destination.parts:
        raise ValueError("Expected an absolute destination without ..")
    destination = destination.parent.resolve(strict=True) / destination.name
    if os.path.lexists(destination):
        raise FileExistsError("Recursive destination already exists: " + str(destination))
    staged = Path(tempfile.mkdtemp(dir=destination.parent, prefix=".workssh-tree-"))
    try:
        reader = stream if isinstance(stream, (TransferReader, ChunkReader)) else TransferReader(stream)
        with tarfile.open(fileobj=reader, mode="r|") as archive:
            archive.extractall(staged, filter=safe_member)
        while reader.read(CHUNK):
            pass
        if expected_size is not None and reader.bytes_read != expected_size:
            raise ValueError("Directory archive size mismatch; transfer did not complete")
        publish(staged, destination)
    finally:
        if staged.exists():
            shutil.rmtree(staged)


def usage():
    group = Path('/sys/fs/cgroup')
    disk = shutil.disk_usage('/workspace')
    def number(path):
        try:
            value = path.read_text().strip()
            return None if value == 'max' else int(value)
        except (OSError, ValueError):
            return None
    try:
        quota_text, period_text = (group / 'cpu.max').read_text().split()
        quota = None if quota_text == 'max' else int(quota_text)
        period = int(period_text)
    except (OSError, ValueError):
        quota = period = None
    try:
        cpu_time = dict(line.split() for line in (group / 'cpu.stat').read_text().splitlines())
    except OSError:
        cpu_time = {}
    identity = os.uname()
    return {
        'hostname': identity.nodename,
        'architecture': identity.machine,
        'memoryCurrentBytes': number(group / 'memory.current'),
        'memoryLimitBytes': number(group / 'memory.max'),
        'cpuQuota': quota,
        'cpuPeriod': period,
        'cpuTime': cpu_time,
        'filesystemUsedBytes': disk.used,
        'filesystemAvailableBytes': disk.free,
        'filesystemTotalBytes': disk.total,
        'filesystemScope': 'observed /workspace filesystem; not reserved',
    }


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='operation', required=True)
    pack = sub.add_parser('pack'); pack.add_argument('source')
    unpack = sub.add_parser('unpack'); unpack.add_argument('destination')
    prepare = sub.add_parser('prepare'); prepare.add_argument('directory')
    packed = sub.add_parser('pack-file'); packed.add_argument('source'); packed.add_argument('archive')
    chunk = sub.add_parser('read-chunk'); chunk.add_argument('archive'); chunk.add_argument('offset', type=int)
    chunks = sub.add_parser('unpack-chunks'); chunks.add_argument('destination'); chunks.add_argument('directory'); chunks.add_argument('count', type=int); chunks.add_argument('size', type=int)
    sub.add_parser('usage')
    args = parser.parse_args()
    if args.operation == 'pack':
        pack_directory(args.source, sys.stdout.buffer)
    elif args.operation == 'unpack':
        unpack_directory(sys.stdin.buffer, args.destination)
    elif args.operation == 'unpack-chunks':
        reader = ChunkReader(args.directory, args.count)
        try:
            unpack_directory(reader, args.destination, args.size)
        finally:
            reader.close()
    elif args.operation == 'prepare':
        os.mkdir(args.directory, mode=0o700)
    elif args.operation == 'pack-file':
        fd = os.open(args.archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as output:
            pack_directory(args.source, output)
    elif args.operation == 'read-chunk':
        if args.offset < 0:
            raise ValueError('Invalid archive offset')
        with open(args.archive, 'rb') as stream:
            stream.seek(args.offset)
            print(base64.b64encode(stream.read(CHUNK)).decode('ascii'))
    else:
        print(json.dumps(usage(), separators=(',', ':')))


if __name__ == "__main__":
    main()
