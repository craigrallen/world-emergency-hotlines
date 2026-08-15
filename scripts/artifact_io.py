"""Strict path guards and race-resistant coordinated publication for artifacts."""
from __future__ import annotations

import os
import secrets
import stat
from pathlib import Path
from typing import Callable


def _identity(path: Path) -> tuple[int, int] | None:
    try:
        value = path.stat()
    except FileNotFoundError:
        return None
    return value.st_dev, value.st_ino


def guard_paths(inputs: list[Path], outputs: list[tuple[Path, str]], *, external_root: Path | None = None) -> None:
    resolved_inputs = [path.resolve(strict=True) for path in inputs]
    input_ids = {_identity(path) for path in inputs}
    resolved_outputs = [path.resolve(strict=False) for path, _ in outputs]
    if len(set(resolved_outputs)) != len(resolved_outputs):
        raise ValueError("outputs must not alias each other")
    if len({identity for identity in input_ids if identity is not None}) != len(inputs):
        raise ValueError("inputs must not alias each other")
    for (path, suffix), resolved in zip(outputs, resolved_outputs):
        if path.suffix.lower() != suffix:
            raise ValueError(f"output must end in {suffix}")
        if path.is_symlink() or resolved in resolved_inputs or _identity(path) in input_ids:
            raise ValueError("output must not alias an input")
        if path.exists():
            raise FileExistsError(f"output already exists: {path}")
        if external_root is not None:
            try:
                resolved.relative_to(external_root.resolve(strict=True))
            except ValueError:
                pass
            else:
                raise ValueError("output paths must be external to the repository")


def _open_parent(parent: Path) -> tuple[int, tuple[int, int]]:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(parent, flags)
    value = os.fstat(descriptor)
    if not stat.S_ISDIR(value.st_mode):
        os.close(descriptor)
        raise NotADirectoryError(str(parent))
    return descriptor, (value.st_dev, value.st_ino)


def _path_matches_parent(parent: Path, identity: tuple[int, int]) -> bool:
    try:
        value = parent.stat()
    except OSError:
        return False
    return not parent.is_symlink() and (value.st_dev, value.st_ino) == identity


def coordinated_write(payloads: list[tuple[Path, bytes]], *,
                      before_publish: Callable[[int, Path], None] | None = None,
                      external_root: Path | None = None) -> None:
    """Publish without replacement through pinned parent descriptors.

    Each destination is created atomically with a hard link to its fully fsynced
    staging inode. True multi-file atomicity is unavailable on supported filesystems;
    on failure, only destinations still identifying inodes created by this call are
    removed. A destination created by another process is never overwritten.
    """
    parents: dict[Path, tuple[int, tuple[int, int]]] = {}
    staged: list[tuple[Path, int, str, tuple[int, int]]] = []
    published: list[tuple[Path, int, tuple[int, int]]] = []
    try:
        for path, payload in payloads:
            path.parent.mkdir(parents=True, exist_ok=True)
            parent = path.parent.resolve(strict=True)
            if external_root is not None:
                try:
                    (parent / path.name).relative_to(external_root.resolve(strict=True))
                except ValueError:
                    pass
                else:
                    raise ValueError("output paths must be external to the repository")
            if parent not in parents:
                parents[parent] = _open_parent(parent)
            descriptor, identity = parents[parent]
            if not _path_matches_parent(path.parent, identity):
                raise OSError("output parent changed during publication")
            temporary = f".{path.name}.{secrets.token_hex(12)}.tmp"
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(temporary, flags, 0o600, dir_fd=descriptor)
            try:
                value = os.fstat(fd)
                staged.append((path, descriptor, temporary, (value.st_dev, value.st_ino)))
                with os.fdopen(fd, "wb", closefd=False) as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(fd)
            finally:
                os.close(fd)
        for index, (path, descriptor, temporary, inode) in enumerate(staged):
            if before_publish is not None:
                before_publish(index, path)
            parent_identity = next(identity for fd, identity in parents.values() if fd == descriptor)
            if not _path_matches_parent(path.parent, parent_identity):
                raise OSError("output parent changed during publication")
            # link(2) is an atomic no-replace publication primitive on macOS/Linux.
            os.link(temporary, path.name, src_dir_fd=descriptor, dst_dir_fd=descriptor,
                    follow_symlinks=False)
            published.append((path, descriptor, inode))
            os.fsync(descriptor)
    except BaseException:
        for path, descriptor, inode in reversed(published):
            try:
                value = os.stat(path.name, dir_fd=descriptor, follow_symlinks=False)
                if (value.st_dev, value.st_ino) == inode:
                    os.unlink(path.name, dir_fd=descriptor)
            except FileNotFoundError:
                pass
        raise
    finally:
        for _, descriptor, temporary, _ in staged:
            try:
                os.unlink(temporary, dir_fd=descriptor)
            except FileNotFoundError:
                pass
        for descriptor, _ in parents.values():
            os.close(descriptor)
